# JIRA-138: Build Advisor Two-Pass Structured Extraction

## Problem

The Build Advisor (JIRA-129) has a **0% success rate**. In game `66055a85`, all 403 advisor calls across all three bots failed with JSON parse errors. The advisor falls back to pre-advisor Dijkstra logic every time, meaning the strategic oversight it was designed to provide — reducing duplicate track, increasing smart investments, stopping aimless spending — is completely inactive.

## Root Cause

The Build Advisor passes `outputSchema: BUILD_ADVISOR_SCHEMA` to the provider adapter, but structured output enforcement is silently disabled or degraded:

1. **Gemini thinking models (`gemini-3.*`)**: `GoogleAdapter.ts:46` explicitly skips `responseMimeType` and `responseSchema` when `isGemini3Model()` returns true, because structured output is incompatible with `thinkingConfig`. The model receives no JSON constraint.

2. **Gemini schema rejection fallback**: `GoogleAdapter.ts:104-108` retries without structured output on 400 errors. If the schema is rejected, the retry succeeds but returns prose.

3. **Claude (Haiku)**: Despite the Anthropic adapter passing the schema, Haiku returns markdown (`# Track Building Strategy Analysis`). The model ignores or cannot satisfy the constraint for this spatial reasoning task.

All three failure modes produce the same outcome: `JSON.parse()` fails at `BuildAdvisor.ts:82`, the error is logged, and `null` is returned — triggering the pre-advisor fallback path.

## Evidence

**Game `66055a85`** (541 events, 181 turns, 3 bots):

| Metric | Value |
|---|---|
| Total advisor calls | 403 |
| Successful (valid JSON) | 0 |
| JSON parse failures | 402 |
| Other errors | 1 ("no target city") |
| Solvency retries | 0 (never reached) |

Error breakdown by raw response pattern:
- `"# Track Bu..."` / `"# TRACK BU..."` — 82 (Haiku returning markdown headers)
- `"### Best s..."` / `"### Goal t..."` / `"### Goal (..."` — 98 (Nano returning markdown)
- `"To deliver..."` / `"To reach..."` / `"To achieve..."` / etc. — 222 (Flash returning prose)
- `"**Strategy..."` — 4 (Flash returning bold markdown)

**The reasoning quality is good.** Flash consistently identifies Berlin, Ruhr, and Holland as correct strategic targets. Nano correctly sequences Wien then Milano. Even Haiku's analysis is coherent. The models solve the spatial problem — they answer in prose instead of JSON.

## Constraints

- Thinking models (Gemini 3, Claude extended thinking) produce the best spatial reasoning but **cannot** use structured output — this is a platform-level incompatibility, not a bug.
- Disabling thinking to enforce structured output would degrade reasoning quality for the spatial task the advisor exists to solve.
- The existing `LLMStrategyBrain` infrastructure supports multiple provider adapters with `outputSchema` support on non-thinking models.

## Solution: Two-Pass Extraction

### Architecture

```
Pass 1: Spatial Reasoning (existing call, unchanged)
  → Thinking model, no schema constraint
  → Returns natural language strategy + waypoint descriptions
  → If JSON.parse succeeds (future model improvements): use directly, skip pass 2

Pass 2: Structured Extraction (new, cheap call)
  → Non-thinking model (Haiku-class), structured output enforced
  → Input: raw prose from pass 1 + extraction prompt
  → Output: BUILD_ADVISOR_SCHEMA-conforming JSON
  → If extraction fails: fall back to pre-advisor logic (unchanged)
```

### Pass 1: No changes

The existing advisor call stays exactly as-is. Same prompt, same model, same `outputSchema` parameter (which will work if/when providers fix thinking + structured output compatibility). The only change is that parse failure no longer immediately returns `null`.

### Pass 2: Extraction call

On `JSON.parse` failure at `BuildAdvisor.ts:82-88`, instead of returning `null`:

1. Build an extraction prompt containing:
   - The raw advisor response text
   - The target city name and coordinates
   - The schema description (action enum, waypoints format)
2. Call a non-thinking model with `outputSchema: BUILD_ADVISOR_SCHEMA` enforced
3. Parse the structured response
4. Continue to existing waypoint validation (`validateWaypoints`) and solvency check

**Extraction prompt** (compact, ~500 tokens input):
```
Extract structured build advice from this advisor response.

Target city: {targetCity} at ({targetRow}, {targetCol})
Bot network frontier: ({frontierRow}, {frontierCol})

Advisor response:
---
{rawResponseText}
---

Return JSON with:
- action: "build", "buildAlternative", "replan", or "useOpponentTrack"
- target: city name the advisor recommends building toward
- waypoints: array of [row, col] grid coordinates for intermediate build points
  (extract any coordinates mentioned, or infer from city names)
- reasoning: one-sentence summary of the advisor's strategy
```

**Model selection**: Same model as pass 1 (`brain.modelName`), same provider adapter — but called with `thinking: false` and structured output enforced. The bot's identity is its model; pass 2 is the same player's brain asked a simpler question.

### Implementation

**File: `BuildAdvisor.ts`**

Modify the catch block at lines 82-88:

