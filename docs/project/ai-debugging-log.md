# AI Feature Debugging Log

This document tracks issues discovered and fixed during AI feature development.

---

## 2026-02-02: AIService Database Query Issues

**Symptom:** AI bots were passing turns without taking any actions. Server logs showed:
```
AI turn execution failed for player xxx: error: column "train_state" does not exist
```

### Issue 1: Non-existent `train_state` column
- **Location:** `src/server/services/ai/aiService.ts:166` - `getGameStateAndPlayer()`
- **Problem:** Query referenced `train_state` JSON column which doesn't exist in the database schema
- **Actual Schema:** Database uses individual columns: `position_row`, `position_col`, `position_x`, `position_y`, `loads`
- **Fix:** Updated SELECT query to use correct column names and build `trainState` object from individual columns

### Issue 2: Non-existent `turn_number` column in games table
- **Location:** `src/server/services/ai/aiService.ts:220` - games query
- **Problem:** Query referenced `turn_number` column which doesn't exist in the `games` table
- **Actual Schema:** Games table has no global turn counter; turn tracking is per-player via `current_turn_number`
- **Fix:** Removed column from query, calculate global turn number from `Math.max(...players.map(p => p.turnNumber))`

### Issue 3: Player hand contained card IDs, not card objects
- **Location:** `src/server/services/ai/aiService.ts:205` - player mapping
- **Problem:** Database stores `hand` as array of card IDs `[48, 96, 13]`, but `AIPlanner.generatePickupOptions()` expected full `DemandCard` objects with `demands` array
- **Error:** `TypeError: card.demands is not iterable`
- **Fix:** Import `demandDeckService` and resolve card IDs to full `DemandCard` objects using `demandDeckService.getCard(cardId)`

### Issue 4: `placeAITrainAtStartingCity()` used wrong column
- **Location:** `src/server/services/ai/aiService.ts:285-298`
- **Problem:** Method tried to update non-existent `train_state` JSON column using `jsonb_set()`
- **Fix:** Updated to use individual columns: `SET position_row = $1, position_col = $2, position_x = $3, position_y = $4`

### Issue 5: Empty `availableLoads` Map
- **Location:** `src/server/services/ai/aiService.ts:246`
- **Problem:** `availableLoads` Map was created empty, AI couldn't find loads to pick up
- **Fix:** Import `LoadService` and populate from `loadService.getAllLoadStates()`

**Commit:** `b84d20c` - fix(ai): correct database queries in AIService for AI turn execution

---

## Schema Reference

### players table columns (relevant to AI):
```
id, name, color, money, train_type,
position_x, position_y, position_row, position_col,
loads, hand, current_turn_number,
is_ai, ai_difficulty, ai_personality
```

### games table columns:
```
id, status, current_player_index, max_players,
victory_triggered, victory_trigger_player_index,
victory_threshold, final_turn_player_index,
join_code, created_by, is_public, server_seq
```

Note: No `turn_number` column in games table.

---

---

## 2026-02-02: AI Action Execution Not Implemented

**Symptom:** AI plans actions but nothing actually happens in the game. Train not visible, no track built, money unchanged.

### Issue 6: Execute methods are placeholder stubs
- **Location:** `src/server/services/ai/aiService.ts:418-439`
- **Problem:** The action execution methods only log messages, they don't call actual game services:
  ```typescript
  // executeMoveAction
  console.log(`AI ${playerId} moving to ${action.details.destination}`);

  // executePickupAction
  console.log(`AI ${playerId} picking up ${action.details.loadType}...`);

  // executeBuildAction - only deducts money, doesn't build track
  ```
- **Impact:** AI appears to take turns but game state never changes
- **Required Fix:** Integrate with actual game services:
  - `executeBuildAction` → Call `TrackService` to build track segments
  - `executeMoveAction` → Call `PlayerService` or movement service to update train position
  - `executePickupAction` → Call `LoadService` to pick up loads
  - `executeDeliverAction` → Call `PlayerService.deliverLoad()` for full delivery flow

