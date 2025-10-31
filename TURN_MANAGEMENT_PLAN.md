# Multi-Player Turn Management & Per-Player Perspective Plan

## Overview
This plan implements turn-based multiplayer mechanics where each player has their own view (camera position/zoom) and can only interact during their turn. Non-active players see the game board and other players' actions but cannot control gameplay.

## Requirements Summary
1. **Per-Player Camera State**: Each player maintains independent zoom/pan settings
2. **Per-Player Demand Cards**: Each player only sees their own demand cards
3. **Turn-Based Controls**: 
   - Only active player can use "Next Player" button
   - Only active player can select drawing crayon
   - Active player's drawing visible to all, but only active player has undo
4. **Visual Feedback**: 
   - Active player highlighted in player list
   - Turn transition notifications (toast/flash)

---

## Implementation Plan

### Phase 1: Client Player Identification
**Goal**: Establish which player this client instance represents

**Tasks**:
1. Add `localPlayerId` to GameStateService or create separate PlayerIdentityService
2. Determine local player ID when game loads:
   - Extract from user session/auth
   - Match against game players by userId
   - Store in GameStateService or GameScene
3. Add helper methods: `isCurrentPlayer()`, `getLocalPlayerId()`, `getLocalPlayer()`

**Files to Modify**:
- `src/client/services/GameStateService.ts` - Add local player tracking
- `src/client/scenes/GameScene.ts` - Identify local player on init
- `src/shared/types/GameTypes.ts` - May need to add userId to Player interface

---

### Phase 2: Per-Player Camera State
**Goal**: Each player maintains independent camera zoom/pan that persists across turns

**Tasks**:
1. Change camera state from global to per-player:
   - Update `GameState.cameraState` to `Map<playerId, CameraState>`
   - Update database schema to store per-player camera states
   - Migrate existing global camera state to first player's state
2. Modify CameraController to:
   - Save/load camera state for local player only
   - Persist camera changes to backend
   - Apply local player's camera state on scene init
3. Create API endpoints:
   - `PUT /api/games/:gameId/camera-state` - Update local player's camera
   - `GET /api/games/:gameId/camera-state/:playerId` - Get player's camera state

**Files to Modify**:
- `src/client/components/CameraController.ts` - Per-player camera logic
- `src/shared/types/GameTypes.ts` - Update GameState.cameraState type
- `src/server/db/migrations/` - Create migration for per-player camera state
- `src/server/routes/gameRoutes.ts` - Add camera state endpoints
- `src/server/services/gameService.ts` - Add camera state management

---

### Phase 3: Per-Player Demand Card Visibility
**Goal**: Each player only sees their own demand cards

**Tasks**:
1. Modify PlayerHandDisplay to show only local player's cards:
   - Instead of `currentPlayerIndex`, use `localPlayerId`
   - Filter hand display based on local player
   - Hide other players' cards entirely
2. Ensure demand cards sync from server:
   - Only server sends demand cards for authenticated player
   - Validate client doesn't receive other players' cards

**Files to Modify**:
- `src/client/components/PlayerHandDisplay.ts` - Filter by localPlayerId
- `src/client/scenes/GameScene.ts` - Pass localPlayerId to PlayerHandDisplay
- `src/server/routes/playerRoutes.ts` - Ensure only returning player's own hand

---

### Phase 4: Turn-Based Interaction Controls
**Goal**: Only active player can interact with turn-specific controls

#### 4a. Next Player Button
**Tasks**:
1. Update LeaderboardManager.createNextPlayerButton():
   - Disable button if `localPlayerId !== currentPlayerId`
   - Visual indication (grayed out) when disabled
   - Tooltip explaining why disabled

**Files to Modify**:
- `src/client/components/LeaderboardManager.ts` - Conditionally enable button
- `src/client/scenes/GameScene.ts` - Pass localPlayerId to LeaderboardManager

#### 4b. Drawing Crayon Selection
**Tasks**:
1. Update PlayerHandDisplay crayon button:
   - Only allow interaction if `localPlayerId === currentPlayerId`
   - Disable pointer events when not active
   - Visual feedback (grayed out/disabled state)

**Files to Modify**:
- `src/client/components/PlayerHandDisplay.ts` - Conditionally enable crayon
- Pass localPlayerId and isActivePlayer flag

#### 4c. Undo Functionality
**Tasks**:
1. Ensure undo only works for active player:
   - Track undo in TrackDrawingManager only for active player
   - Disable undo button in UI when not active player
   - Store undo history per-player or clear on turn change

**Files to Modify**:
- `src/client/components/TrackDrawingManager.ts` - Verify undo only for active player
- `src/client/components/PlayerHandDisplay.ts` - Disable undo when not active

---

### Phase 5: Global Drawing with Per-Player Undo
**Goal**: Active player's drawing visible to all, but only active player can undo

**Tasks**:
1. Ensure drawing is broadcast to all clients:
   - Verify track building events sync via Socket.IO or similar
   - Confirm all clients receive track updates in real-time
2. Restrict undo operations:
   - Only allow undo for segments drawn by local player in current turn
   - Clear undo history when turn ends
   - Prevent undo of other players' drawings

**Files to Modify**:
- `src/client/components/TrackDrawingManager.ts` - Undo restrictions
- Verify socket synchronization for track drawing

---

### Phase 6: Active Player Highlighting
**Goal**: Visual indication of whose turn it is

**Tasks**:
1. Enhance LeaderboardManager display:
   - More prominent highlighting for active player (already partially done)
   - Ensure highlighting updates when turn changes
   - Add visual indicator (icon, border, etc.)

**Files to Modify**:
- `src/client/components/LeaderboardManager.ts` - Enhance current player highlighting

---

### Phase 7: Turn Transition Notifications
**Goal**: Notify player when it becomes their turn

**Tasks**:
1. Create notification system:
   - Toast notification component (non-intrusive)
   - Screen flash option (subtle fade effect)
   - Trigger on turn change when `newActivePlayerId === localPlayerId`
2. Integrate with GameStateService:
   - Listen for turn changes
   - Check if local player is now active
   - Show notification

**Files to Modify**:
- Create `src/client/components/TurnNotification.ts` - New notification component
- `src/client/scenes/GameScene.ts` - Add turn change listener
- `src/client/services/GameStateService.ts` - Emit turn change events

---

## Technical Considerations

### Database Changes
- Add per-player camera state storage (JSON column per player or separate table)
- May need to migrate existing camera_state to new structure

### API Changes
- New endpoints for per-player camera state
- Ensure demand cards are filtered server-side

### Real-Time Synchronization
- Verify Socket.IO or similar handles:
  - Turn changes (all clients update currentPlayerIndex)
  - Track drawing (broadcast to all clients)
  - Camera state (only sync own player's camera)

### Security
- Server must validate:
  - Only active player can advance turn
  - Only player can modify their own camera state
  - Only player can see their own demand cards

---

## Testing Checklist
- [ ] Local player identification works correctly
- [ ] Per-player camera state persists independently
- [ ] Only active player can use next player button
- [ ] Only active player can select drawing crayon
- [ ] Drawing visible to all players
- [ ] Only active player can undo
- [ ] Active player highlighted in leaderboard
- [ ] Turn transition notification appears for new active player
- [ ] Demand cards only visible to owning player
- [ ] Multiple players can play simultaneously without interference

---

## Dependencies & Order
1. **Phase 1** must be completed first (client identification)
2. **Phases 2-3** can be done in parallel (camera + demand cards)
3. **Phase 4** depends on Phase 1 (need localPlayerId)
4. **Phase 5** may already be working (verify first)
5. **Phases 6-7** are polish and can be done last

