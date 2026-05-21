# JIRA-251 — Wire ActiveEffectManager into WorldSnapshot + planner; surface server rejection reasons in turn logs (technical)

Companion to `jira-251-botBlindToActiveRailStrike-behavioral.md`.

This ticket is a **vertical slice** of Phase 4 (event-card awareness). Fix Rail Strike specifically so the rest of Phase 4 has a working pattern.

## Defect locus

Three sites need touching, in order.

### Site A — `WorldSnapshotService.capture` (snapshot enrichment)

`src/server/services/ai/WorldSnapshotService.ts` — `capture(gameId, playerId)`. Currently produces a `WorldSnapshot` with `bot`, `allPlayerTracks`, `gameStatus`, `turnNumber`, `loadAvailability`. Does NOT query `ActiveEffectManager`.

Add:
```ts
const activeEffects = await ActiveEffectManager.getActiveEffects(gameId);
return { ...existing, activeEffects };
```

Update the `WorldSnapshot` type in `src/shared/types/GameTypes.ts` to include `activeEffects: ActiveEffect[]` (import the type from `EventCard.ts`).

### Site B — Planner consultation (the actual decision)

The bot's planner needs to consult `snapshot.activeEffects` at plan time. Concretely for Rail Strike (event #123):

- If `activeEffects` contains a `RailStrike` effect with `drawingPlayerId === bot.playerId`, then for this turn:
  - **No MoveTrain** on segments where `playerId === bot.playerId` (i.e. own track).
  - **No BuildTrack** at all.
  - Movement on opponent track is legal (with usage fee).
  - Pickup / Deliver at current city is legal.

Sites to add the gate:

1. `src/server/services/ai/MovementPhasePlanner.ts` — before A1/A2/A3 emit MoveTrain, check active effects. If Rail Strike with bot as drawer, restrict the move path to opponent-track segments only.
2. `src/server/services/ai/GuardrailEnforcer.ts` — add a hard gate that rejects MoveTrain plans containing own-track segments when Rail Strike is active. This is the catch-all so an LLM or heuristic-fallback that didn't consult active effects can't bypass the rule.
3. `src/server/services/ai/TurnExecutorPlanner.ts` — similarly for BuildTrack: don't compose Phase B if Rail Strike is active for the bot.

### Site C — Server-side rejection visibility

`src/server/services/playerService.ts` — `moveTrainForUser` (or wherever ActionRestrictionEnforcement runs server-side) returns an error string today when the action is rejected. The bot's turn log doesn't capture this string.

Pipe the rejection reason back to the bot. In `TurnExecutor.handleMoveTrain` (or wherever the bot calls `PlayerService.moveTrainForUser`), catch the rejection error and populate `ExecutionResult.rejectionReason`. Surface it in the per-turn log entry alongside `success: false`.

This isn't Rail Strike-specific — it's a general improvement that helps debug *all* server-side action restrictions.

## Fix shape (minimal viable for Rail Strike only)

1. Add `activeEffects?: ActiveEffect[]` to `WorldSnapshot` type.
2. `WorldSnapshotService.capture` calls `ActiveEffectManager.getActiveEffects(gameId)`.
3. New helper `isRailStrikeBlockingBot(snapshot)`: returns true iff any active effect is Rail Strike with `drawingPlayerId === snapshot.bot.playerId`.
4. `MovementPhasePlanner` Phase A: if `isRailStrikeBlockingBot`, skip the own-track move candidate, try opponent-track A2/A3 only.
5. `GuardrailEnforcer`: add `RAIL_STRIKE_OWN_TRACK_BLOCKED` hard gate. Reject any plan with own-track MoveTrain segments under Rail Strike. Force PassTurn if no legal alternative exists.
6. `TurnExecutor.handleMoveTrain`: catch `PlayerService.moveTrainForUser` rejection error, expose as `rejectionReason` in result + log.
7. `GameLogger.appendTurn`: include `rejectionReason` in the per-turn JSON.

## Acceptance from behavioral

- **AC1** — Unit test on `MovementPhasePlanner.run`: fixture with snapshot containing a Rail Strike effect for the bot. Assert: no MoveTrain emitted on own-track segments.
- **AC2** — Unit test: same fixture + deliverable load at current city + `canDeliver` non-empty. Assert: `DeliverLoad` action emitted (not MoveTrain).
- **AC3** — Unit test: same fixture + no legal alternative. Assert: `PassTurn` emitted with `reasoning` citing Rail Strike.
- **AC4** — Integration test on `TurnExecutor.handleMoveTrain`: server rejects move via `ActionRestrictionEnforcement`. Assert: `ExecutionResult.rejectionReason` populated; appended turn log entry includes the same string.
- **AC5** — Unit test on `WorldSnapshotService.capture`: stub `ActiveEffectManager.getActiveEffects` to return a Rail Strike entry. Assert: returned snapshot has `activeEffects: [...]` populated.

## Not in scope

- Other event card types (Snow, Derailment, Flood, coastal Strike, Excess Profit Tax). File per-symptom JIRAs as they surface in real play.
- Strategic-level event-card adaptation (e.g. drawing player choosing where to draw Rail Strikes — that's adversarial play, beyond Phase 4 V1).
- LLM-side prompt updates for event-card reasoning — the deterministic gate at Layer B-2 should be sufficient for the Rail Strike case.

## Validation hooks to inspect during fix

- `snapshot.activeEffects` at turns T6–T11 of game `d9d2433a` — should be non-null after fix; should contain a Rail Strike entry.
- `composition.guardrail.firstViolation` — should show `RAIL_STRIKE_OWN_TRACK_BLOCKED` if a planner tries to emit own-track movement during active Rail Strike.
- Per-turn log `rejectionReason` field — populated when server rejects an action.

## Phase 4 onramp

After this ticket lands, the pattern is:
- Snapshot enrichment → planner consultation → guardrail backstop → server-rejection visibility.

Use the same pattern for each subsequent event type. The hard work is the snapshot wiring and the guardrail gate registry; per-event-type logic is small.