### Issue 7: AI Planner generates infeasible actions
- **Location:** `src/server/services/ai/aiPlanner.ts`
- **Problem:** Planner generated "Pick up Tobacco at Napoli" when train was in Madrid with no track connection
- **Impact:** AI plans impossible moves that can't be executed even if execution worked
- **Required Fix:** Planner needs to validate:
  - Track connectivity before planning movement
  - Reachability before planning pickups/deliveries
  - Available funds before planning builds

**Status:** IN PROGRESS

---

## 2026-02-02: Track Building Cannot Work - No Segment Calculation

### Issue 8: AIPathfinder returns empty segments (FIXED)
- **Location:** `src/server/services/ai/aiPathfinder.ts:224`
- **Problem:** `evaluateTrackBuildOptions()` returns build recommendations with empty segment arrays:
  ```typescript
  segments: [], // Would need map data to fill actual segments
  ```
- **Root Cause:** The server doesn't have access to the grid/map data needed to calculate valid track segments.
- **Fix:** Created `src/server/services/ai/aiTrackBuilder.ts`:
  - Loads `configuration/gridPoints.json` server-side
  - Implements hex grid adjacency calculation (matching client logic)
  - Uses A* pathfinding to calculate optimal paths between mileposts
  - Calculates terrain costs and respects turn budget (20M)
  - Updated `aiService.ts` to use `AITrackBuilder.buildTrackToTarget()` in `executeBuildAction()`

### Issue 9: Existing service methods use userId, not playerId
- **Location:** `src/server/services/playerService.ts`
- **Problem:** Methods like `moveTrainForUser()` and `deliverLoadForUser()` lookup players by `userId`, but AI players have `userId = null`
- **Impact:** Cannot reuse existing service methods for AI execution
- **Fix:** Created AI-specific execution methods in `aiService.ts` that work with `playerId` directly

**Status:** WORKING

### What Works Now:
- ✅ Pickup loads - adds to player.loads array
- ✅ Deliver loads - removes load, pays money, handles debt repayment
- ✅ Move to all cities - uses `getCityCoordinates()` for Major/Medium/Small cities
- ✅ Upgrade train - updates train_type and deducts money
- ✅ Build track - uses `AITrackBuilder` for pathfinding and segment calculation

### Tested Results:
```
# Earlier manual tests (pickup/delivery)
Otto picked up Beer at Dublin -> loads: ["Beer"]
Otto delivered Beer to Lisboa for 46M -> money: 45M → 91M, loads: []

# Integration tests (aiTrackBuilderIntegration.test.ts)
Built 3 segments for 4M (starting from scratch)
Saved and verified track state in database
Extended with 6 new segments for 7M (using existing track as starting point)
Found milepost at (51,3): terrain=1 (Mountain)
```

---

---

## 2026-02-02: Refactored AITrackBuilder to Use Shared Utilities

**Motivation:** After implementing AITrackBuilder for server-side track pathfinding, code review identified duplicate logic across multiple files:
- AITrackBuilder.isAdjacent() - hex grid adjacency
- TrackDrawingManager.isAdjacent() - same logic
- TrackBuildingService.calculateNewSegmentCost() - terrain costs
- All used the same TERRAIN_COSTS constants

### Refactoring: Created Shared Hex Grid Utility

**New File:** `src/shared/utils/hexGridUtils.ts`

Contains:
- `isAdjacentHexGrid(point1, point2)` - hex grid adjacency check
- `getHexNeighborOffsets()` - possible neighbor offsets to check
- `calculateTerrainBuildCost(terrain)` - terrain-based build costs
- `hexGridHeuristic(from, to)` - A* heuristic for pathfinding
- `TERRAIN_BUILD_COSTS` - shared constant for terrain costs (ECU)
- `TRACK_BUILD_BUDGET_PER_TURN` - 20M per turn budget constant

