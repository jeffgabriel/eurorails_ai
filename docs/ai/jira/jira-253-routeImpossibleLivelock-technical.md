# JIRA-253 — Scorer-vs-A2 feasibility parity + route-impossible livelock break (technical)

Companion to `jira-253-routeImpossibleLivelock-behavioral.md`.

## Defect locus (provisional — needs log validation)

Two interacting sites:

### Site A — `DeterministicTripPlanner.scoreCandidate` (planner side)

`src/server/services/ai/DeterministicTripPlanner.ts` — the per-candidate scoring function (likely also `computeAggregateScore`). Currently scoring uses:
- `simulateTrip` output (`TripSimulation` — `turnsToComplete`, `totalBuildCost`, `minCashRelative`, `finalCashRelative`, `feasible`, `builtSegments`)
- A `feasible: false` value should reject the candidate, but `simulateTrip`'s feasibility is computed against a different model than A2's runtime feasibility.

The mismatch: `simulateTrip` is a *planning-time* simulation that takes turns/cost optimistically. A2 is *runtime* — it consults the bot's actual existing track network and current position to determine whether the first leg's build is reachable. If A2 finds the route impossible from `bot.position` with `bot.money`, but the planner's `simulateTrip` reported feasible from the same inputs, the two simulations have drifted apart.

### Site B — `MovementPhasePlanner.A2` (executor side)

`src/server/services/ai/MovementPhasePlanner.ts` — the A2 phase that produces `terminationReason = 'route_impossible'`. Find this string; it's the canonical anchor. When A2 returns this reason today:
- The composition trace records it.
- No code clears `memory.activeRoute`.
- No code triggers `TripPlanner.planTrip` in the same turn or memo-bans the route's load types.
- The fallback is PassTurn — and next turn the same route resurfaces.

### Site C — `upgradeOnRoute` execution

The trip planner emits `upgradeOnRoute` as a top-level response field that the executor processes alongside the route. If `route_impossible` fires but the upgrade payload runs anyway, the upgrade depletes cash and digs the hole deeper. Find the upgrade-emit site (probably `AIStrategyEngine` or `TurnExecutorPlanner`) and gate it on route feasibility.

## Suspect: `simulateTrip` and A2 use different "starting feasibility" definitions

`simulateTrip` returns `TripSimulation.feasible` — a boolean. Reading the scoring code, `feasible: false` means the simulation could not complete (e.g. unreachable destination). But "could not complete" is not the same as "cannot **start**." A simulation that walks the full route end-to-end and checks net cash >= 0 at each step can still pass `feasible: true` even when the FIRST build leg requires more cash than the bot currently has — because the simulation includes the eventual delivery payouts in its running cash.

A2 doesn't have that luxury: it's evaluating "what action can I emit RIGHT NOW from current position with current cash." Build to Ruhr requires X cash; if X > bot.money, A2 says impossible. It can't credit a delivery that hasn't happened yet.

This is the planner-vs-executor disagreement that produces the livelock.

## Fix shape

### Step 1 — Add a "starting-feasibility" predicate

New pure function in `DeterministicTripPlanner.ts`:

```ts
function isCandidateStartingFeasible(
  candidate: CandidateRoute,
  startingPos: GridCoord,
  startingCash: number,
  bot: WorldSnapshot['bot'],
  gridPoints: GridPoint[],
): { ok: true } | { ok: false; reason: 'first_leg_build_exceeds_cash' | 'first_leg_unreachable' | ... } {
  // Compute build cost from startingPos to the candidate's FIRST stop's required position.
  // If buildCost > startingCash, return { ok: false, reason: 'first_leg_build_exceeds_cash' }.
  // If the path is unreachable (water-blocked etc.), return { ok: false, reason: 'first_leg_unreachable' }.
  // Otherwise { ok: true }.
}
```

Run this on every candidate before it enters the top-1 selection. Reject candidates failing it. Log to `CompositionTrace.candidateRejections` (the field added by JIRA-249) so the rejection is visible.

### Step 2 — A2 must clear the route and trigger replan on `route_impossible`

In `MovementPhasePlanner` (or the `AIStrategyEngine` post-A2 handler), when A2's termination reason is `route_impossible`:

