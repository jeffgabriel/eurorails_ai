# JIRA-2: Remove Bot Archetypes

## Motivation

The archetype system (Opportunist, Balanced, Builder First, etc.) prepends a personality prompt to every LLM call. This causes two problems:

1. **Bad strategic decisions.** The Opportunist archetype told the LLM to "chase the highest immediate payout available" and "re-evaluate ALL demands every turn." On turn 3, this led it to plan Cork @ Sevilla -> Oslo (73M payout) — an impossible cross-continent delivery with $14M in the bank. The personality override the strategic reasoning the common prompt was trying to enforce.

2. **Unnecessary complexity.** Five archetype prompts (150+ lines) that multiply the test matrix but provide no measurable gameplay benefit. The real strategic differentiation should come from the skill-level modifier and the common rules/heuristics, not a personality veneer that can override them.

## Change Summary

Remove the `BotArchetype` enum and all archetype-specific personality prompts. The LLM system prompt becomes: `COMMON_SYSTEM_SUFFIX + SKILL_LEVEL_TEXT[skillLevel]` (the game rules + skill modifier that already exist). The `BotConfig` interface drops its `archetype` field. The UI drops the archetype selector and badge.

## Files to Change

### 1. Shared Types — `src/shared/types/GameTypes.ts`

| Line(s) | Change |
|---------|--------|
| 25-31 | **Delete** `BotArchetype` enum entirely |
| 52-60 | **Remove** `archetype: BotArchetype` from `BotConfig` interface |
| 511-522 | **Remove** `archetype: BotArchetype` from `LLMStrategyConfig` interface |

### 2. System Prompts — `src/server/services/ai/prompts/systemPrompts.ts`

This is the largest single change.

| Line(s) | Change |
|---------|--------|
| 8 | Remove `BotArchetype` from import |
| 12-131 | **Delete** all 6 archetype prompt constants: `BACKBONE_BUILDER_PROMPT`, `FREIGHT_OPTIMIZER_PROMPT`, `TRUNK_SPRINTER_PROMPT`, `CONTINENTAL_CONNECTOR_PROMPT`, `OPPORTUNIST_PROMPT`, `BLOCKER_PROMPT` |
| 289-295 | **Delete** `ARCHETYPE_PROMPTS` mapping |
| 302-311 | **Simplify** `getSystemPrompt` — remove `archetype` parameter, return `COMMON_SYSTEM_SUFFIX + '\n\n' + SKILL_LEVEL_TEXT[skillLevel]` |
| 319-328 | **Simplify** `getRoutePlanningPrompt` — remove `archetype` parameter, return `ROUTE_PLANNING_SYSTEM_SUFFIX + '\n\n' + SKILL_LEVEL_TEXT[skillLevel]` |
| 336-345 | **Simplify** `getPlanSelectionPrompt` — remove `archetype` parameter, return `PLAN_SELECTION_SYSTEM_SUFFIX + '\n\n' + SKILL_LEVEL_TEXT[skillLevel]` |

New signatures:
```typescript
export function getSystemPrompt(skillLevel: BotSkillLevel): string;
export function getRoutePlanningPrompt(skillLevel: BotSkillLevel): string;
export function getPlanSelectionPrompt(skillLevel: BotSkillLevel): string;
```

### 3. LLMStrategyBrain — `src/server/services/ai/LLMStrategyBrain.ts`

| Line | Change |
|------|--------|
| 61 | Update `getSystemPrompt(config.archetype, config.skillLevel)` -> `getSystemPrompt(config.skillLevel)` |
| ~179 | Update `getRoutePlanningPrompt(this.config.archetype, this.config.skillLevel)` -> `getRoutePlanningPrompt(this.config.skillLevel)` |

Also update any `getPlanSelectionPrompt` call similarly (search for all 3 prompt function calls in this file).

### 4. AIStrategyEngine — `src/server/services/ai/AIStrategyEngine.ts`

| Line | Change |
|------|--------|
| 28 | Remove `BotArchetype` from import |
| 427 | **Delete** `const archetype = (botConfig.archetype as BotArchetype) ?? BotArchetype.Balanced;` |
| 431 | Remove `archetype` from the `LLMStrategyBrain` constructor config object |

### 5. WorldSnapshotService — `src/server/services/ai/WorldSnapshotService.ts`

| Line | Change |
|------|--------|
| ~75 | Remove `archetype: rawConfig.archetype ?? 'balanced'` from botConfig construction |

### 6. Lobby Routes — `src/server/routes/lobbyRoutes.ts`

| Line(s) | Change |
|---------|--------|
| 3 | Remove `BotArchetype` from import |
| 442 | Remove `archetype` from destructured `req.body` |
| 444 | Remove `archetype` from log call |
| 452 | Remove `archetype` from `validateRequiredFields` |
| 466-481 | **Delete** entire `resolvedArchetype` block (random resolution + enum validation) |
| 493 | Remove `archetype` from `BotConfig` construction: `{ skillLevel, name }` |

