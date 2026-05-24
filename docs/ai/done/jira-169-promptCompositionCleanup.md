# JIRA-169: LLM Prompt Composition Cleanup

## Problem
The system and user prompts sent to the LLM contain low-value, redundant, or misleading sections that waste context tokens and may degrade decision quality.

## Bugs / Changes

### 1. Strategy Brain system prompt includes casual player instruction
- **File:** `src/server/services/ai/prompts/systemPrompts.ts`
- **Issue:** Easy skill level includes "You are a casual player. Pick whatever seems good. Don't overthink it." — this adds no value and may actively harm decision quality.
- **Fix:** Remove the casual player instruction from the easy skill level modifier.

### 2. Strategy Brain user prompt: Victory Progress section is redundant
- **File:** `src/server/services/ai/ContextBuilder.ts` (serializePrompt)
- **Issue:** Victory progress (connected cities count, cash toward 250M goal) is already conveyed in the game state header. Repeating it wastes tokens.
- **Fix:** Remove the dedicated Victory Progress section from the user prompt.

### 3. Strategy Brain user prompt: Nearby Cities section is useless and misleading
- **File:** `src/server/services/ai/ContextBuilder.ts` (serializePrompt)
- **Issue:** Lists cities near the bot's current position, but this information doesn't help the LLM make strategic decisions — it can lead to irrelevant detours.
- **Fix:** Remove the Nearby Cities section from the user prompt.

### 4. Strategy Brain user prompt: Unconnected Demand Cities is useless
- **File:** `src/server/services/ai/ContextBuilder.ts` (serializePrompt)
- **Issue:** Lists demand cities not yet connected to the bot's network, but without route cost or feasibility context this is noise.
- **Fix:** Remove the Unconnected Demand Cities section from the user prompt.

### 5. Remove legacy Strategy Action Decision LLM call
- **File:** `src/server/services/ai/LLMStrategyBrain.ts` (`decideAction()`)
- **Issue:** The `decideAction()` method and its associated `serializePrompt()` user prompt builder are superseded by TripPlanner. Dead code that inflates the codebase and its prompts (serializePrompt has 14 sections) are never called in the main turn flow.
- **Fix:** Remove `decideAction()` from LLMStrategyBrain, remove `serializePrompt()` from ContextBuilder, and clean up the `ACTION_SCHEMA` from schemas.ts. Remove `getSystemPrompt()` from systemPrompts.ts if no longer referenced.

## Status
- [ ] Remove casual player instruction from systemPrompts.ts
- [ ] Remove Victory Progress section from ContextBuilder.serializePrompt
- [ ] Remove Nearby Cities section from ContextBuilder.serializePrompt
- [ ] Remove Unconnected Demand Cities section from ContextBuilder.serializePrompt
- [ ] Remove legacy decideAction() and associated dead code
