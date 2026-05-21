# JIRA-4: Give LLM Victory-Aware Context

## Motivation

The LLM knows the victory rule ("250M+ cash AND 7 of 8 major cities connected") from the system prompt, and sees its current progress ("Major cities connected: 3/8 (Paris, Berlin, Ruhr)") in the user prompt. But it gets **zero strategic guidance** about how to close the gap.

This causes two problems:

1. **No late-game pivot.** A bot with 5/7 cities and 200M cash continues chasing high-payout deliveries instead of spending 10M to connect the last 2 cities. It doesn't know *which* cities are missing or *how far* they are from its network.

2. **No victory-aware routing.** When planning routes, the LLM never considers "this delivery goes through Wien — I should build through Wien to pick up a major city connection." The route planning prompt has no concept of which unconnected cities are near planned routes.

### What the LLM Currently Receives

**System prompt** (static, same every turn):
```
Victory: 250M+ ECU cash AND track connecting 7 of 8 major cities
```

**User prompt** (dynamic, per turn):
```
YOUR STATUS:
- Cash: 180M ECU (minimum reserve: 5M)
- Major cities connected: 5/8 (Paris, Berlin, Ruhr, Holland, London)
```

### What's Missing

| Gap | Impact |
|-----|--------|
| **Which cities are NOT connected** | LLM must mentally diff "5/8 (Paris, Berlin, Ruhr, Holland, London)" against the full list of 8 to figure out what's missing. Easy for humans, error-prone for LLMs. |
| **Estimated cost to connect each missing city** | LLM has no way to know if connecting Madrid costs 5M (close to network) or 40M (far away). Can't prioritize. |
| **Cash remaining to reach 250M** | LLM sees "Cash: 180M" but doesn't compute "I need 70M more." Combined with build costs, it can't plan whether to earn first or build first. |
| **Phase-appropriate strategic directive** | In Late Game (5+ cities, 150M+), the prompt should explicitly say "prioritize connecting remaining cities" instead of the generic "think 2-3 turns ahead." |
| **Victory-aware route suggestions** | Route planning doesn't say "Wien is 8M from your network and on the path to your delivery — route through it." |

## Proposed Fix

### Change 1: Add victory progress section to user prompt

**File**: `src/server/services/ai/ContextBuilder.ts` — `serializePrompt()` method

Add a new `VICTORY PROGRESS` section after `YOUR STATUS`, computed from existing `GameContext` fields plus new data:

```
VICTORY PROGRESS:
- Cash: 180M / 250M needed (70M remaining — ~3 deliveries)
- Cities connected: 5/7 needed (Paris, Berlin, Ruhr, Holland, London)
- Cities NOT connected: Wien (~8M to connect), Madrid (~15M), Roma (~12M)
- Nearest unconnected city: Wien (~8M from your network)
- STRATEGIC PRIORITY: Connect Wien (cheapest) while pursuing deliveries through that corridor.
```

### Change 2: Add victory-aware strategic directives by game phase

**File**: `src/server/services/ai/ContextBuilder.ts` — `serializePrompt()` method

After the victory progress section, add phase-appropriate directives:

| Phase | Trigger | Directive |
|-------|---------|-----------|
| Early Game | <3 cities, <80M | *(no victory directive — focus on first deliveries)* |
| Mid Game | 3-4 cities, 80-149M | `"MID-GAME: Start routing deliveries through unconnected major cities when possible. Every major city you pass through counts toward victory."` |
| Late Game | 5+ cities, 150M+ | `"LATE-GAME PRIORITY: You need N more cities and XM more cash. Connect [cheapest city] (~YM) before chasing deliveries. Victory is within reach."` |
| Victory Imminent | 6+ cities, 230M+ | `"VICTORY IS IMMINENT: Connect [last city] (~YM) and earn ZM more. Do NOT discard hand or take unnecessary risks."` |

### Change 3: Add unconnected city cost estimates to GameContext

**File**: `src/server/services/ai/ContextBuilder.ts` — `build()` method

Compute estimated track cost from the bot's network to each unconnected major city. Reuses the existing `estimateTrackCost()` method which already does hex-distance-based estimation from track endpoints.

New field on `GameContext`:
```typescript
unconnectedMajorCities: Array<{
  cityName: string;
  estimatedCost: number;  // estimated track cost from current network
}>;
```

**File**: `src/shared/types/GameTypes.ts` — `GameContext` interface

Add the new field to the type definition.

### Change 4: Victory-aware route nudge in route planning prompt

**File**: `src/server/services/ai/ContextBuilder.ts` — `serializePrompt()` method

