# JIRA-262 — Event-card observability gap: per-turn NDJSON omits active effects, no per-game event timeline exists (behavioral)

Post-hoc analysis of how event cards (Strike / Snow / Flood / Derailment) affect bot games is severely limited. The per-turn `logs/game-<gameId>.ndjson` does not record which event cards are active at each turn, even though the bot's planners read `snapshot.activeEffects` and make decisions based on it. There is also no separate persisted record of event-card lifecycle (when each card was drawn, when it expired, when a player's pending lost turn was consumed). The only available signals are ephemeral socket emits (lost when the server restarts) and freeform reasoning-string keywords like "Lost turn due to Derailment event card #125" — fragile and impossible to aggregate.

Discovered while investigating JIRA-256 / JIRA-260 / JIRA-261 against game logs:
- `grep activeEffects logs/game-f3ed7b8f-8ebb-45f9-9010-90c3fbfac628.ndjson` → 0 hits
- `grep rejectionReason logs/game-f3ed7b8f-8ebb-45f9-9010-90c3fbfac628.ndjson` → 0 hits (the field is defined in GameLogger but predates the BE-008 plumbing in that game)
- Reasoning string keyword grep → 46 hits across one game, but unstructured

Decision point: about to generate 100s of fresh games via the new all-bot harness (proposal in `docs/ai/bot-vs-bot-harness-proposal.md`). Without this fix, every harness game would produce an event-card-blind log.

## Source

- `src/server/services/ai/GameLogger.ts:21-204` — `GameTurnLogEntry` interface; before this fix, no event-card fields.
- `src/server/services/ai/AIStrategyEngine.ts:73-180` — `BotTurnResult`; same.
- `logs/game-f3ed7b8f-*.ndjson` — empirical confirmation that the activeEffects field is absent.

## Expected behavior

Two complementary records per game:

1. **Per-turn snapshot** in `logs/game-<gameId>.ndjson`: each turn entry includes:
   - `activeEffects`: the array of currently-active event cards (with cardId, cardType, drawingPlayerId, restriction zones, pendingLostTurns per player, expiresAfterTurnNumber, floodedRiver). Omitted when no events are active.
   - `pendingFloodRebuilds`: the bot's pending Flood-rebuild segments. Omitted when empty.

2. **Per-game lifecycle timeline** in `logs/events-<gameId>.ndjson` (new file): one JSON line per event-card-lifecycle event:
   - `drawn` — a player drew an Event card; full restrictions/zone/expiry captured.
   - `expired` — `cleanupExpiredEffects` removed an effect at the drawing player's next turn end.
   - `consumed` — `consumeLostTurn` removed a player's pendingLostTurns entry (that player's turn was skipped this round).
   - (Out of v1 scope but designed-in via the EventLogPhase union: `flood-segments-removed` and `flood-rebuild`.)

Together they let post-hoc analysis answer questions like "how many turns did player X lose to Derailment in game Y?" or "which delivery was blocked by the Coastal Strike active in T29-T31?".

## Acceptance

- **AC1** — After running a fresh all-bot game with event cards in the deck, `logs/game-<gameId>.ndjson` has at least one entry with `activeEffects: [...]` containing a non-empty array. The activeEffects object has the documented shape (cardId, cardType, drawingPlayerId, restrictions, pendingLostTurns, expiresAfterTurnNumber).
- **AC2** — Same game produces a separate `logs/events-<gameId>.ndjson` file with one line per lifecycle event. At minimum: one `drawn` entry per Event card drawn, one `expired` entry per cleanup (may batch multiple cardIds when several expire together), one `consumed` entry per pending-lost-turn consumption.
- **AC3** — When no event cards are active for a turn, the `activeEffects` field is omitted (not `null`, not `[]`) — keeps log entries tight.
- **AC4** — Failure to write events.ndjson (e.g. disk full, EACCES) does NOT throw. The game loop continues uninterrupted; a warning is logged to stderr.
- **AC5** — TypeScript types updated: `BotTurnResult.activeEffects` and `GameTurnLogEntry.activeEffects` declared with the same `ActiveEffect[]` type used by the planners (no schema drift between consumer and producer).

## Not in scope

- Backfilling historical NDJSON files. Going-forward only.
- A "rejection events" log line (already covered separately by the existing JIRA-258 `rejectionReason` field on per-turn entries).
- A UI consumer of `events.ndjson`. v1 is analysis-only — the existing `logRoutes.ts` web log viewer can be extended in a follow-up if needed.
- Flood-specific events (`flood-segments-removed`, `flood-rebuild`). The EventLogPhase union includes them for forward-compat but the hooks aren't wired in v1.

## Relationship to existing JIRAs

- **JIRA-256** (Phase 4 — Bot Event-Card Awareness): the work that introduced the bot's ability to react to event cards. This ticket plugs the observability gap that JIRA-256 left open.
- **JIRA-258** (turn-log fields reflect execution outcomes): already added `rejectionReason` to the per-turn log. This ticket complements it with the broader event-card context.
- **JIRA-260** (transactional turn-advance for all-bot games): without that fix, expirations and lost-turn consumption never fired in all-bot games. This ticket logs both lifecycle events when they do fire.
- **Bot-vs-bot harness proposal** (`docs/ai/bot-vs-bot-harness-proposal.md`): this fix is the prerequisite for the harness producing useful data.
