# JIRA-225 — Stuck-route-abandon doesn't fire fast enough; bots PassTurn for many turns before recovery (behavioral)

## Source

Surfaced 2026-05-10 while diagnosing games `e437ce9b-c52d-4370-b0c8-8f7269d55d5b` and `1a10d393-10a1-4216-8155-fa1ec62a690f`. In both, bots emitted PassTurn for 5+ consecutive turns on the same route without `ActiveRouteContinuer.run`'s stuck-route-abandon path firing.

## Observed behavior

The intended safety net is in `src/server/services/ai/ActiveRouteContinuer.ts`:

```ts
const STUCK_ROUTE_PASSTURN_THRESHOLD = 3;
// ...
const turnsOnRoute = memory.turnsOnRoute ?? 0;
const isStuck =
  /* execResult shows passTurn-only result */
  && turnsOnRoute >= STUCK_ROUTE_PASSTURN_THRESHOLD - 1;
```

In games e437ce9b and 1a10d393, this branch did NOT fire even after 5+ consecutive PassTurn turns. The bot continued emitting PassTurn until external income arrived or the game effectively ended.

## Hypotheses (need investigation)

Either:

1. **`turnsOnRoute` is not being incremented through PassTurn turns.** If the per-turn loop only increments `turnsOnRoute` on turns that produced ANY plan (move, build, pickup, deliver), then PassTurn-only turns would leave it at 0 indefinitely. The stuck-route guard would never trigger.
2. **`turnsOnRoute` resets each turn.** If memory is rebuilt fresh per turn instead of carried forward, the counter never reaches the threshold.
3. **The stuck-route condition's shape mismatch.** If `execResult` on a PassTurn-only turn looks different from the shape `isStuck` checks for (e.g., termination reason mismatch, plans length expectation), the predicate is false even when the bot is genuinely stuck.

## Why this matters

The stuck-route-abandon path was added specifically as a safety net so a bot couldn't sit indefinitely on an unreachable goal. Both observed games show that net **never engaged**. The bots PassTurned themselves into oblivion. With JIRA-223 (affordability gate) in place, this safety net is even more important — the gate prevents trips that would dip negative, but it doesn't help bots already stuck on a pre-gate-era route.

The intended behavior is: after `STUCK_ROUTE_PASSTURN_THRESHOLD` (= 3) PassTurn-only turns on the same route, the route is abandoned and TripPlanner gets to replan from scratch. Five+ PassTurn turns observed means the threshold is either miscounted or the predicate doesn't recognize the situation.

## Acceptance criteria

- **AC1** Identify exactly why `isStuck` evaluated `false` in games e437ce9b and 1a10d393. Provide a single-line reproduction (synthetic `execResult` + memory state) demonstrating the false negative.
- **AC2** After fix, a bot that PassTurns 3 consecutive turns on the same route MUST trigger `stuck-route-abandon` on the 3rd turn. (`turnsOnRoute = 2` going in → `turnsOnRoute + 1 = 3` reported in the abandon log → route cleared so TripPlanner replans on turn 4.)
- **AC3** A unit test verifies the threshold using a synthetic stuck sequence: 3 consecutive PassTurn-only `execResult`s with the same active route → 3rd call returns `model: 'stuck-route-abandon'` and clears the active route.
- **AC4** Replay (or hand-construct synthetic state from) games e437ce9b and 1a10d393 to confirm: with the fix, the bot abandons the route by turn 3 of stuck behavior, freeing TripPlanner to replan, instead of sitting through 5+ PassTurn turns.
- **AC5** No regression in existing ActiveRouteContinuer tests.

## Out of scope

- Lowering the threshold below 3 (separate tuning question; behavioral spec is "the threshold should fire as designed, not be relaxed").
- Adding new stuck detectors (this ticket fixes the existing one).
- Changes to TripPlanner's replan logic (it just needs to run once the route is abandoned).

## Severity

**High** — observed in two separate games; symptom is unrecoverable bot stuck for many turns; effective game-ending bug for affected bots. The safety net was designed for exactly this case and isn't engaging.
