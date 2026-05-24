# PRD: JIRA-17 Structured Outputs + Extended Thinking

## Problem Statement

The AI bot's Anthropic API integration uses basic text completion with manual JSON parsing and small token budgets (200-400 tokens). This causes two problems:

1. **Parse failures**: The LLM sometimes returns malformed JSON, wasting retry cycles (up to 3 per decision) and falling back to regex extraction or heuristic actions.
2. **Shallow reasoning**: Route planning requires evaluating 9 demands across geographic regions, budget constraints, and multi-stop logistics — 200-400 tokens is insufficient for strategic depth.

## Goals

- Eliminate JSON parse failures on the Anthropic path by enforcing schemas at the API level
- Enable deeper strategic reasoning for route planning via extended thinking
- Scale reasoning effort by bot difficulty level and decision type
- Maintain backward compatibility with Google/Gemini adapter

## Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| R1 | Anthropic API calls use `output_config.format` with JSON schemas for action and route responses | Must |
| R2 | Anthropic API calls use `thinking: {type: "adaptive"}` with effort levels scaled by decision type | Must |
| R3 | Response extraction handles thinking blocks and extracts only the text block | Must |
| R4 | Token budgets increase to accommodate thinking: route=8K-16K, action=2K-8K by skill | Must |
| R5 | ResponseParser simplifies for Anthropic path — structured output guarantees valid JSON | Should |
| R6 | ProviderAdapter interface extends with optional structured output and thinking parameters | Must |
| R7 | GoogleAdapter remains unchanged — ignores new optional fields | Must |
| R8 | All existing tests pass with updated logic; new tests cover structured output response shapes | Must |

## Acceptance Criteria

- [ ] Route planning calls include JSON schema and adaptive thinking with effort "high"
- [ ] Turn-by-turn action calls include JSON schema and adaptive thinking with effort "medium"
- [ ] Thinking content blocks are correctly extracted and discarded (only text block used)
- [ ] Parse failures on Anthropic path drop to zero (schema guarantees valid JSON)
- [ ] GoogleAdapter behavior is completely unchanged
- [ ] Token usage tracking correctly reports thinking tokens separately from output tokens
- [ ] All 89 ContextBuilder tests, all LLMStrategyBrain tests, and all ResponseParser tests pass

## Scope

### In Scope
- AnthropicAdapter: structured output config + thinking params + multi-block response extraction
- LLMStrategyBrain: token budgets, effort maps, schema constants, conditional params by provider
- ResponseParser: fast path for pre-validated JSON
- ProviderAdapter interface: optional new fields

### Out of Scope
- GoogleAdapter changes (Gemini has a separate structured output API — different ticket)
- Few-shot examples in system prompts (separate enhancement)
- XML tag restructuring of ContextBuilder prompts (separate enhancement)
- Prompt content changes (system prompt text unchanged)

## Success Metrics
- Zero parse failures on Anthropic path (currently ~5-10% of calls hit regex fallback)
- Route planning quality improvement measurable via manual game observation
- No regression in existing test suite
