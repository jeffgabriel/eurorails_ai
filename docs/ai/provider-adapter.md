# ProviderAdapter Interface

The `ProviderAdapter` interface abstracts LLM provider APIs behind a unified `chat()` method. Two implementations exist:

- **AnthropicAdapter** — Claude models via the Anthropic Messages API
- **GoogleAdapter** — Gemini models via the Google Generative Language API

## chat() Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | `string` | Yes | Model identifier (e.g., `claude-sonnet-4-20250514`) |
| `maxTokens` | `number` | Yes | Maximum response tokens |
| `temperature` | `number` | Yes | Sampling temperature (0–1) |
| `systemPrompt` | `string` | Yes | System-level instructions |
| `userPrompt` | `string` | Yes | User/game-state prompt |
| `outputSchema` | `object` | No | JSON schema for structured output (Anthropic only) |
| `thinking` | `ThinkingConfig` | No | Adaptive thinking config (Anthropic only) |
| `timeoutMs` | `number` | No | Per-request timeout override in ms |

## Structured Output (`outputSchema`)

When provided, AnthropicAdapter wraps the schema in `output_config.format.json_schema` in the API request body. The model returns a response conforming to the schema.

If the API rejects the schema (400 error with schema-related keywords), AnthropicAdapter automatically retries without `output_config`.

GoogleAdapter ignores this parameter.

```typescript
const schema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['BUILD', 'MOVE', 'PASS'] },
    reasoning: { type: 'string' },
  },
  required: ['action', 'reasoning'],
};

const response = await adapter.chat({
  model: 'claude-sonnet-4-20250514',
  maxTokens: 4096,
  temperature: 0.4,
  systemPrompt: 'You are a strategic bot.',
  userPrompt: gameStatePrompt,
  outputSchema: schema,
});
```

Two schemas are defined in `src/server/services/ai/schemas.ts`:
- **ACTION_SCHEMA** — for turn action decisions (single or multi-action)
- **ROUTE_SCHEMA** — for strategic route planning

## Adaptive Thinking (`thinking`)

When provided, AnthropicAdapter includes the `thinking` field in the API request body. This enables the model to perform extended reasoning (visible as `type: "thinking"` blocks in the response) before generating the text response.

GoogleAdapter ignores this parameter.

```typescript
const response = await adapter.chat({
  model: 'claude-sonnet-4-20250514',
  maxTokens: 8192,
  temperature: 0.4,
  systemPrompt: 'Plan carefully.',
  userPrompt: routePlanningPrompt,
  thinking: { type: 'adaptive', effort: 'high' },
});
```

### Effort Levels

| Effort | Use Case | Token Impact |
|--------|----------|-------------|
| `low` | Simple decisions (Easy bots) | Minimal overhead |
| `medium` | Standard decisions (Medium bots, Easy route planning) | Moderate overhead |
| `high` | Complex decisions (Hard bots, Medium/Hard route planning) | Higher overhead |

Effort is mapped per skill level in `LLMStrategyBrain`:
- **Action decisions**: Easy→low, Medium→medium, Hard→high
- **Route planning**: Easy→medium, Medium→high, Hard→high

## Per-Request Timeout (`timeoutMs`)

Overrides the adapter's constructor default for a single call. Used by `LLMStrategyBrain.planRoute()` which sets `timeoutMs: 30000` for the longer route planning calls.

## Multi-Block Response Handling

When thinking is enabled, Anthropic responses contain multiple content blocks:
- `{ type: "thinking", thinking: "..." }` — reasoning (discarded)
- `{ type: "text", text: "..." }` — the actual response (extracted)

AnthropicAdapter extracts only the first `type: "text"` block. If no text block exists, it returns an empty string.