### Files Updated:
1. **src/server/services/ai/aiTrackBuilder.ts**
   - Removed duplicate TERRAIN_COSTS and BUILD_BUDGET_PER_TURN
   - Updated `isAdjacent()` to use `isAdjacentHexGrid()`
   - Updated `getNeighbors()` to use `getHexNeighborOffsets()`
   - Updated `calculateSegmentCost()` to use `calculateTerrainBuildCost()`
   - Updated `heuristic()` to use `hexGridHeuristic()`

2. **src/shared/services/TrackBuildingService.ts**
   - Removed duplicate terrainCosts object
   - Updated to import and use `TERRAIN_BUILD_COSTS`
   - Updated TURN_BUDGET to use `TRACK_BUILD_BUDGET_PER_TURN`

3. **src/client/components/TrackDrawingManager.ts**
   - Removed ~40 lines of duplicate `isAdjacent()` logic
   - Removed duplicate TERRAIN_COSTS object
   - Updated to import and use shared utilities

### Test Results:
```
✓ AITrackBuilder tests: 10 passed
✓ TrackBuildingService tests: 10 passed
✓ Server build: Success
```

### Benefits:
- Single source of truth for hex grid logic
- Consistent terrain costs across client/server
- Easier to maintain and update game rules
- Reduced risk of logic drift between implementations

---

---

## 2026-02-02: AI Players Breaking Game Rules (Gaining Money During Initial Building Phase)

**Symptom:** AI players (Helga, Ingrid) gained money (73M and 44M respectively) after only 2 turns when they should only be building track. According to Eurorails rules, the initial building phase (turns 1-2) allows ONLY track building - no movement, pickup, delivery, or upgrades until turn 3.

### Issue 10: AI train placed at major city during turn 1
- **Location:** `src/server/services/ai/aiService.ts:61-64`
- **Problem:** `placeAITrainAtStartingCity()` was called regardless of turn number, placing AI trains at major cities immediately
- **Impact:** AI could pickup loads from the city they were placed at without building any track
- **Fix:** Only place train after initial building phase:
  ```typescript
  const turnNumber = player.turnNumber || 1;
  if (!player.trainState.position && turnNumber > 2) {
    await this.placeAITrainAtStartingCity(gameId, playerId, player);
  }
  ```

### Issue 11: No action filtering during initial building phase
- **Location:** `src/server/services/ai/aiService.ts:339-391` - `executeActions()`
- **Problem:** All action types were executed without checking if player was in initial building phase
- **Fix:** Added phase check before action execution:
  ```typescript
  const isInitialBuildingPhase = turnNumber <= 2;
  if (isInitialBuildingPhase && !['build', 'pass'].includes(action.type)) {
    console.log(`AI ${playerId} action '${action.type}' blocked - initial building phase`);
    continue;
  }
  ```

### Issue 12: No track connectivity validation for movement
- **Location:** `src/server/services/ai/aiService.ts:497-556` - `executeMoveAction()`
- **Problem:** AI could teleport to any city without having track connecting to it
- **Fix:** Added `hasTrackConnectionTo()` helper and validation before movement

### Issue 13: No track connectivity validation for pickup/delivery
- **Location:** `src/server/services/ai/aiService.ts:561-691`
- **Problem:** `executePickupAction()` and `executeDeliverAction()` didn't validate:
  - Train is positioned (not null)
  - Train is at the correct city
  - Player has track connection to current position
- **Fix:** Added all three validations to both methods

### New Helper Method: `hasTrackConnectionTo()`
```typescript
private async hasTrackConnectionTo(
  gameId: string,
  playerId: string,
  targetRow: number,
  targetCol: number
): Promise<boolean>
```
Checks if player's track network reaches a given location by examining all segment endpoints.

