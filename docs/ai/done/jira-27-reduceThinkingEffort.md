# (done in CC) JIRA-27: Reduce Extended Thinking Effort for Faster Bot Gameplay

## Problem
Bot turns at Medium and Hard skill levels take too long due to extended thinking effort levels. The high effort setting causes Anthropic's adaptive thinking to spend significantly more time reasoning, which slows down the game experience.

## Current Configuration

Located in `src/server/services/ai/LLMStrategyBrain.ts`:

| Skill Level | Action Effort | Route Effort | Action Max Tokens | Route Max Tokens |
|-------------|--------------|-------------|-------------------|-----------------|
| Easy        | low          | medium      | 2,048             | 8,192           |
| Medium      | medium       | high        | 4,096             | 12,288          |
| Hard        | high         | high        | 8,192             | 16,384          |

## Change: Drop All Effort Levels by One Tier

| Skill Level | Action Effort | Route Effort | Action Max Tokens | Route Max Tokens |
|-------------|--------------|-------------|-------------------|-----------------|
| Easy        | low          | low         | 2,048             | 8,192           |
| Medium      | low          | medium      | 4,096             | 12,288          |
| Hard        | medium       | medium      | 8,192             | 16,384          |

### Rationale
- `high` effort is the biggest time contributor — dropping to `medium` for Hard should noticeably speed up turns
- `medium` effort is sufficient for game-quality strategic decisions
- Easy was already at `low` for actions; route planning drops from `medium` to `low`
- Token budgets remain unchanged — this only affects thinking depth, not output length

## Scope
- **Single file change**: `src/server/services/ai/LLMStrategyBrain.ts`
- **Lines affected**: ~53-64 (ACTION_EFFORT and ROUTE_EFFORT constants)
- **No test changes needed** — effort levels are config values, not logic
- **Risk**: Low — purely a tuning change, easily reversible

## Acceptance Criteria
- AC-1: ACTION_EFFORT values are `low / low / medium` for Easy / Medium / Hard
- AC-2: ROUTE_EFFORT values are `low / medium / medium` for Easy / Medium / Hard
- AC-3: All existing LLMStrategyBrain tests pass without modification
- AC-4: No other files require changes
