# PRD: JIRA-18 Gemini 3 Thinking Support + Model Upgrade

## Problem Statement

The GoogleAdapter currently passes only basic `systemPrompt`, `userPrompt`, `maxTokens`, and `temperature` to the Gemini API. Meanwhile, the AnthropicAdapter sends structured output schemas and adaptive thinking configuration on every LLM call. This creates a significant capability gap:

1. **No thinking/reasoning**: Gemini receives no thinking configuration, producing shallower strategic decisions compared to Anthropic at the same skill level.
2. **No structured output enforcement**: Gemini relies entirely on prompt-based JSON instructions, leading to higher parse failure rates and more retry cycles.
3. **Outdated models**: The current Gemini models (`gemini-2.0-flash`, `gemini-2.5-flash`, `gemini-2.5-pro`) are a generation behind. Gemini 3 models offer native thinking support with `thinkingLevel` control.

## Goals

- Upgrade Google models from Gemini 2.x to Gemini 3 family
- Enable thinking/reasoning on the Gemini path scaled by bot skill level
- Remove the Anthropic-specific gating so both providers receive thinking configuration uniformly
- Handle the Gemini 3 constraint that structured output and thinking cannot be used simultaneously

## New Model Lineup

| Skill Level | Current Model | New Model | Thinking Level |
|-------------|--------------|-----------|----------------|
| Easy | `gemini-2.0-flash` | `gemini-3-flash-preview` | `low` |
| Medium | `gemini-2.5-flash` | `gemini-3-pro-preview` | `medium` |
| Hard | `gemini-2.5-pro` | `gemini-3.1-pro-preview` | `high` |

## Key Constraint: Structured Output + Thinking Incompatibility

On Gemini 3 models, using `responseSchema` (structured output) and `thinkingConfig` (thinking) together causes nil responses. Since thinking is always-on and cannot be disabled on Gemini 3, structured output must be skipped. The existing `ResponseParser` already handles free-form JSON via regex fallback, so this is safe.

## Gemini 3 Thinking API

Gemini 3 uses `thinkingLevel` (semantic levels) instead of `thinkingBudget` (token counts) used by Gemini 2.5:

| Parameter | Gemini 2.5 | Gemini 3+ |
|-----------|-----------|-----------|
| Config field | `thinkingConfig.thinkingBudget` | `thinkingConfig.thinkingLevel` |
| Values | Token count (`-1` = dynamic) | `"minimal"`, `"low"`, `"medium"`, `"high"` |
| Disabling | `thinkingBudget: 0` | Not possible — always on |

Thinking response parts include `{ thought: true }` flag and must be filtered out to extract the actual response text.

## Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| R1 | Default Google models updated to Gemini 3 family as specified in the model lineup table | Must |
| R2 | GoogleAdapter sends `thinkingConfig` with `thinkingLevel` mapped from the effort level in the thinking config | Must |
| R3 | GoogleAdapter skips structured output (`responseMimeType`/`responseSchema`) for Gemini 3 models to avoid nil response issue | Must |
| R4 | GoogleAdapter response parsing filters out thinking parts (`thought: true`) and extracts only non-thought text | Must |
| R5 | `LLMStrategyBrain` passes `outputSchema` and `thinking` to all providers unconditionally (remove `isAnthropic` gating) | Must |
| R6 | GoogleAdapter detects model generation from model name to apply correct thinking format (thinkingLevel for 3+, thinkingBudget for 2.5) | Must |
| R7 | GoogleAdapter supports schema-rejection retry for Gemini 2.5 models (fallback if schema rejected on 400) | Should |
| R8 | All existing tests pass; new tests cover thinking config, response parsing with thought blocks, and model generation detection | Must |

## Acceptance Criteria

- [ ] Google bot at Hard skill level uses `gemini-3.1-pro-preview` with `thinkingLevel: "high"`
- [ ] Google bot at Medium skill level uses `gemini-3-pro-preview` with `thinkingLevel: "medium"`
- [ ] Google bot at Easy skill level uses `gemini-3-flash-preview` with `thinkingLevel: "low"`
- [ ] Thinking content (parts with `thought: true`) is correctly filtered from Gemini 3 responses
- [ ] No `responseMimeType` or `responseSchema` is sent to Gemini 3 models
- [ ] `isAnthropic` checks removed from `LLMStrategyBrain` — both providers receive thinking and schema params uniformly
- [ ] AnthropicAdapter behavior is completely unchanged
- [ ] All existing GoogleAdapter, AnthropicAdapter, LLMStrategyBrain, and ResponseParser tests pass
- [ ] New tests verify thinking config format, thought-part filtering, and model generation detection

## Scope

### In Scope
- GoogleAdapter: thinking config, response parsing for thought blocks, model generation detection
- LLMStrategyBrain: remove provider-specific gating for schema and thinking
- Default model configuration: update to Gemini 3 models
- GoogleAdapter tests: thinking, response parsing, model detection

### Out of Scope
- Gemini structured output (blocked by thinking incompatibility — revisit if Google resolves)
- Prompt content changes (system prompt text unchanged)
- AnthropicAdapter changes (already has full structured output + thinking support from JIRA-17)
- Gemini-specific prompt optimizations or few-shot examples

## Success Metrics
- Gemini bots use thinking on all decisions (currently 0% of calls include thinking config)
- Decision quality improvement for Google-backed bots measurable via manual game observation
- No regression in parse success rate (ResponseParser regex fallback continues to handle free-form JSON)
- No regression in existing test suite
