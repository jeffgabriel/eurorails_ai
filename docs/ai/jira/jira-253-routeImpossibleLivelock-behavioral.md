# JIRA-253 — Deterministic planner selects a route A2 declares `route_impossible`, then bot livelocks instead of replanning (behavioral)

In game `6033c903-7ab8-40e8-b073-acd82e2e3c9e`, player Sonnet at T8 receives a fresh `[deterministic-top-1]` route:

```
pickup(Steel@Ruhr) → pickup(Copper@Wroclaw) → deliver(Steel@Torino) → deliver(Copper@Torino)
Picked: pair-shared-delivery — payout 40M, build 21M, 8 turns, NET 19M
```

The bot is at Antwerpen with $30M cash. Immediately on T8, the executor's Phase A2 declares `terminationReason = 'route_impossible'`. The bot emits PassTurn and ends the turn at Antwerpen.

The active route is **not** cleared, and no replan fires. T9 repeats: same route still active, A2 again returns `route_impossible`, another PassTurn.

At T10 the bot autonomously fires the route's `upgradeOnRoute` payload (Superfreight upgrade, $20M cost) — even though the route itself has been declared impossible for two consecutive turns. Cash drops to $10M, making the $21M total build genuinely unaffordable. The bot stays at Antwerpen, route still active, A2 still saying `route_impossible`, PassTurn cycle continues.

User's framing of the symptom: "Sonnet is stuck passing turns in Antwerpen even though it has been given a route. I think this route is not feasible with 10M cash b/c the build to Wroclaw is ~20M."

The user's hypothesis (build cost > cash) is **partly** right and **partly** wrong:
- **Wrong** about the initial trigger: A2 already declared the route impossible at $30M cash (T8), before any spending. So $30M is also somehow insufficient under whatever criterion A2 is applying.
- **Right** that the cash-vs-build problem is what locks the loop in place: after the T10 self-upgrade depletes cash to $10M, the route is genuinely unaffordable and the livelock is permanent until something external happens.

## Source

`logs/game-6033c903-7ab8-40e8-b073-acd82e2e3c9e.ndjson`, player Sonnet, T8 onward.

## Observed trace (Sonnet T7–T10)

| Turn | action | positionStart | positionEnd | cash | route len | composition.a2.terminationReason | composition.a3.terminationReason | composition.outputPlan |
|------|--------|---------------|-------------|------|-----------|----------------------------------|----------------------------------|------------------------|
| T7   | MoveTrain | — | Antwerpen | 30M | 0 (previous route completed) | — | — | — |
| T8   | **PassTurn** | Antwerpen | Antwerpen | 30M | 4 | **`route_impossible`** | `a3_abandon_for_carry_deliver_partial` | `["PassTurn"]` |
| T9   | **PassTurn** | Antwerpen | Antwerpen | 30M | 4 | `route_impossible` | `a3_abandon_for_carry_deliver_partial` | `["PassTurn"]` |
| T10  | UpgradeTrain | Antwerpen | Antwerpen | **10M** (post-upgrade) | 4 | `route_impossible` | `a3_abandon_for_carry_deliver_partial` | `["PassTurn"]` |

The route's reasoning at T8 (truncated for clarity, full text in commit message):

> `[deterministic-top-1] pair:114-Steel+88-Copper:AB-sup:Ruhr-Wroclaw chosen.`
> `Picked: pair-shared-delivery — payout 40M, build 21M, 8 turns, NET 19M`

Confirming via the candidate-survivor counts: `Survivors after spatial prune: 482 of 1170 raw. Discarded by prune: 640 (turns > 12) | 48 (build > 130M).` — the pruning filter is `turns > 12` and `build > 130M`, neither of which catches a 21M-build candidate against a $30M cash position whose A2 immediately rejects as impossible. So **whatever check A2 runs is not present in the planner's candidate scorer.**

## Expected behavior

Two separate behaviors need to hold:

1. **The candidate scorer must use the same feasibility check as A2.** If A2 declares a route impossible from the bot's current position with current cash, the scoring path must already have rejected that candidate before it was returned as `top-1`. Otherwise the planner and executor disagree, and the planner emits routes the executor cannot start.
2. **When A2 declares `route_impossible`, the active route must be cleared and a fresh replan triggered.** Persisting an impossible route across turns is a livelock. The bot has no escape path under the current logic.

Additionally:

3. **`upgradeOnRoute` must not fire if A2 has declared the route impossible.** Today it fires anyway (T10), depleting cash by $20M and making the situation strictly worse.

What must NOT happen: the bot accepts a route, A2 declares it impossible, the route persists, the bot upgrades on the impossible route, cash drops, livelock continues.

## Acceptance

- **AC1 — Scorer feasibility parity.** Construct a fixture matching T8: bot at Antwerpen, $30M cash, demand hand contains the Steel+Copper Torino pair (or any pair where the planner currently selects a route A2 calls impossible). Invoke `planTripDeterministic`. Assert: the candidate the planner returns must pass an A2-equivalent feasibility check from the bot's current position. If no candidate passes, the planner returns "no feasible route".
- **AC2 — Route-impossible clears active route.** Fixture: active route present, A2 returns `route_impossible` for it. Assert: at end of `MovementPhasePlanner.run`, `activeRoute` is null (or marked abandoned), and the per-turn log records `route_abandoned_reason = 'a2_route_impossible'`.
- **AC3 — Route-impossible triggers immediate replan.** Same fixture as AC2. Assert: a new `TripPlanner.planTrip` invocation runs in the same turn, with the now-rejected route's load types added to an "avoid this turn" exclusion to prevent re-selecting the same candidate immediately.
- **AC4 — UpgradeOnRoute gate.** Fixture: route has `upgradeOnRoute = 'Superfreight'`, A2 returns `route_impossible`. Assert: upgrade does NOT fire. The upgrade is conditional on the route being executable.
- **AC5 — Full-game regression.** Replay Sonnet's T7 snapshot from game `6033c903` and run 5 turns. Assert: the bot does not remain at Antwerpen with the same `route_impossible` route active across multiple turns. Either it transitions to a different route, or it has done something productive (built track toward a feasible target, drawn new demand cards via DiscardHand, etc.).

## Not in scope

- Re-tuning the candidate generator's pruning thresholds (`turns > 12`, `build > 130M`). The fix is to share the A2 feasibility predicate with the scorer, not to tweak coarse thresholds.
- Whether `a3_abandon_for_carry_deliver_partial` is the right termination reason for a no-carry case (it says "carry_deliver" but the bot is carrying nothing at T8). May be a separate misclassification bug — note for follow-up but not blocking.
- The general "spend to zero" policy from JIRA-246 — that's about NOT requiring a cash reserve. This ticket is about NOT picking routes that can't be **started** from the current cash position.

## Relationship to existing JIRAs

- **JIRA-246** removed the cash-floor gate so the bot can spend to zero. JIRA-253's fix must preserve that — the requirement here is "candidate's build can be **started** from current cash position", not "candidate's build leaves a reserve buffer."
- **JIRA-249** (just shipped) added a grammar invariant on candidates. JIRA-253 is a parallel invariant: candidates must be **starting-feasible**, not just grammatically valid.
- **JIRA-248/250** (just shipped) ensure carried-load deliveries are correctly enumerated. JIRA-253 is about FRESH candidates being correctly filtered for cash feasibility.
