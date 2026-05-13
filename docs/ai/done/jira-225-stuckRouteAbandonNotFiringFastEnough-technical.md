# JIRA-225 — Stuck-route-abandon doesn't fire fast enough (technical)

See `jira-225-stuckRouteAbandonNotFiringFastEnough-behavioral.md` for the observed behavior and acceptance criteria.

## Code under suspicion

`src/server/services/ai/ActiveRouteContinuer.ts:36-91`:

```ts
const STUCK_ROUTE_PASSTURN_THRESHOLD = 3;
// ...
const turnsOnRoute = memory.turnsOnRoute ?? 0;
const isStuck =
  /* PassTurn-only execResult check */
  && turnsOnRoute >= STUCK_ROUTE_PASSTURN_THRESHOLD - 1;
```

## Investigation plan

1. **Find every site that increments `memory.turnsOnRoute`.** `grep -rn "turnsOnRoute" src/server/`. Verify the increment runs even on PassTurn-only turns. If it only fires when a move/build/etc. plan is produced, the counter never advances on stuck turns — that's the bug.
2. **Find every site that resets `memory.turnsOnRoute`.** Verify it resets only when the active route changes, not on every turn.
3. **Read the per-turn loop that calls `ActiveRouteContinuer.run`.** Confirm whether `memory` persists across turns or is rebuilt. If rebuilt, the counter resets to 0 every turn — also a bug.
4. **Construct the false-negative repro.** Build a synthetic `execResult` representing a PassTurn-only outcome on an active route. Pass it through `ActiveRouteContinuer.run` with `memory.turnsOnRoute = 2`. Assert `isStuck === true`. If false → the predicate's other clauses (the PassTurn-only check) are too strict.
5. **Inspect game logs.** Search games e437ce9b and 1a10d393 logs for `[stuck-route-abandon]` or `turnsOnRoute=` traces. If the counter values appear, they tell the story directly.

## Likely fixes (pick after investigation)

### Fix A — Counter not incrementing through PassTurn

If `turnsOnRoute` increments only on non-PassTurn-only turns, change the increment site to fire on EVERY turn the active route is unchanged. This is the most likely bug given the observed symptom.

### Fix B — Counter resetting each turn

If `memory` is rebuilt per turn rather than persisted, the persistence layer needs to be fixed (or `turnsOnRoute` moved to a memory field that IS persisted).

### Fix C — Predicate shape too strict

If `isStuck`'s PassTurn-only check excludes legitimate stuck shapes (e.g., a PassTurn with non-empty `plans` array, or a specific `terminationReason`), broaden the predicate.

In all three cases, **add a debug log** at the entry point: `console.log('[stuck-route-check] turnsOnRoute=N execResult.shape={...}')` so future stuck-bot games are diagnosable from logs alone.

## Files to touch

- `src/server/services/ai/ActiveRouteContinuer.ts` — primary site.
- Wherever `memory.turnsOnRoute` is mutated (likely `MovementPhasePlanner.ts` or a per-turn orchestrator) — to be identified in step 1 of the investigation.
- `src/server/__tests__/ai/ActiveRouteContinuer.test.ts` — new tests for the false-negative repro and the threshold-fires-on-3rd-turn behavior.

## Test plan

- **Unit**: synthetic `execResult` + `memory.turnsOnRoute = 0, 1, 2` → first two return `route-executor`, third returns `stuck-route-abandon`. Verify the abandon log includes `turnsOnRoute + 1 = 3`.
- **Unit**: `memory.turnsOnRoute` increments correctly on every turn that produces a PassTurn-only `execResult`.
- **Unit**: `memory.turnsOnRoute` resets when the active route changes (via TripPlanner replan).
- **Integration / replay**: hand-construct the per-turn trace from game e437ce9b's stuck stretch and confirm abandon fires on turn 3 of the stuck sequence.

## Risks

- **Low blast radius** — the change is contained to the stuck-route gate logic and its counter-increment site.
- Risk of over-firing: a bot that genuinely PassTurns 3 turns due to an Event card (e.g., Strike) would trigger abandon. Acceptable — the abandon just lets TripPlanner replan; if the Event card is still in effect, replanning will likely produce another stuck candidate, which the gate will eventually clear when the Event lifts. Worst case: one extra replan cycle. Note that this implementation has no Event cards (per the user's project memory), so this risk is theoretical here.

## Estimated complexity

Trivial-to-Standard, depending on which Fix path applies. Fix A is one-line + tests; Fix B is more invasive (memory persistence); Fix C is one-line predicate broadening. Investigation determines tier.
