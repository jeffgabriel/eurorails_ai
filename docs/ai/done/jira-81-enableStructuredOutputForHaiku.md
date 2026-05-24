# JIRA-81: Re-enable Structured Output for Haiku (Easy Bots)

## Bug Summary

Structured output (JSON schema mode) and extended thinking are disabled for Easy-level bots (Haiku) at `LLMStrategyBrain.ts:271`: `const useAdvancedFeatures = this.config.skillLevel !== BotSkillLevel.Easy`. This was done because Haiku sometimes returned markdown-wrapped JSON when schema mode was active (JIRA-70). However, disabling schema enforcement entirely is far worse — Haiku now produces:

1. **Truncated JSON** — verbose reasoning text before JSON eats the response budget
2. **Hallucinated delivery cities** — confuses which load goes to which city without schema constraints
3. **Invalid action formats** — `"route": "DISCARD_HAND"` (string instead of array)
4. **Free-text paragraphs** instead of JSON

## Observed Behavior

Game `9126f0b3`, Haiku bot (94b6428f), turns 10-13:
- 4 consecutive turns of complete LLM failure, all falling back to heuristics
- 5/12 LLM attempts were truncated JSON parse errors
- 4/12 attempts were hallucinated delivery cities (Bauxite to Wien/Beograd — no such demand cards)
- 1 attempt was `"route": "DISCARD_HAND"` string
- 1 attempt was a plain English paragraph
- Bot's cash dropped from 33M to 5M while accomplishing nothing

## Root Cause

`LLMStrategyBrain.ts:271` disables `outputSchema`, `thinking`, and `effort` for Easy bots. Without schema enforcement, Haiku has no structural guardrails and produces invalid output in the majority of attempts.

The original reason for disabling (JIRA-70: markdown-wrapped JSON) is already handled by `ResponseParser`'s markdown fence stripping. The cure is now worse than the disease.

## Fix Plan

Re-enable structured output for Easy/Haiku by removing the skill-level gate:

```typescript
// Before (line 271-283):
const useAdvancedFeatures = this.config.skillLevel !== BotSkillLevel.Easy;
const response = await this.adapter.chat({
  ...
  ...(useAdvancedFeatures && {
    outputSchema: ROUTE_SCHEMA,
    thinking: { type: 'adaptive' },
    effort: ROUTE_EFFORT[this.config.skillLevel],
  }),
});

// After:
const response = await this.adapter.chat({
  ...
  outputSchema: ROUTE_SCHEMA,
  thinking: { type: 'adaptive' },
  effort: ROUTE_EFFORT[this.config.skillLevel],
});
```

Also apply the same fix to `decideAction()` at line ~130 which has the same `useAdvancedFeatures` gate for ACTION_SCHEMA.

The AnthropicAdapter already has automatic fallback on 400 errors (removes schema and retries), so if the API ever rejects the schema for Haiku, it degrades gracefully.

## Key Files

- `src/server/services/ai/LLMStrategyBrain.ts:271` — useAdvancedFeatures gate for planRoute
- `src/server/services/ai/LLMStrategyBrain.ts:~130` — useAdvancedFeatures gate for decideAction
- `src/server/services/ai/providers/AnthropicAdapter.ts:48-52` — json_schema format
- `src/server/services/ai/providers/AnthropicAdapter.ts:68-88` — 400 error fallback
- `src/server/services/ai/ResponseParser.ts` — markdown fence stripping (JIRA-70)