### Test Fix Required
- **File:** `src/server/__tests__/ai/aiService.test.ts`
- **Problem:** Delivery test mock used wrong Berlin coordinates (12,18) instead of actual (24,52)
- **Fix:** Updated mock to use correct coordinates, added TrackService import and mock

### Commits:
- `8dd753a` - fix(ai): enforce game rules during AI turn execution
- `c504410` - fix(test): update AI service test mocks for rule enforcement

### Test Results:
```
Test Suites: 8 passed, 8 total
Tests:       275 passed, 275 total
```

---

## Lessons Learned

1. **Always verify database schema before writing queries** - Don't assume column names from type definitions
2. **Check how data is stored vs. how it's used** - Card IDs vs. card objects caught us
3. **Add detailed logging early** - The console logs helped identify exactly where failures occurred
4. **Test with manual trigger scripts** - `scripts/trigger-ai-turn.ts` was invaluable for debugging without full game flow
5. **Extract shared utilities early** - Duplicate logic across client/server should be moved to shared directory
6. **Validate game rules at execution layer** - Even if the planner generates legal actions, the execution layer should enforce rules as a safety net
7. **Check actual game data coordinates** - City coordinates in tests must match the real milepost data (Berlin is at 24,52 not 12,18)
8. **Verify API routes exist before testing** - Integration tests may reference routes that don't exist yet

---

## 2026-02-02: AI Turns Never Triggered - Missing End-Turn Route

**Symptom:** In game `5c1c17e3-1d3f-45e8-9ac8-508e6cc17e11`, AI bots Marie and Liesel had:
- `current_turn_number = 1` (never incremented)
- No position (null `position_row`, `position_col`)
- No track built
- Still at starting money (50M)

Meanwhile human player had `current_turn_number = 4` and had built 13 track segments.

### Issue 14: Missing `/api/games/:gameId/end-turn` Route
- **Location:** `src/server/routes/gameRoutes.ts` - route did not exist
- **Problem:** The integration tests and client expected a `/api/games/:gameId/end-turn` POST endpoint to end a human player's turn and trigger AI execution, but this route was never created
- **Evidence:**
  - Tests in `aiTurn.test.ts` referenced `.post(\`/api/games/${testGame.id}/end-turn\`)`
  - These tests were failing with 404 errors
  - No route handler existed in any route file
- **Impact:**
  - Human players could not end their turns normally (only via discardHand which is a special action)
  - AI turns were never triggered because `GameService.endTurn()` was never called
  - AI players remained stuck at turn 1 indefinitely

### Fix Applied

**Route:** Added `POST /api/games/:gameId/end-turn` to `gameRoutes.ts`

**Service Method:** Added `PlayerService.endTurnForUser()` to `playerService.ts`:
```typescript
static async endTurnForUser(gameId: string, userId: string): Promise<{
  currentPlayerIndex: number;
  nextPlayerId: string;
  nextPlayerIsAI: boolean;
}> {
  // All operations in a transaction:
  // 1. Validate game is active
  // 2. Validate it's the user's turn
  // 3. Increment current player's turn number
  // 4. Advance game's current_player_index
  // 5. Emit socket events AFTER commit
  // 6. Trigger AI turn execution if next player is AI
}
```

### Design Decision: Following `discardHandForUser` Pattern
After code graph analysis, initial implementation had issues:
- No transaction (race conditions)
- Socket event timing issues
- Direct DB queries instead of using proper service method

Fixed by creating `endTurnForUser()` following the same transaction pattern as `discardHandForUser()`:
- Uses `BEGIN/COMMIT/ROLLBACK` transaction
- Acquires row lock with `FOR UPDATE`
- Emits socket events AFTER transaction commits
- Triggers AI execution asynchronously after commit

### Test Results
```
✓ should emit ai:thinking event when AI turn starts (5055 ms)
✓ should automatically execute AI turn when human player ends turn (5048 ms)
```
