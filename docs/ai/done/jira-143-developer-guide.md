# Developer Guide: LLM Logging Infrastructure & Turn Fix (JIRA-143 P1)

## Overview

This project separates LLM call/response data from the game turn log into a dedicated transcript file, adds new metadata fields to the game log schema, and fixes a turn counter off-by-one bug.

## Architecture

### Before
- LLM prompts, responses, and attempt logs were embedded inline in `game-{gameId}.ndjson` entries
- Game log entries were bloated with full prompt text
- No way to analyze LLM behavior independently from game state
- First bot turn logged as `turn: 2` instead of `turn: 1`

### After
- LLM call data writes to `logs/llm-{gameId}.ndjson` (one line per `adapter.chat()` call)
- Game log entries are compact; linked to LLM calls via `llmCallIds`
- New metadata fields (`actor`, `actorDetail`, `llmModel`, etc.) ready for Project 2
- First bot turn correctly logs as `turn: 1`

## New Files

### `src/server/services/ai/LLMTranscriptLogger.ts`

Append-only NDJSON writer for LLM transcripts. Follows the same pattern as `GameLogger.appendTurn()`.

**Exports:**
- `appendLLMCall(gameId: string, entry: LLMTranscriptEntry): void` — Best-effort write (never throws)
- `LLMTranscriptEntry` interface — Schema for each LLM call record

**Output:** `logs/llm-{gameId}.ndjson`

**Entry fields:** `callId`, `gameId`, `playerId`, `turn`, `timestamp`, `caller`, `method`, `model`, `systemPrompt`, `userPrompt`, `responseText`, `status`, `error?`, `latencyMs`, `tokenUsage?`, `attemptNumber`, `totalAttempts`

### `src/server/services/ai/LoggingProviderAdapter.ts`

Decorator wrapping `ProviderAdapter` that intercepts all `chat()` calls to log transcripts.

**Key methods:**
- `constructor(inner: ProviderAdapter)` — Wraps the real adapter
- `setContext(ctx)` — Sets `gameId`, `playerId`, `turn`, `caller`, `method` for subsequent calls
- `chat(request)` — Times the call, generates a `callId`, writes transcript, returns/throws original result
- `getCallIds(): string[]` — Returns accumulated callIds for the current turn
- `resetCallIds(): void` — Clears IDs at turn start

**Error handling:** Logging happens in a `finally` block. Errors from the inner adapter are always re-thrown. Transcript write failures are caught by `appendLLMCall` and logged to console.

## Modified Files

### `src/server/services/ai/GameLogger.ts`

**Added fields** (optional, populated by Project 2):
- `actor`, `actorDetail`, `llmModel`, `actionBreakdown`, `llmCallIds`, `llmSummary`, `actionTimeline`, `originalPlan`, `advisorUsedFallback`

**Removed fields** (moved to LLM transcript):
- `systemPrompt`, `userPrompt`, `llmLog`, `advisorSystemPrompt`, `advisorUserPrompt`, `model`

### `src/server/services/ai/LLMStrategyBrain.ts`

- Constructor wraps the real `ProviderAdapter` with `LoggingProviderAdapter`
- `providerAdapter` getter return type changed to `LoggingProviderAdapter`

### `src/server/services/ai/BotTurnTrigger.ts`

- Turn counter fix: `COALESCE(current_turn_number, 0) + 1` (was `1`, now `0`)
- Removed `model`, `llmLog`, `systemPrompt`, `userPrompt` from `appendTurn()` call

## How to Use (Project 2)

To populate the new fields, callers should:

1. **Set context before LLM calls:**
   ```typescript
   brain.providerAdapter.setContext({
     gameId, playerId, turn,
     caller: 'strategy-brain',
     method: 'decideAction',
   });
   ```

2. **Collect call IDs after a turn:**
   ```typescript
   const llmCallIds = brain.providerAdapter.getCallIds();
   brain.providerAdapter.resetCallIds();
   ```

3. **Pass metadata to appendTurn:**
   ```typescript
   appendTurn(gameId, {
     ...existingFields,
     actor: 'llm',
     actorDetail: 'strategy-brain',
     llmModel: brain.modelName,
     llmCallIds,
   });
   ```

## Debugging

### View LLM transcripts
```bash
# All LLM calls for a game
cat logs/llm-{gameId}.ndjson | jq .

# Filter by caller
cat logs/llm-{gameId}.ndjson | jq 'select(.caller == "trip-planner")'

# Slow calls
cat logs/llm-{gameId}.ndjson | jq 'select(.latencyMs > 5000)'

# Errors only
cat logs/llm-{gameId}.ndjson | jq 'select(.status == "error")'
```

### Cross-reference with game log
The `llmCallIds` field in game log entries links to `callId` in the LLM transcript. Once Project 2 populates this field, you can join the two files.

## Tests

- `src/server/__tests__/ai/LLMTranscriptLogger.test.ts` — 5 tests: NDJSON writing, error handling
- `src/server/__tests__/ai/LoggingProviderAdapter.test.ts` — 9 tests: delegation, context, errors, call IDs
- `src/server/__tests__/ai/BotTurnTrigger.turnCounter.test.ts` — 2 tests: turn 1 for new game, increment for existing
