# JIRA-262 — Per-turn event-card snapshot + parallel events.ndjson lifecycle log (technical)

Companion to `jira-262-eventCardObservabilityGap-behavioral.md`.

## Defect locus

Two complementary gaps:

### Per-turn snapshot — `BotTurnResult` and `GameTurnLogEntry` interfaces

- `src/server/services/ai/AIStrategyEngine.ts` `BotTurnResult` interface — no `activeEffects` or `pendingFloodRebuilds` fields.
- `src/server/services/ai/GameLogger.ts` `GameTurnLogEntry` interface — same omission.
- `src/server/services/ai/BotTurnTrigger.ts:278-344` — `appendTurn(...)` call site doesn't include either field even if it existed.

### Per-game lifecycle log — no module exists

- No `EventLogger` module. Lifecycle events (event-card draw, expire, consume) currently fire-and-forget via `console.info` + socket emits.
- Hook sites that should write to events.ndjson:
  - `src/server/services/playerService.ts:153-189` `flushEventEmissions` — runs after a successful Event-card-drawing commit.
  - `src/server/services/ActiveEffectManager.ts:152-159` `cleanupExpiredEffects` — emits a `console.info` when effects expire.
  - `src/server/services/ActiveEffectManager.ts:231-235` `consumeLostTurn` — emits a `console.info` when a player's lost turn is consumed.

## Fix shape

### Part 1 — Per-turn snapshot

1. Add fields to `BotTurnResult` (AIStrategyEngine.ts) and `GameTurnLogEntry` (GameLogger.ts), both typed `ActiveEffect[]` and `TrackSegment[]` (import-type from `EventCard.ts` and `GameTypes.ts`).
2. In `AIStrategyEngine.takeTurn`'s main success return (one site), populate from `snapshot.activeEffects` and `snapshot.bot.pendingFloodRebuilds`. Set to `undefined` when empty (keeps log entries tight).
3. In `BotTurnTrigger.onTurnChange`'s `appendTurn(...)` call, propagate both fields from `result` to the log entry.

### Part 2 — Parallel events.ndjson

1. Create `src/server/services/ai/EventLogger.ts` modeled on `GameLogger.ts`:
   - `EventLogPhase` union: `'drawn' | 'expired' | 'consumed' | 'flood-segments-removed' | 'flood-rebuild'` (last two are reserved for forward-compat; not wired in v1).
   - `EventLogEntry` interface with phase-specific fields (cardId, cardType, drawingPlayerId, affectedZone, restrictionTypes, pendingLostTurnPlayerIds, floodedRiver, expiresAfterTurnNumber for `drawn`; expiredCardIds for `expired`; consumedPlayerId for `consumed`).
   - `appendEvent(gameId, entry)` writes `logs/events-<gameId>.ndjson` via `fs.appendFile` (async, fire-and-forget) plus `mkdirSync` (sync, idempotent). Best-effort: errors logged via `console.error`, never thrown.

2. Wire the hooks:
   - **drawn**: inside `flushEventEmissions` (playerService.ts), after the existing `emitEventCardDrawn` socket emit. Use a try/catch wrapper so a logger failure can't break the emit loop. Pull cardId / cardType / drawingPlayerId / affectedZone / perPlayerEffects / persistentEffectDescriptor / floodedRiver from `eventResult`.
   - **expired**: inside `cleanupExpiredEffects` (ActiveEffectManager.ts), after the existing console.info, only when `expiredCardIds.length > 0`. Pass `completedTurnNumber` as the entry's `turn`.
   - **consumed**: inside `consumeLostTurn` (ActiveEffectManager.ts), after the existing console.info. Turn number isn't available at the call site (the function operates on a player-level scope, not a turn-level scope) — use `turn: -1` as a sentinel and document that analysis tooling should interleave with the game-<id>.ndjson by timestamp to recover ordering.

3. Lazy-import `appendEvent` at each hook (`const { appendEvent } = await import('./ai/EventLogger');`). Avoids a static dependency from `playerService.ts` and `ActiveEffectManager.ts` into the AI module tree; matches the lazy-import pattern already used for `socketService` in the same flushEventEmissions function.

## Acceptance from behavioral

- **AC1** Integration / live test: run an all-bot game (manual or via the upcoming harness) with at least one event card drawn. Inspect `logs/game-<gameId>.ndjson`: at least one entry has `activeEffects: [{ cardId: ..., cardType: 'Strike', ..., restrictions: {...}, pendingLostTurns: [...] }]`.
- **AC2** Same game produces `logs/events-<gameId>.ndjson` with at least one `phase: 'drawn'` entry. If the event expires before game end, also a `phase: 'expired'` entry.
- **AC3** Unit test in `EventLogger.test.ts`: appendEvent writes a JSON line to the expected path with trailing newline.
- **AC4** Unit test: appendEvent does NOT throw when fs.appendFile errors (mocked to fail). Mocked console.error is called.
- **AC5** Type check: `tsc --noEmit -p .` passes after the changes (validates that BotTurnResult.activeEffects and GameTurnLogEntry.activeEffects use the same ActiveEffect type the planners consume).

## Validation hooks

- After the fix, on any fresh game: `jq '.activeEffects | length' logs/game-<gameId>.ndjson` should produce at least one non-null value (likely many).
- `wc -l logs/events-<gameId>.ndjson` should be > 0 if the game's deck contained any event cards.
- The pre-existing `rejectionReason` field on per-turn entries (JIRA-258) is unaffected — both observability surfaces coexist.

## Not in scope

- Backfilling old games. Going-forward only.
- A web-log viewer consumer for `events.ndjson`. Analysis is jq / spreadsheet for now.
- Flood-specific hooks (`flood-segments-removed`, `flood-rebuild`). Filed via the EventLogPhase union for forward-compat; the hooks themselves can land in a follow-up when Flood analysis becomes a priority.
- Capturing the turn number inside `consumeLostTurn`. The function operates per-player and doesn't currently take a turn number; threading one through would mean modifying every caller (`PlayerService.updateCurrentPlayerIndex`, `BotTurnTrigger.advanceTurnAfterBot`). v1 uses `turn: -1` as a sentinel; downstream analysis interleaves by timestamp.

## Relationship to existing JIRAs

- **JIRA-256** (Phase 4 — Bot Event-Card Awareness): introduced the bot's reaction to event cards. This ticket plugs the observability gap.
- **JIRA-258** (turn-log execution-outcome fidelity): already added `rejectionReason` to the per-turn log. This ticket complements it.
- **JIRA-260** (transactional turn-advance for all-bot games): without that fix, expirations and consumptions never fired in all-bot games — meaning event lifecycle entries would never have been written in those games. JIRA-260 + JIRA-262 are mutually reinforcing for all-bot game analysis.
- **Bot-vs-bot harness proposal** (`docs/ai/bot-vs-bot-harness-proposal.md`): this fix is the prerequisite for generating useful harness data.
