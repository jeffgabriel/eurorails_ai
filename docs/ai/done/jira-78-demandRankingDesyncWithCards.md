# JIRA-78: Debug Overlay Demand Ranking Desyncs From Resource Flyout Cards Tab

## Bug Summary

The demand ranking shown in the debug overlay shows different demands than the Cards tab in the resource flyout panel. They should always be in sync.

## Root Cause

Two different data sources and update paths:

1. **Cards tab** (`LoadsReferencePanel.ts`) -- gets data from `gameState.players[].hand` via `emitStatePatch` which reads the actual DB state after delivery.

2. **Demand ranking** (`DebugOverlay.ts`) -- computed at two different times:
   - At turn start (`AIStrategyEngine.ts:536`): Uses `context.demands` from ContextBuilder with full scoring -- accurate.
   - After mid-turn delivery (`TurnExecutor.ts:678-705`): Manually reconstructs the hand from `snapshot.bot.demandCards` (the turn-start snapshot), which is stale after multiple deliveries in the same turn. Uses simplified `score: d.payment` instead of real `demandScore`. Only picks `sourceCities[0]` as supply city.

The critical issue is `TurnExecutor.ts:680`: `const updatedHand = snapshot.bot.demandCards.filter(id => id !== cardId)` uses the turn-start snapshot which diverges from the actual DB state after the first delivery.

## Impact

- Debug overlay shows stale/wrong demand ranking after deliveries
- Makes it impossible to trust the debug overlay for diagnosing AI decisions
- Multiple deliveries per turn make the desync worse

## Fix Plan

Have TurnExecutor read the actual current hand from the DB (like `emitStatePatch` does) instead of reconstructing from the stale snapshot. Or better: after `emitStatePatch` succeeds, use that same fresh player data to build the ranking.

## Key Files

- `src/server/services/ai/TurnExecutor.ts:678-705` -- stale hand reconstruction
- `src/server/services/ai/AIStrategyEngine.ts:536-555` -- accurate turn-start ranking
- `src/client/components/DebugOverlay.ts:295-301` -- receives `demandRankingUpdate`
- `src/client/components/LoadsReferencePanel.ts:550-621` -- Cards tab rendering
- `src/client/scenes/GameScene.ts:428-429` -- Cards tab updated via state patch