When rendering demand cards in the prompt, annotate demands whose delivery or supply city is near an unconnected major city:

```
Card 1:
  a) Wine from Bordeaux → Wien (25M) — VICTORY BONUS: route passes near Wien (unconnected, ~8M to connect)
  b) Coal from Essen → Madrid (18M)
```

This nudges the LLM to prefer routes that also advance the victory condition, without overriding its strategic judgment.

## Files to Change

### 1. `src/shared/types/GameTypes.ts`

| Change | Detail |
|--------|--------|
| Add field to `GameContext` | `unconnectedMajorCities: Array<{ cityName: string; estimatedCost: number }>` |

### 2. `src/server/services/ai/ContextBuilder.ts`

| Method | Change |
|--------|--------|
| `build()` | Compute `unconnectedMajorCities` by diffing all major city names against `connectedMajorCities`, then calling `estimateTrackCost()` for each |
| `serializePrompt()` | Add `VICTORY PROGRESS` section after `YOUR STATUS` |
| `serializePrompt()` | Add phase-appropriate victory directive after victory progress |
| `serializePrompt()` | Annotate demand card lines with "VICTORY BONUS" when near unconnected major city |
| `computePhase()` | Add `'Victory Imminent'` phase (6+ cities and 230M+) |

### 3. `src/server/services/ai/prompts/systemPrompts.ts`

| Section | Change |
|---------|--------|
| `CRITICAL RULES` in `COMMON_SYSTEM_SUFFIX` | Add rule: `"VICTORY ROUTING: When choosing between similar-payout deliveries, prefer the one whose route passes through or near an unconnected major city."` |
| `ROUTE PLANNING CRITERIA` in `ROUTE_PLANNING_SYSTEM_SUFFIX` | Add criterion: `"VICTORY CONNECTIONS: If your route can detour through an unconnected major city for ≤10M extra track cost, prefer that route. Every major city connection brings you closer to winning."` |

### 4. Tests

#### `src/server/__tests__/ai/ContextBuilder.test.ts` (if exists, or new)

- Test `unconnectedMajorCities` computed correctly (all 8 minus connected)
- Test estimated costs are non-zero for distant cities, zero for cities already on network
- Test `serializePrompt` includes `VICTORY PROGRESS` section
- Test phase-appropriate directives appear at correct thresholds
- Test "VICTORY BONUS" annotation appears on demand cards near unconnected cities
- Test `'Victory Imminent'` phase triggers at 6+ cities, 230M+

## Implementation Order

1. **GameTypes** — Add `unconnectedMajorCities` to `GameContext` interface
2. **ContextBuilder.build()** — Compute unconnected cities with cost estimates
3. **ContextBuilder.computePhase()** — Add `'Victory Imminent'` phase
4. **ContextBuilder.serializePrompt()** — Add victory progress section + directives + demand annotations
5. **systemPrompts.ts** — Add victory routing rules to CRITICAL RULES and ROUTE PLANNING CRITERIA
6. **Tests** — Cover all new logic
7. **Build + test** — `npm run build && npm test`

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Bot has 0 segments (initial build) | `estimateTrackCost` cold-start path: estimates from nearest major city center. `unconnectedMajorCities` = all 8 (or 7 if starting from one). |
| Bot already has 7+ cities | `unconnectedMajorCities` is empty. Victory progress section says "All cities connected! Earn XM more to win." |
| Bot has 250M+ but <7 cities | Directive: "You have enough cash — focus ALL building budget on connecting [cheapest remaining cities]." |
| Bot has 7+ cities and 250M+ | Directive: "VICTORY CONDITIONS MET! Declare victory." (though this should be caught by game-level victory check) |
| All unconnected cities cost more than bot's money | Directive notes this: "Earn more before connecting — cheapest unconnected city costs XM, you have YM." |

## Non-Goals

- **No changes to decision logic.** This is purely a context/prompt improvement. PlanExecutor, ActionResolver, and AIStrategyEngine are not modified.
- **No new LLM calls.** All new data is computed from existing `GameContext` fields and the `estimateTrackCost` helper.
- **No victory declaration logic.** Server-side victory checking (`VictoryService`, `checkVictoryConditions`) is unchanged.

## Verification

1. `npm run build` — compiles clean
2. `npm test` — all tests pass
3. Manual: Start a game, observe bot prompt output at different phases:
   - Early game: no victory directive
   - Mid game: "Start routing through unconnected cities" appears
   - Late game: specific cities + costs + "connect X before chasing deliveries"
4. Manual: Observe route planning — bot should prefer routes through unconnected major cities when payout is similar
