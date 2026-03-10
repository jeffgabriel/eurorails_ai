# JIRA-77: RouteValidator Rejects Routes During Initial Build Due to Null Bot Position

## Bug Summary

During initial build turns (first 2 turns), `RouteValidator.validate()` rejects all multi-stop routes because `snapshot.bot.position` is null. The reorder-by-proximity step at line 66-70 treats null position as a hard failure, causing LLM route planning to fail and fall back to heuristics.

## Observed Behavior

Game `08dc7ab3-8a9f-4d77-96cf-bb1e572074fb`:

**Haiku bot (c89532b9), Turn 2:**
- Attempt 1: `Route infeasible: Bot position is null — cannot reorder stops` (valid route rejected)
- Attempt 2: Parse error (Haiku returned free-text instead of JSON)
- Attempt 3: Parse error (Haiku wrapped JSON in markdown code fences)
- Result: Fell back to heuristic-fallback

**Flash bot (a2c38ed2), Turn 2:**
- All 3 attempts: `Route infeasible: Bot position is null — cannot reorder stops`
- Result: Fell back to heuristic-fallback

## Root Cause

1. During `initialBuild`, bots have no train placed — `snapshot.bot.position` is `null`
2. `AIStrategyEngine.takeTurn()` (line 113) correctly skips `autoPlaceBot()` during initialBuild
3. `LLMStrategyBrain.planRoute()` gets an LLM response, parses it, calls `RouteValidator.validate()` (line 308)
4. `RouteValidator.validate()` (line 66-70): if route has >1 stop, tries `reorderStopsByProximity()` which requires `botPos`. Null position → hard failure

```typescript
// RouteValidator.ts:66-70
if (validations.length > 1) {
  const botPos = snapshot.bot.position;
  if (!botPos) {
    return { valid: false, errors: ['Bot position is null — cannot reorder stops'] };
  }
  // ... reorder logic
}
```

## Impact

- Both bots fail LLM planning on initial build turns every game
- Falls back to heuristics which may choose suboptimal build targets
- Wastes 3 LLM API calls per bot per initial build turn

## Fix Plan

Skip the `reorderStopsByProximity` step when `botPos` is null instead of returning a hard failure. During initial build, stop order is irrelevant — the bot is only building track, not moving. The route just needs to identify pickup/delivery targets so the bot knows where to build toward.

```typescript
// Fix: skip reorder when position is null (initial build)
if (validations.length > 1) {
  const botPos = snapshot.bot.position;
  if (botPos) {
    const reordered = RouteValidator.reorderStopsByProximity(...);
    // ... existing reorder logic
  }
  // else: skip reorder, keep LLM's original stop order
}
```

## Key Files

- `src/server/services/ai/RouteValidator.ts:66-70` — primary fix target
- `src/server/services/ai/LLMStrategyBrain.ts:308` — calls RouteValidator.validate()
- `src/server/services/ai/AIStrategyEngine.ts:113` — skips autoPlaceBot during initialBuild
