# JIRA-62: A2 Continuation Truncation Wastes Movement Through Major Cities

## Bug Description

When the A2 continuation MOVE path passes through a major city's red area, the path truncation uses **raw edge count** instead of **effective mileposts**. Intra-city hops (e.g., Holland outpost → Holland center → Holland outpost east) are free per game rules but consume slots in the raw truncation, causing the bot to waste movement budget.

The same bug exists in A3 (prepend-MOVE-before-BUILD) truncation.

## Evidence

### Game `e48b04ec`, Flash (gemini-3-flash), T4:
- **Route**: pickup(Imports@Antwerpen) → deliver(Imports@Wien)
- **T4 input**: MOVE toward Antwerpen (from Holland, ~2 effective mp)
- **A1**: Finds Imports at Antwerpen, inserts PICKUP. Steps: [MOVE(2mp), PICKUP]
- **A2**: Chains continuation MOVE from Antwerpen toward Wien (back through Holland)
- **moveBudget**: `{total: 9, used: 4, wasted: 5}` — only 4 effective mp used of 9
- **T5**: Same bot uses full 9mp toward Wien on the exact same track — proving the track existed

### Root Cause

`TurnComposer.ts` A2 truncation (line ~347):
```typescript
if (chainedMove.path.length - 1 > remainingMovement) {
  chainedMove = { ...chainedMove, path: chainedMove.path.slice(0, remainingMovement + 1) };
}
```

- `remainingMovement` is in **effective** mileposts (from `countMovementUsed` which uses `computeEffectivePathLength`)
- `path.length - 1` is **raw** edge count (includes intra-city hops)
- `path.slice(0, remainingMovement + 1)` treats `remainingMovement` as a raw index

When the path passes through a major city with 2+ intra-city hops (e.g., outpost → center → outpost), those free hops consume budget slots in the truncation, effectively wasting 1 effective mp per intra-city hop.

## Fix

Added `truncatePathToEffectiveBudget()` helper that walks the path and only counts non-intra-city edges toward the budget, mirroring `ActionResolver.resolveMove()` truncation logic. Applied to both A2 and A3 truncation points.

## Affected Files

- `src/server/services/ai/TurnComposer.ts` — A2 and A3 truncation, new helper
- `src/server/__tests__/ai/TurnComposer.test.ts` — JIRA-62 test case

## Impact

In game e48b04ec, Flash wasted 5 of 9 mileposts on T4 due to this bug. Any bot whose continuation path passes through a major city red area loses effective movement proportional to the number of intra-city hops traversed.