### 7. Lobby Service — `src/server/services/lobbyService.ts`

| Line | Change |
|------|--------|
| 6 | Remove `BotArchetype` from import |
| ~939 | **Delete** the `validArchetypes` check and its error throw |

### 8. Client — UI Components (4 files)

#### `src/client/lobby/features/lobby/BotConfigPopover.tsx`
- Remove `BotArchetype` from import (line 4)
- Remove `getArchetypeDisplay` from import (line 5)
- **Delete** `archetype` state variable (line 21), its reset in handleClose (line 31), and its inclusion in the onAddBot call (line 45)
- **Delete** the entire "Play Style" `<Select>` dropdown block (lines 103-119)

#### `src/client/lobby/features/lobby/GameRow.tsx`
- Remove `BotArchetype` import (line 7) and `getArchetypeDisplay` import (line 8)
- **Delete** `archetypeDisplay` const and its usage in the badge JSX (lines 25-27, 67-69)

#### `src/client/lobby/components/bot/ArchetypeBadge.tsx`
- **Delete entire file** — no longer needed

#### `src/client/lobby/shared/botDisplayUtils.ts`
- Remove `BotArchetype` from import (line 1)
- Remove `lucide-react` icon imports for archetype icons: `Swords, Shield, Scale, Eye, Hammer` (line 2) — keep any icons still used elsewhere
- **Delete** `ArchetypeDisplay` interface (lines 4-10)
- **Delete** `ARCHETYPE_DISPLAY` record (lines 12-48)
- **Delete** `getArchetypeDisplay` function (lines 50-52)

#### `src/client/lobby/components/bot/StrategyInspectorModal.tsx`
- Remove `ArchetypeBadge` import (line 10)
- **Delete** `ARCHETYPE_PHILOSOPHY` record (lines 32-38)
- Remove `archetypeName` and `archetypeRationale` from the audit interface (lines 65, 69)
- Remove the `ArchetypeBadge` JSX and philosophy display (lines 351-352, 360-382)

#### `src/client/lobby/store/lobby.store.ts`
- Remove `archetype` from `addBot` signature (line 35) and its mock implementation (line 576)

#### `src/client/lobby/shared/api.ts`
- Remove `archetype` from `addBot` signature and request body (line 222)

#### `src/client/__tests__/DebugOverlay.test.ts`
- Remove `archetype: 'balanced' as any` from botConfig fixture (line 32)

### 9. Server Tests (4 files)

#### `src/server/__tests__/lobbyBotService.test.ts`
- Remove `BotArchetype` import (line 13)
- Remove `archetype: BotArchetype.Opportunistic` from default config (line 46)
- Remove/update the "should throw for invalid archetype" test (line 200-205) — **delete it**
- Update any remaining `BotConfig` fixtures to drop `archetype`

#### `src/server/__tests__/ai/LLMStrategyBrain.test.ts`
- Remove `BotArchetype` import (line 7)
- Remove `archetype: BotArchetype.Balanced` from config fixtures (lines 149, 279)

#### `src/server/__tests__/ai/AIStrategyEngine.test.ts`
- Remove `archetype: 'balanced'` from all `botConfig` objects in test fixtures (multiple locations)

#### `src/server/__tests__/movementFixtures.ts`
- Remove `BotArchetype` import (line 23)
- Remove `archetype` parameter and its usage from fixture helper (lines 212-214)

### 10. Database — No Migration Needed

The `bot_config` column (migration `030_add_bot_columns.sql`) is `JSONB`. Existing rows will retain their `archetype` field harmlessly — JSON columns don't enforce schema. No migration required; the field simply becomes ignored. Optionally, a cleanup migration can strip it:

```sql
UPDATE players SET bot_config = bot_config - 'archetype' WHERE bot_config ? 'archetype';
```

## Implementation Order

1. **Types first** — Remove from `GameTypes.ts` (BotArchetype enum, BotConfig, LLMStrategyConfig). This will cause compile errors everywhere archetype is referenced, giving a checklist.
2. **Prompts** — Simplify `systemPrompts.ts` (delete archetype prompts, simplify function signatures).
3. **Server services** — Update `LLMStrategyBrain.ts`, `AIStrategyEngine.ts`, `WorldSnapshotService.ts`.
4. **Lobby** — Update `lobbyRoutes.ts`, `lobbyService.ts`.
5. **Client UI** — Update/delete components, store, api.
6. **Tests** — Fix all test fixtures.
7. **Build + test** — `npm run build && npm test`

## Verification

1. `npm run build` — compiles clean (no references to `BotArchetype` remain)
2. `npm test` — all tests pass
3. `grep -r "BotArchetype\|archetype" src/` — zero hits (excluding comments/docs)
4. Manual: Create a game, add a bot (no archetype dropdown), bot plays with skill-level-only prompt
