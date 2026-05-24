# JIRA-129b: Build Advisor Silent Fallback — Two Root Causes

_The Build Advisor (JIRA-129) never produces a recommendation. Every call returns `null`, triggering fallback to heuristic build logic. Game `b80717f9` shows 100% fallback rate across 20 turns for both bots. The advisor is wired in but broken._

## Evidence

Game `b80717f9` (2025-03-19): Every turn shows `"fallback": true`, `"action": null`, `"reasoning": null`. Flash went bankrupt (0M for 4 turns) after committing 55M+ to the Britain corridor — exactly the unaffordable commitment the advisor was designed to prevent.

## Root Cause 1: Flash (Gemini) — Timeout

**File:** `BuildAdvisor.ts:53-60`

The `advise()` call does NOT pass `timeoutMs` to `brain.providerAdapter.chat()`:

```typescript
const response = await brain.providerAdapter.chat({
  model: brain.modelName,
  maxTokens: 2048,
  temperature: 0,
  systemPrompt: system,
  userPrompt: user,
  outputSchema: BUILD_ADVISOR_SCHEMA,
  // ← no timeoutMs override
});
```

The adapter constructor default is 10s for Easy bots, 15s for Hard (`AIStrategyEngine.ts:1473`). The corridor map + structured output schema is too complex for Gemini to respond in 10s. The `ProviderAdapter.chat()` interface already supports per-request `timeoutMs` overrides (line 50 of `ProviderAdapter.ts`) — it's just not being used.

The resulting `ProviderTimeoutError` is caught by the bare `catch` at line 66-68 and silently returns `null`.

**Fix:** Pass `timeoutMs: 30000` (or a configurable value) to both `advise()` and `retryWithSolvencyFeedback()` chat calls. The advisor is a once-per-build-turn call with a complex map — it needs more time than a simple action decision.

```typescript
const response = await brain.providerAdapter.chat({
  model: brain.modelName,
  maxTokens: 2048,
  temperature: 0,
  systemPrompt: system,
  userPrompt: user,
  outputSchema: BUILD_ADVISOR_SCHEMA,
  timeoutMs: 30000, // ← ADD: advisor needs more time for corridor map reasoning
});
```

## Root Cause 2: Haiku (Anthropic) — Waypoint Validation Failure

**Files:** `MapRenderer.ts:73-109`, `BuildAdvisor.ts:131-159`, `systemPrompts.ts:649`

The corridor map rendered by `MapRenderer.renderCorridor()` has **no row/column coordinate labels**. The grid iterates from `minRow` to `maxRow` and `minCol` to `maxCol`, but the rendered ASCII contains only terrain characters — no axis labels.

The system prompt (line 649) instructs:
> "Answer with waypoints (row, col coordinates) that the track should pass through"

But the LLM has no way to determine the actual grid coordinates from the bare ASCII. It sees a relative character grid and must guess absolute coordinates. Every guess fails `validateWaypoints()` (line 131-159) because none match any `GridPoint` in the valid set. When all waypoints are invalid and the action requires waypoints, the validator returns `null` (line 145-147).

**Fix:** Add row/col axis labels to the rendered corridor map so the LLM can read actual coordinates:

```
     28  29  30  31  32  33  34
 19:  .   B   B   .   O   O   .
 20:  .   B   .   ~   O   .   .
 21:  .  *H   .   .   O>  .   .     Hamburg
 23:  .   .   .   .   T   .   .
```

This matches the format shown in the JIRA-129 design doc but was never implemented in `MapRenderer.renderCorridor()`.

### MapRenderer Fix

In `MapRenderer.ts`, add column header and row labels:

```typescript
// After line 72 (before the grid render loop):

// Column header
let header = '     ';
for (let col = minCol; col <= maxCol; col++) {
  header += String(col).padStart(3, ' ') + ' ';
}
lines.push(header);

// In the row loop (line 74), prefix each row:
for (let row = minRow; row <= maxRow; row++) {
  let line = String(row).padStart(3, ' ') + ': ';
  for (let col = minCol; col <= maxCol; col++) {
    // ... existing terrain rendering ...
    // Pad each cell to 4 chars for alignment with header
  }
}
```

## Root Cause 3 (Contributing): Silent Error Swallowing

**File:** `BuildAdvisor.ts:66-68`

```typescript
} catch {
  return null;
}
```

Both `advise()` and `retryWithSolvencyFeedback()` have bare catch blocks with no logging. Timeouts, parse failures, validation errors, and API errors all produce identical `null` returns. The NDJSON log records `"fallback": true` but has no way to distinguish WHY.

**Fix:** Add structured error logging:

```typescript
} catch (err) {
  const errorType = err instanceof Error ? err.constructor.name : 'Unknown';
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.warn(`[BuildAdvisor] advise failed: ${errorType}: ${errorMsg}`);
  return null;
}
```

Also log validation failures in `validateWaypoints()` when all waypoints are rejected — include the attempted vs valid coordinate sets for debugging.

## Implementation

| Fix | File | Change | Effort |
|-----|------|--------|--------|
| 1. Add timeout override | `BuildAdvisor.ts` (lines 53, 111) | Add `timeoutMs: 30000` to both chat calls | Trivial |
| 2. Add coordinate labels to map | `MapRenderer.ts` (renderCorridor) | Add column header row, row labels with padding | Small |
| 3. Fix cell spacing | `MapRenderer.ts` (renderCorridor) | Pad terrain chars to match header column width | Small |
| 4. Add error logging | `BuildAdvisor.ts` (lines 66-68, 122-124) | Replace bare catch with typed error logging | Trivial |
| 5. Log validation failures | `BuildAdvisor.ts` (validateWaypoints) | Log rejected waypoints when returning null | Trivial |

## What This Does NOT Change

- The `ProviderAdapter` interface — already supports `timeoutMs` per-request
- The `validateWaypoints()` logic — correct once LLM has proper coordinates
- The solvency retry loop in `TurnComposer.ts` — correct once advisor returns non-null
- The `BUILD_ADVISOR_SCHEMA` — waypoint format `[row, col]` is fine
- The system/user prompt content — correct once map has labels

## Testing

1. **Unit test:** `MapRenderer.renderCorridor()` output includes column headers and row labels with correct coordinate values
2. **Unit test:** `BuildAdvisor.advise()` passes `timeoutMs` to the chat call (verify via mock)
3. **Integration test:** Run a game with both bots and confirm advisor returns non-null results, NDJSON log shows `"fallback": false` with actual action/reasoning
4. **Regression:** Existing `BuildAdvisor.test.ts` tests continue to pass (they use mocked brains so timeout/map changes don't affect them)
