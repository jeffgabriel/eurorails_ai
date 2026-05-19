# JIRA-246 — `resolveBuildTarget` cash-floor gate ($5M reserve) strands carried deliverable load; remove the floor and abandon route when build is infeasible (behavioral)

In post-JIRA-244 game `eb20489f-0900-416f-94cf-72c9f383269a`, player s1 emitted **16 PassTurn actions out of 74 turns**, with a 15-turn consecutive livelock from T16 through T31. The trigger is structurally distinct from JIRA-244: this is not a ferry-partner-city case, and `citiesOnNetwork` is correctly populated.

At T16, s1 is at coord `(32, 45)` with $4M cash on a fast_freight train, **carrying a Wheat load whose matching demand card delivers at Berlin** — and Berlin is already on s1's network. The active route's current stop is **pickup Cattle at Bern** (Switzerland) — Bern is NOT on s1's network. Route order: pickup Cattle@Bern → deliver Wheat@Berlin → deliver Cattle@Berlin.

The planner calls `resolveBuildTarget(activeRoute, context)` to pick the A3 build target. The function reaches the **JIRA-165 Fix 2 "capital allocation" gate** at `src/server/services/ai/routeHelpers.ts:207-214` and returns `null` because:
- `context.money < 5` (s1 has $4M), AND
- A demand in hand has `isLoadOnTrain && isDeliveryOnNetwork` (Wheat → Berlin).

The intent in the comment is "skip building so the executor advances to the deliverable stop." But the executor cannot advance — A2 only consults the route's current stop (Bern, off-network), not later stops. A3 records `terminationReason = no_build_target`. PassTurn.

Replanner re-runs each turn. Same gate fires. Same PassTurn. Loop runs T16 → T31 (15 turns) until the unrelated `stuck-route-abandon` heuristic tears down the route. The bot then replans with a single-stop carry-deliver and delivers Wheat on T32 ($4M + payout).

## Two separate problems here

### Problem 1 — The cash-floor itself is wrong

The gate's `context.money < 5` check is a **cash reserve floor**. Bot policy in this repo (per longstanding feedback) is "spend to zero": never hold back capital "just in case." The $5M threshold violates that policy.

The gate's stated purpose — "prevent the bot spending its last cash on a multi-turn build it can't finish" — is **already enforced downstream**. `MovementPhasePlanner.ts:458` caps the A3 build budget at `snapshot.bot.money`:

```ts
const a3Budget = Math.min(TURN_BUILD_BUDGET - context.turnBuildCost, snapshot.bot.money);
```

`computeBuildSegments` only returns segments that fit in the budget. The bot cannot spend money it doesn't have. The cash-floor adds nothing except the bug being reported.

### Problem 2 — Even without the floor, A3 has no carry-deliver redirect

If we just remove the cash-floor: at T16 the planner returns `{ targetCity: 'Bern', ... }`. A3 calls `computeBuildSegments` with `budget = $4M`. The cheapest path to Bern from s1's position costs more than $4M (or far more), so:
- Either: zero segments fit → returns `[]` → A3 falls into the JIRA-244 Fix B `length === 0` branch → Bern is not on network → `terminationReason = 'build_dijkstra_failed'` → PassTurn.
- Or: a partial path's first 1-2 segments fit → A3 builds them, spends to $0, next turn same situation.

Both outcomes are bad. The bot has a carry-deliverable in hand (Wheat → Berlin, on-network); it should deliver, not loop on a build it can't afford and a route stop it can't reach.

A3 needs an "abandon route" fall-through: when the planned build cannot complete the connection to the route's current stop in this turn AND a carry-deliver-on-network demand exists, abandon the active route so the replanner produces a single-stop carry-deliver plan.

## Source

`logs/game-eb20489f-0900-416f-94cf-72c9f383269a.ndjson`. Player s1 turns T16-T31. Discovered 2026-05-19 verifying JIRA-244's residual effect.

## Observed trace (s1)

| Period | turns | BuildTrack | MoveTrain | PassTurn | Deliveries |
|---|---:|---:|---:|---:|---:|
| T1-T15 (productive) | 15 | 5 | 8 | 0 | 2 |
| **T16-T31 (cash-floor livelock)** | **16** | **0** | **0** | **15** | **0** |
| T32-T74 (post-abandon recovery) | 43 | varies | varies | 1 | 3 |

Per-turn at T16 through T31:
1. `a2.terminationReason = stop_city_not_on_network` (Bern off-network).
2. `a3.terminationReason = no_build_target` (cash-floor gate fires).
3. `build.target = null`, `outputPlan = ["PassTurn"]`.
4. Cash stays at $4M; train doesn't upgrade; no deliveries.

## Comparison to siblings (same game)

| | s1 | s2 | s3 |
|---|---:|---:|---:|
| Deliveries | 5 | 8 | 7 |
| PassTurns | **16** | 1 | 2 |
| Final cash | $188M | $259M | $175M |

s2/s3 did not hit this gate, presumably because their routes' current stops were on-network or they had >$5M cash when carrying deliverables. The bug is asymmetric — it only fires when (a) cash < $5M, (b) carrying a deliverable-on-network load, AND (c) the active route's current stop is off-network.

## Expected behavior

1. The cash-floor `context.money < 5` check is removed. The bot is allowed to spend down to $0.
2. When A3 cannot find a complete affordable build path to the route's current stop AND there exists a demand with `isLoadOnTrain && isDeliveryOnNetwork`, the active route is abandoned (`routeWasAbandoned = true`) and the executor returns to the planner. The replanner produces a single-stop carry-deliver route on the next turn.
3. When A3 cannot find a complete affordable build path AND no carry-deliverable exists, today's behavior holds (partial build or PassTurn, depending on whether any segments fit).

## Acceptance

- **AC1 — cash-floor removed**: Search the codebase for `context.money < 5` or any cash-threshold gate in `resolveBuildTarget`. Assert the comparison no longer exists.
- **AC2 — reconstruct T16 state**: Fixture matching s1's T16 (cash $4M, carrying Wheat, route stops = [pickup Cattle@Bern, deliver Wheat@Berlin, deliver Cattle@Berlin], Bern off-network, Berlin on-network). Assert: planner does NOT emit PassTurn. The route is abandoned and the replanner is invoked.
- **AC3 — full-game regression**: Replay s1's T16 snapshot for 5 turns. Assert: Wheat is delivered at Berlin within 3 turns, cash advances past $4M, no PassTurn in the window.
- **AC4 — sufficient-cash case unaffected**: Same setup but cash $50M. Build to Bern is affordable. Assert: A3 builds toward Bern as today (no abandon, no PassTurn).
- **AC5 — no carry-deliverable case unaffected**: Same setup, cash $4M, but no demand has `isLoadOnTrain && isDeliveryOnNetwork`. Assert: behavior matches today's path (partial build or PassTurn, whichever the natural affordability cap produces).
- **AC6 — high-cash carry-deliverable case unaffected**: Same setup with a carry-deliverable, but cash $50M and the build to the route's current stop is affordable in one turn. Assert: A3 builds normally; abandon does not fire.

## Not in scope

- The JIRA-247 `origin_is_current_position` failure mode (separate ticket).
- Restructuring A2's stop-iteration order — this fix uses the existing route-abandon path, not a stop-skip path.
- Generalizing carry-deliver preference to other phases (this fix only fires when A3 has already determined the build is infeasible).
- The route planner's decision to produce a route with an off-network pickup ahead of a carried deliverable in the first place (a separate planner-level concern; this fix recovers gracefully when it happens, but doesn't prevent it).
