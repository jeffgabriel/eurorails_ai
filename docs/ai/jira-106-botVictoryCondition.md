# JIRA-106: Server-Side Victory Check for AI Bot Players

## Bug Summary
AI bot players never trigger the victory condition because the victory check only runs client-side in `GameScene.ts:1018-1023`, gated by `getLocalPlayerId() === currentPlayer.id`. Bots have no browser client, so this check never fires for them.

**Discovered in:** Game `883aae52-b47a-4170-a248-8861a158323a` — bot "flash" met victory conditions but game continued indefinitely.

## Root Cause Analysis

### Client-Side Victory Check (current — human players only)
`GameScene.ts:1016-1023`:
```typescript
if (
  this.playerStateService.getLocalPlayerId() === currentPlayer.id &&
  !this.gameState.victoryState?.triggered
) {
  await this.checkAndDeclareVictory(currentPlayer);
}
```
This guard ensures only the local player's client checks victory. Since bots have no browser client, the check never runs for them.

### Bot Turn Lifecycle (missing victory check)
`BotTurnTrigger.ts:121-224`:
1. `AIStrategyEngine.takeTurn()` — executes bot actions
2. Emit `bot:turn-complete` event
3. `advanceTurnAfterBot()` — advances to next player

**No victory check exists anywhere in this flow.**

`advanceTurnAfterBot()` (lines 250-272) simply calculates the next player index — no call to `VictoryService` or `getConnectedMajorCityCount()`.

## Victory Conditions (per game rules)
- **Continuous track connecting 7 major cities** — checked via `getConnectedMajorCityCount()` (server) or `VictoryService.hasSevenConnectedCities()` (client)
- **ECU 250M in cash** (net of debt)

## Fix Plan

### Where to Add Victory Check
In `BotTurnTrigger.onTurnChange()`, after `AIStrategyEngine.takeTurn()` completes (line 123) and before `advanceTurnAfterBot()` (line 224).

### Implementation Steps
1. **Get bot's current state** — query money, debt from DB (or use pipeline result)
2. **Get bot's track segments** — via `TrackService.getTrackState()`
3. **Count connected major cities** — use existing `getConnectedMajorCityCount()` from `connectedMajorCities.ts`; add a variant that returns city details (name, row, col) needed by `declareVictory()`
4. **Check victory conditions** — net worth >= threshold AND 7+ connected cities
5. **If met, call `VictoryService.declareVictory()`** — existing server-side function that validates and updates game state
6. **Emit socket events** — use existing `emitVictoryTriggered()` from socketService so all clients are notified
7. **Handle final-turn resolution** — if victory was already triggered (by another player), check `VictoryService.isFinalTurn()` and call `resolveVictory()` if this is the final turn

### Also Handle: Final Turn for Bots
If another player declared victory and the bot is playing the final turn, the bot's client would normally call `resolveVictory()` (GameScene.ts:1027-1037). This also doesn't happen for bots. The fix must check `isFinalTurn()` after advancing the turn and call `VictoryService.resolveVictory()` + emit `game:over` if applicable.

## Affected Files
| File | Change |
|------|--------|
| `src/server/services/ai/BotTurnTrigger.ts` | Add `checkBotVictory()` after takeTurn, before advanceTurn |
| `src/server/services/ai/connectedMajorCities.ts` | Add `getConnectedMajorCities()` variant returning city details |
| `src/server/services/victoryService.ts` | No changes — reuse existing `declareVictory()` |
| `src/server/services/socketService.ts` | No changes — reuse existing `emitVictoryTriggered()`, `emitGameOver()` |
| `src/server/__tests__/ai/BotTurnTrigger.test.ts` | Add victory check test cases |

## Complexity Assessment
| Dimension | Score | Evidence |
|-----------|:-----:|----------|
| Blast Radius | 1 | 1-2 source files + 1 test file |
| Dependency Depth | 1 | Leaf orchestrator calling existing services |
| Conceptual Scope | 1 | Single concern: bot victory check |
| Pattern Complexity | 1 | Reuses existing patterns |
| Testing Surface | 1 | Existing test infrastructure |
| **Total** | **5** | **Trivial** |

## Test Scenarios
- Bot with 250M+ ECU and 7+ connected cities → victory declared, socket event emitted
- Bot with 250M+ ECU but < 7 connected cities → no victory declared
- Bot with 7+ connected cities but < 250M ECU → no victory declared
- Victory already triggered by another player → bot checks isFinalTurn and resolves if applicable
- Human player victory flow unchanged (no regression)
