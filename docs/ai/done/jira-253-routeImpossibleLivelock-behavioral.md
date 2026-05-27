# JIRA-253 — A3 `a3_abandon_for_carry_deliver_partial` kills any high-value route whose first-leg build exceeds the 20M/turn cap (behavioral)

In game `6033c903-7ab8-40e8-b073-acd82e2e3c9e`, player Sonnet at T8 is given a top-1 `[deterministic-top-1]` route:

```
pickup(Steel@Ruhr) → pickup(Copper@Wroclaw) → deliver(Steel@Torino) → deliver(Copper@Torino)
Picked: pair-shared-delivery — payout 40M, build 21M, 8 turns, NET 19M
```

Bot is at Antwerpen, carrying Steel (matched to `Steel→Torino` carried-deliver demand), with $30M cash. Existing network reaches Frankfurt; Frankfurt → Wroclaw is **21M** via Dijkstra over the terrain map. So the first-leg build (Frankfurt → Wroclaw, for the Copper pickup) needs 21M total — slightly more than the **20M/turn Phase B build cap**.

This is a normal multi-turn build: ~14M-20M would build this turn, the rest next turn. The bot has plenty of cash; the route is profitable; the plan is good.

Instead, the bot **livelocks** at Antwerpen:
- T8 PassTurn
- T9 PassTurn
- T10 UpgradeTrain (the route's `upgradeOnRoute` payload to Superfreight fires anyway, draining cash from $30M to $10M)
- T11+ further PassTurns

`composition.a3.terminationReason = 'a3_abandon_for_carry_deliver_partial'` at every turn. The route is never executed.

Root cause: `MovementPhasePlanner.ts:530-537` abandons the active route when **both**:
1. `computeBuildSegments` returns a non-empty path that doesn't reach the target city this turn (i.e. the build is **partial** — needs more than one turn to complete), AND
2. `hasCarriedDeliverableOnNetwork(context)` is true (any demand `d` with `d.isLoadOnTrain && d.isDeliveryOnNetwork`).

Both conditions hold at T8. But condition 1 is just **normal multi-turn building** — any build that exceeds 20M (Phase B's per-turn cap) returns a partial path. And condition 2 holds **whenever the bot is carrying any matched-on-network load**, which is many turns of normal play.

The original intent of this code path (per the inline comment): "abandon so the next turn produces a carry-deliver plan instead of committing budget to a partial route" — i.e. prefer cashing the carried load over an expensive build. But the implementation conflates "the build doesn't fit in 20M this turn" (normal) with "the build will never reach the target" (pathologically partial). It treats every multi-turn build the same way.

The user's framing of the symptom: *"partial build to Wroclaw kills the high value route for no fucking reason"*. Exactly right — the route has the highest NET in the candidate set (19M vs ~16M for carry-only), and the bot has the cash to execute it.

## Source

`logs/game-6033c903-7ab8-40e8-b073-acd82e2e3c9e.ndjson`, player Sonnet, T8 onward. Defect locus confirmed at `src/server/services/ai/MovementPhasePlanner.ts:530-537`.

## Observed trace (Sonnet T7–T11)

| Turn | action | cash | route active? | a3.terminationReason | composition.build.cost | composition.outputPlan |
|------|--------|------|---------------|----------------------|------------------------|------------------------|
| T7   | MoveTrain | 30M | (previous completed) | — | — | — |
| T8   | **PassTurn** | 30M | 4-stop pair-shared route | **`a3_abandon_for_carry_deliver_partial`** | 0 | `["PassTurn"]` |
| T9   | **PassTurn** | 30M | (same) | (same) | 0 | `["PassTurn"]` |
| T10  | UpgradeTrain | **10M** (-20M from upgrade) | (same) | (same) | 0 | `["PassTurn"]` (upgradeOnRoute fired) |
| T11+ | PassTurn (continuing) | 10M | (same) | (same) | 0 | `["PassTurn"]` |

Note `composition.build.cost: 0` on every turn — the bot is **not even spending the 20M of build budget it has available**. Phase B never composes the partial build because A3 aborted first.

## Verification — the cost figures match

Dijkstra over `configuration/gridPoints.json` + `configuration/waterCrossings.json`:
- Frankfurt (29, 44) → Wroclaw (29, 57): **21 M** ← exactly the planner's `trackCostToSupply` for Copper@Wroclaw
- Ruhr center (25, 41) → Wroclaw (29, 57): 29 M (longer; planner uses Frankfurt as the network frontier)
- Ruhr center (25, 41) → Frankfurt (29, 44): 12 M

So the planner's math is right. The bot's network reaches Frankfurt. The build to Wroclaw is 21M — one turn at full Phase B budget (20M) gets ~95% of the way there, the rest finishes next turn. This is a 8-turn plan; the planner expected it would take this long; cash supports it.

## Expected behavior

When A3 previews a partial build path (i.e., `computeBuildSegments` returns segments but doesn't reach the target this turn), the executor should distinguish:

- **Normal multi-turn build** — the partial path is the bot making 20M of build progress this turn toward a target that needs more than 20M total. Phase B should compose those segments and emit a `BuildTrack` action. Next turn the bot continues building toward the same target.
- **Pathologically partial build** — the path stops short for a structural reason (e.g. saturated city blocking the only approach, water obstacle requiring ferry the bot can't use, etc.) AND the bot has a strictly better alternative (carry-deliverable on existing network).

Only the second case justifies abandoning. The first case is just multi-turn building, which is the bot's normal operating mode.

What must NOT happen:
- A route the planner ranked as top-1 (highest aggregate NET) gets abandoned every turn because its first-leg build needs > 20M.
- `composition.build.cost: 0` on a turn where the bot has cash + a build target + 20M of Phase B budget.
- `upgradeOnRoute` fires while the route is being abandoned.

## Acceptance

- **AC1 — Normal multi-turn build is NOT abandoned.** Fixture: bot at Antwerpen, $30M cash, route requires 21M build to next pickup, carries a load whose delivery is reportedly on-network. Assert: A3 does NOT set `a3_abandon_for_carry_deliver_partial`. Phase B composes a BuildTrack action spending ~20M toward the build target. Next turn the bot continues.
- **AC2 — Pathological partial IS abandoned.** Fixture: same as AC1 but the build target is structurally unreachable (e.g. would require crossing a saturated city, or only path is through a ferry the bot can't pay). Assert: A3 sets `a3_abandon_for_carry_deliver_partial` and the bot pivots to the carry-delivery on next replan.
- **AC3 — Build progress is observable.** Fixture: AC1's scenario. Assert: `composition.build.cost > 0`, `composition.build.target` is set, `segmentsBuilt > 0` on T8. The bot is not stuck on `composition.build.cost: 0` across multiple turns.
- **AC4 — UpgradeOnRoute gate.** Fixture: AC1 but with `upgradeOnRoute = 'Superfreight'` on the route. Assert: upgrade does NOT fire if A3 abandoned the route this turn. (Otherwise the abandon-then-upgrade sequence drains cash on an abandoned plan.)
- **AC5 — Full-game regression.** Replay Sonnet's T8 snapshot from game `6033c903`. Assert: by T13 (5 turns later) the bot has either delivered Steel→Torino, or made measurable build progress toward Wroclaw, or has a new route. The bot is NOT still at Antwerpen with the same Steel+Copper Torino route active.

## Not in scope

- Tweaking JIRA-246's cash-floor removal — the spend-to-zero policy stays. This ticket is about WHEN to abandon, not what cash buffer to keep.
- Re-ranking the candidate scorer (carry-only vs pair-shared scoring tradeoffs). The planner's ranking is reasonable; the executor should execute the top pick, not abandon it.
- The unrelated demand-context inconsistency where `connectedMajorCities: ["Ruhr"]` but `trackCostToDelivery: 0` for Steel→Torino — that's a separate suspected bug (worth a follow-up JIRA if it reproduces), but is not the trigger here. Even with that inconsistency, the abandon predicate would still fire incorrectly; the predicate is the bug.

## Relationship to existing JIRAs

- **JIRA-246** introduced the carry-deliver abandon paths in A3 (lines 514, 530). The intent was correct (prefer free carry-delivery over building); the implementation conflates pathological partials with normal multi-turn builds.
- **JIRA-247** addressed a sibling A3 livelock (`origin_is_current_position`). Same family of bug: A3 sets a termination reason that causes the bot to PassTurn forever instead of making progress.
- **JIRA-248/250** (shipped on `fix/jira-248-249-250-carried-load-planner`) ensure carried-load deliveries get represented in the candidate set as a floor. Once those land, the carry-only candidate ranks just below the pair-shared candidate — but the planner picks pair-shared, and JIRA-253 is about not abandoning that pick.
- **JIRA-252** (post-delivery replan ordering) is the sibling: both involve the executor mishandling a turn in a way that wastes movement/build. 253 is about start-of-turn abandon; 252 is about post-delivery ordering.