```typescript
// Current (returns null on parse failure):
} catch (parseErr) {
  const msg = `JSON parse failed: ${(parseErr as Error).message}`;
  BuildAdvisor.lastDiagnostics.error = msg;
  return null;
}

// New (attempts extraction before giving up):
} catch (parseErr) {
  const msg = `JSON parse failed: ${(parseErr as Error).message}`;
  BuildAdvisor.lastDiagnostics.error = msg;

  // Pass 2: extract structured data from prose response
  const extracted = await BuildAdvisor.extractFromProse(
    response.text, targetCity, frontier, brain,
  );
  if (extracted) {
    BuildAdvisor.lastDiagnostics.extractionUsed = true;
    return extracted;
  }
  return null;
}
```

**New private static method: `extractFromProse()`**
- Builds the extraction prompt
- Calls `brain.providerAdapter.chat()` with the **same model** (`brain.modelName`) but `thinking: false` and `outputSchema: BUILD_ADVISOR_SCHEMA`
- Parses, validates waypoints, returns result or null
- Logs latency and outcome to diagnostics

**Same pattern for `retryWithSolvencyFeedback()`** — apply identical extraction fallback at its parse failure point (line ~155).

### Model identity: same player, same model

Each bot's identity is its LLM model — Flash plays as `gemini-3-flash-preview`, Haiku plays as `claude-haiku-4-5-20251001`, etc. Pass 2 preserves this by using the same `brain.providerAdapter` and `brain.modelName`. The only difference is that thinking is explicitly disabled and structured output is enforced:

```typescript
const response = await brain.providerAdapter.chat({
  model: brain.modelName,        // same model as pass 1
  maxTokens: 512,
  temperature: 0,
  systemPrompt: extractionSystemPrompt,
  userPrompt: rawAdvisorResponse,
  outputSchema: BUILD_ADVISOR_SCHEMA,
  thinking: false,               // disable thinking → enables structured output
  timeoutMs: 10000,
});
```

The provider adapters already branch on `thinking`:
- `GoogleAdapter`: when `thinking` is falsy, `thinkingConfig` is omitted, and `responseMimeType`/`responseSchema` are applied (line 46-49). This is exactly the path that enables structured output on Gemini models.
- `AnthropicAdapter`: schema is passed regardless of thinking mode.
- `OpenAIAdapter`: `response_format` with `json_schema` is applied when `outputSchema` is present.

**Risk: schema rejection on thinking models.** Some `gemini-3.*` models may not support `responseSchema` even with thinking disabled. If the API returns a 400, `GoogleAdapter.ts:104-108` retries without the schema — the extraction call would then return prose and fail to parse. Mitigation: if the extraction call also fails `JSON.parse`, log it and return `null` (the existing pre-advisor fallback activates). Track this as `extractionError: 'schema_rejected'` in diagnostics so we can detect it and add a non-thinking model fallback later if needed.

**No new config, no new adapters, no cross-model calls.** The bot's brain does both passes.

### Diagnostics

Extend `BuildAdvisorDiagnostics` with:
- `extractionUsed: boolean` — whether pass 2 was invoked
- `extractionLatencyMs: number` — pass 2 call duration
- `extractionError?: string` — pass 2 failure reason if any

Extend NDJSON log `composition.advisor` with the same fields so game analysis scripts can track extraction success rates.

### Cost & Latency Impact

| | Per call | Per game (~400 advisor calls) |
|---|---|---|
| Pass 2 input | ~800 tokens | ~320K tokens |
| Pass 2 output | ~100 tokens | ~40K tokens |
| Pass 2 latency | ~500-1500ms (no thinking overhead) | — |

Cost scales with the bot's own model pricing — a Haiku bot's extraction is cheap, an Opus bot's is more expensive. But pass 2 is a short prompt with minimal output and no thinking tokens, so the per-call cost is a small fraction of pass 1. Total latency per build turn increases from ~7.3s to ~8-9s.

### Test Plan

**Unit tests (`BuildAdvisor.test.ts`):**
- Pass 1 returns valid JSON → pass 2 not called (existing behavior preserved)
- Pass 1 returns markdown prose → pass 2 called, returns valid schema
- Pass 1 returns prose, pass 2 also fails → returns null (fallback preserved)
- Pass 2 response has invalid waypoints → `validateWaypoints` still catches them
- Solvency retry path also uses extraction on parse failure

**Integration test (game log verification):**
- Run `scripts/analyse-build-advisor.ts` on a test game
- Verify `extractionUsed` appears in advisor diagnostics
- Verify success rate improves from 0% to >80%

## Out of Scope

- Changing the pass 1 advisor prompt or model selection
- Changing `findMoveTargets()` or A3 prepend logic (handled by JIRA-136)
- Removing the pre-advisor fallback path (keep as safety net)
- Addressing Haiku's 42% LLM validation failure rate for main turn decisions (separate issue — JIRA-133 prompt rework)

## Affected Files

- `src/server/services/ai/BuildAdvisor.ts` — extraction fallback in `advise()` and `retryWithSolvencyFeedback()`
- `src/server/services/ai/prompts/systemPrompts.ts` — add extraction prompt template
- `src/server/__tests__/ai/BuildAdvisor.test.ts` — new tests for extraction path
- `scripts/analyse-build-advisor.ts` — track extraction diagnostics
