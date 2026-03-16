# JIRA-63: Propagate llmLog on Heuristic Fallback

## Bug Description

When `planRoute()` exhausts all retry attempts and returns `null`, the heuristic fallback decision object in `AIStrategyEngine.ts` (lines 217-224) is built **without `llmLog`**. All diagnostic information about what actually failed (parse errors, rate limits, validation failures) is discarded, making LLM failures a black box.

## Evidence

### Game `be09cd45`, Haiku (claude-haiku-4-5), T21-T23:
- 3 consecutive heuristic-fallback turns, all with `llmLog: null`
- Cash stable at 34M — not a budget issue
- Cannot determine actual failure cause (parse error? rate limit? validation?)

### Game `055beb1f`, Haiku, T6-T8:
- Same symptom: 3 consecutive fallback turns with no `llmLog`

## Root Cause

`LLMStrategyBrain.planRoute()` maintains an internal `llmLog: LlmAttempt[]` array during its retry loop, recording each attempt's status, error, and response text. But when all retries fail and the method returns `null`, the log is never exposed to the caller.

The fallback path in `AIStrategyEngine.takeTurn()` builds a decision object that omits `llmLog`:

```typescript
// AIStrategyEngine.ts lines 217-224
decision = {
  plan: fallback.plan,
  reasoning: `[heuristic-fallback] LLM planning failed — heuristic produced ${fallback.plan.type}`,
  model: 'heuristic-fallback',
  latencyMs: 0,
  retried: false,
  // ❌ NO llmLog FIELD
};
```

## Fix

1. Change `planRoute()` return type to always include `llmLog` — return `{ route: null, llmLog }` instead of just `null`
2. Include the `llmLog` in the heuristic fallback decision object
3. This surfaces failure details in both the debug overlay and NDJSON game logs

## Affected Files

- `src/server/services/ai/LLMStrategyBrain.ts` — `planRoute()` return type
- `src/server/services/ai/AIStrategyEngine.ts` — heuristic fallback decision (lines 217-224)

## Impact

Every LLM failure is currently invisible. With this fix, rate limits, parse errors, validation failures, and auth issues become diagnosable from the game log alone. Observed in 2 separate games across 6 total turns.
