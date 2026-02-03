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

## Lessons Learned

1. **Always verify database schema before writing queries** - Don't assume column names from type definitions
2. **Check how data is stored vs. how it's used** - Card IDs vs. card objects caught us
3. **Add detailed logging early** - The console logs helped identify exactly where failures occurred
4. **Test with manual trigger scripts** - `scripts/trigger-ai-turn.ts` was invaluable for debugging without full game flow