1. **Clear `memory.activeRoute = null`.**
2. **Add the rejected route's load types to a per-turn exclusion set** so the immediate replan doesn't re-select the same candidate.
3. **Invoke `TripPlanner.planTrip` synchronously** with the exclusion set and the now-updated context.
4. **Log the abandonment reason** in the per-turn log as `route_abandoned_reason = 'a2_route_impossible'`.

### Step 3 — Gate `upgradeOnRoute` on route feasibility

Wherever the executor processes `upgradeOnRoute` (search for the string), wrap it in a check: if the active route was just declared impossible (or marked abandoned this turn), skip the upgrade. The upgrade should only fire when the route is actually being executed.

## Acceptance from behavioral

- **AC1** Unit test on `isCandidateStartingFeasible`: fixture with bot at Antwerpen, $30M cash, candidate = `pickup(Steel@Ruhr) → pickup(Copper@Wroclaw) → deliver pair`. Compute build cost to Ruhr from Antwerpen via gridPoints. Assert: if build cost > $30M, predicate returns `{ ok: false, reason: 'first_leg_build_exceeds_cash' }`. If ≤ $30M, returns `{ ok: true }`.
- **AC2** Unit test on `planTripDeterministic`: fixture identical to AC1. Assert: the returned top-1 candidate either passes `isCandidateStartingFeasible` OR the function returns no candidate (with reasoning citing the cash gap).
- **AC3** Unit test on `MovementPhasePlanner` post-A2 handler: stub A2 to return `route_impossible`. Assert: `memory.activeRoute` is null after the call. Assert: `TripPlanner.planTrip` was invoked exactly once with the rejected route's load types in the exclusion set.
- **AC4** Unit test on `upgradeOnRoute` gate: stub a route with `upgradeOnRoute = 'Superfreight'` and A2's termination reason = `route_impossible`. Assert: `UpgradeTrain` action is NOT emitted. The composition trace records `upgrade_skipped_reason = 'route_impossible'`.
- **AC5** Integration regression on game `6033c903` Sonnet T8 snapshot: replay 5 turns. Assert: bot does not PassTurn three times in a row at Antwerpen with the same route active. The bot either selects a different route or makes productive moves (build/DiscardHand).

## Not in scope

- Generalized "scorer-vs-executor parity" auditing across all simulation paths. This ticket addresses the starting-feasibility gap that A2 enforces; other parity gaps (e.g. ferry crossings, parallel-build penalties) belong in separate tickets when symptoms appear.
- LLM-path candidate selection. The LLM produces candidates via prompt; its prompt already mentions cash constraints. Focus this fix on the deterministic path (Medium skill) that produced the observed symptom.
- Replacing `simulateTrip`'s feasibility model entirely — the existing model is adequate for trip economics; we just need an additional `startingFeasible` predicate.

## Validation hooks to inspect during fix

- `composition.a2.terminationReason` at T8 of game `6033c903` should NOT be `route_impossible` after the fix (because the candidate scorer rejected the route earlier).
- `composition.candidateRejections` should include any candidate whose `first_leg_build_exceeds_cash` would have caused A2 to fail.
- The per-turn log entry for any turn where A2 returns `route_impossible` should record `route_abandoned_reason` and show evidence of a same-turn replan invocation (e.g., `replanCount > 0`).
- The `upgradeOnRoute` skip when route is impossible should be visible in `composition.build.upgradeConsidered` or a new `composition.upgrade.skippedReason` field.

## Relationship to existing JIRAs

- **JIRA-246** removed cash-floor reserve gating. JIRA-253 reintroduces a NARROWER gate: "first leg buildable from current cash" — this is feasibility, not reserve.
- **JIRA-249** added `CompositionTrace.candidateRejections` for grammar invariant rejections. JIRA-253's `first_leg_build_exceeds_cash` extends the same rejection channel.
- **JIRA-247** addressed a different livelock (`origin_is_current_position`) at A3. JIRA-253 addresses an A2-side livelock. Same family ("route declared impossible but not cleared"), different trigger.
- **JIRA-252** (post-delivery replan ordering) is the sibling: both this and 252 are about replanning at the right moment. 253 specifically about replanning after `route_impossible`; 252 about replanning after a successful delivery.
