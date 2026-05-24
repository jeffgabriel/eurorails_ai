# JIRA-135: Add OpenAI Provider (GPT-5.4 mini)

## Summary
Add OpenAI as a third LLM provider for bot play, using the GPT-5.4 model family. This follows the existing `ProviderAdapter` pattern used by `AnthropicAdapter` and `GoogleAdapter`.

## Motivation
- GPT-5.4 nano ($0.20/$1.25 per M tokens) is the cheapest capable model available — well below Haiku 4.5 ($0.80/$4)
- GPT-5.4 mini ($0.75/$4.50 per M) offers strong reasoning at competitive pricing
- GPT-5.4 ($TBD) available for hard tier if reasoning depth warrants it
- More provider diversity reduces single-vendor risk

## Scope

### Files to Create
- `src/server/services/ai/providers/OpenAIAdapter.ts` — implements `ProviderAdapter` interface against OpenAI Chat Completions API

### Files to Modify
- `src/shared/types/GameTypes.ts` — add `OpenAI = 'openai'` to `LLMProvider` enum; add OpenAI models to `LLM_DEFAULT_MODELS`
- `src/server/services/ai/LLMStrategyBrain.ts` — add `LLMProvider.OpenAI` case to `createAdapter()` factory (line ~569)
- `src/server/services/ai/AIStrategyEngine.ts` — update both `hasLLMApiKey()` (line ~1462) and `createBrain()` (line ~1472) to resolve `OPENAI_API_KEY` env var — both currently use a ternary that defaults to Anthropic; both must be refactored to a map/switch
- `src/client/lobby/features/lobby/BotConfigPopover.tsx` — add `OpenAI → 'OpenAI (GPT)'` display label in provider dropdown (line ~129); add friendly name mappings for bot name derivation: `'gpt-5.4-nano' → 'Nano'`, `'gpt-5.4-mini' → 'Mini'`, `'gpt-5.4' → 'GPT-5.4'` (line ~13)
- `package.json` — no SDK dependency needed (raw `fetch` like existing adapters)

### Test Files to Create/Modify
- `src/server/__tests__/ai/OpenAIAdapter.test.ts` — unit tests for the new adapter (mirror `AnthropicAdapter.test.ts` structure: successful chat, schema retry on 400, auth error, timeout, usage extraction)
- `src/server/__tests__/ai/LLMStrategyBrain.test.ts` — add OpenAI provider test cases to `createAdapter` tests
- `src/server/__tests__/lobbyBotRoutes.test.ts` — flip the existing test (line ~233) from asserting `openai` is rejected to asserting it is accepted

## Technical Design

### OpenAI Model Map
```
LLM_DEFAULT_MODELS[LLMProvider.OpenAI] = {
  Easy:   'gpt-5.4-nano',    // $0.20/$1.25 per M tokens — cheapest option
  Medium: 'gpt-5.4-mini',    // $0.75/$4.50 per M tokens — strong reasoning
  Hard:   'gpt-5.4-mini',    // start here; upgrade to gpt-5.4 after evaluation
}
```

### OpenAIAdapter Contract
Follow the exact same pattern as `AnthropicAdapter`:
- Constructor: `(apiKey: string, timeoutMs: number = 15000)`
- Implements `ProviderAdapter.chat()` with same request shape
- Uses raw `fetch` to `https://api.openai.com/v1/chat/completions`
- Maps request: `systemPrompt` → system message, `userPrompt` → user message
- Maps response: extracts `choices[0].message.content` → `text`, `usage.prompt_tokens`/`usage.completion_tokens` → `usage`
- Schema support: uses `response_format: { type: "json_schema", json_schema: { name: "game_action", schema: outputSchema, strict: true } }` — note: OpenAI requires a `name` field and `strict: true` in the `json_schema` object, unlike Anthropic/Google
- Response format: OpenAI returns `choices[0].message.content` as a plain string (not an array of parts like Anthropic/Google), so no thinking-block filtering is needed
- Schema rejection retry: on 400 with schema error, retry without `response_format`
- Error handling: reuses `ProviderTimeoutError`, `ProviderAPIError`, `ProviderAuthError` from `providers/errors.ts`
- Timeout: AbortController pattern identical to existing adapters

### Thinking/Effort Mapping
- GPT-5.4 models support `reasoning_effort` (low/medium/high) via the `reasoning` request parameter
- Map the existing `effort` param directly: `effort: "low"` → `reasoning: { effort: "low" }`, etc.
- The `thinking` param (Anthropic's adaptive thinking) has no OpenAI equivalent and should be silently ignored
- If `effort` is not provided, omit `reasoning` entirely (let OpenAI use its default)

### API Key Resolution
`AIStrategyEngine.ts` currently uses a ternary in **two places** (`hasLLMApiKey()` at line ~1462 and `createBrain()` at line ~1472) that defaults non-Google providers to `ANTHROPIC_API_KEY`. Both must be refactored to a shared map:
```
const ENV_KEY_MAP: Record<LLMProvider, string> = {
  [LLMProvider.Anthropic]: 'ANTHROPIC_API_KEY',
  [LLMProvider.Google]: 'GOOGLE_AI_API_KEY',
  [LLMProvider.OpenAI]: 'OPENAI_API_KEY',
};
```
Place this as a module-level constant and use it in both methods.

### Lobby Validation
The lobby route currently rejects `openai` as an invalid provider. The `LLMProvider` enum change will automatically make it valid since validation checks against enum values.

## Complexity Assessment

| Dimension | Score | Evidence |
|-----------|:-----:|----------|
| Blast Radius | 2 | ~6 files modified + 1 new adapter + 1 new test file |
| Dependency Depth | 2 | Adapter → LLMStrategyBrain → AIStrategyEngine (2 layers) |
| Conceptual Scope | 1 | Single concern: add new provider following existing pattern |
| Pattern Complexity | 1 | Clean ProviderAdapter interface; both existing adapters follow identical pattern |
| Testing Surface | 2 | New OpenAIAdapter.test.ts + updates to LLMStrategyBrain and lobby tests |
| **Total** | **8** | **Standard** |

## Risk / Open Questions
1. **Structured output compatibility** — OpenAI requires `name` and `strict: true` in `json_schema` objects. The `name` field must be a valid identifier (alphanumeric + underscores). Need to verify our game action schemas comply with OpenAI's strict mode constraints (e.g., all properties must be required, `additionalProperties: false` on all objects).
2. **Hard tier upgrade path** — Starting with `gpt-5.4-mini` for Hard tier. After evaluation, may upgrade to `gpt-5.4` if reasoning depth warrants the cost increase.
3. **Rate limits** — OpenAI rate limits differ from Anthropic/Google. The existing retry logic in `LLMStrategyBrain` should handle 429s, but worth verifying.
4. **Reasoning effort support** — GPT-5.4 models support `reasoning_effort` but behavior may differ from Anthropic/Google thinking modes. Monitor output quality across effort levels.
