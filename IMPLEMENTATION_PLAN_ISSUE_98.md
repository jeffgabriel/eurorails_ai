# Implementation Plan: Issue #98 - Per-Player Camera State

## Overview
Implement independent camera zoom/pan settings per player that persist across turns. Currently, camera state is stored globally in the `games` table and shared by all players.

## Prerequisites
- ✅ Issue #97 (Client Player Identification) is **completed** - `PlayerStateService` provides `getLocalPlayerId()` and related methods
- Local player identification works via `PlayerStateService.initializeLocalPlayer()`

## Current State Analysis

### Database
- `games.camera_state` (JSONB) - Currently stores single global camera state
- Migration `004_add_camera_state.sql` adds this column
- Next migration should be `014_add_per_player_camera_state.sql`

### Types
- `GameState.cameraState?: { zoom: number; scrollX: number; scrollY: number }` - Single global state
- `CameraController` interface matches this structure

### API
- `POST /api/game/updateCameraState` - Updates global camera state (no player validation)
- `GameService.updateCameraState()` - Updates `games.camera_state` column

### Client
- `CameraController.saveCameraState()` - Saves to API without player context
- `CameraController.setupCamera()` - Loads from `gameState.cameraState`

---

## Implementation Steps

### Step 1: Database Schema Changes
**File**: `db/migrations/014_add_per_player_camera_state.sql`

**Decision**: Store camera state in `players` table (simpler than separate table)
- Add `camera_state JSONB` column to `players` table
- Migrate existing `games.camera_state` to first player (index 0) if exists
- Remove `camera_state` from `games` table (or keep for backwards compatibility during transition)

**Migration Strategy**:
```sql
-- Add camera_state to players table
ALTER TABLE players ADD COLUMN IF NOT EXISTS camera_state JSONB;

-- Migrate existing global camera state to first player
DO $$
DECLARE
    game_record RECORD;
    first_player_id UUID;
BEGIN
    FOR game_record IN SELECT id, camera_state FROM games WHERE camera_state IS NOT NULL
    LOOP
        -- Get first player for this game (lowest created_at or first by id)
        SELECT id INTO first_player_id
        FROM players
        WHERE game_id = game_record.id
        ORDER BY created_at ASC, id ASC
        LIMIT 1;
        
        -- If player exists, migrate camera state
        IF first_player_id IS NOT NULL THEN
            UPDATE players
            SET camera_state = game_record.camera_state
            WHERE id = first_player_id;
        END IF;
    END LOOP;
END $$;

-- Optional: Remove camera_state from games table (comment out if keeping for backwards compat)
-- ALTER TABLE games DROP COLUMN IF EXISTS camera_state;
```

---

### Step 2: Update TypeScript Types
**File**: `src/shared/types/GameTypes.ts`

**Changes**:
1. Remove `cameraState` from `GameState` interface (or make optional for backwards compat)
2. Keep `CameraState` interface in `CameraController.ts` (reuse or import)
3. Add `cameraState` to `Player` interface as optional field

```typescript
export interface Player {
    id: string;
    userId?: string;
    name: string;
    color: string;
    money: number;
    trainType: TrainType;
    turnNumber: number;
    trainState: TrainState;
    hand: DemandCard[];
    cameraState?: {  // NEW: Per-player camera state
        zoom: number;
        scrollX: number;
        scrollY: number;
    };
}

export interface GameState {
    // ... existing fields
    // Remove: cameraState?: { zoom: number; scrollX: number; scrollY: number; };
}
```

---

### Step 3: Update Backend Service
**File**: `src/server/services/gameService.ts`

**Changes**:
1. Remove or deprecate `updateCameraState(gameId, cameraState)` method
2. Add new method: `updatePlayerCameraState(gameId, playerId, cameraState)` with validation
3. Update `getGame()` to include camera state for local player only (via PlayerService)

**New Method**:
```typescript
static async updatePlayerCameraState(
    gameId: string, 
    playerId: string, 
    cameraState: { zoom: number; scrollX: number; scrollY: number }
): Promise<void> {
    // Validate player belongs to game
    const playerCheck = await db.query(
        'SELECT id FROM players WHERE id = $1 AND game_id = $2',
        [playerId, gameId]
    );
    
    if (playerCheck.rows.length === 0) {
        throw new Error('Player not found in game');
    }
    
    await db.query(
        'UPDATE players SET camera_state = $1 WHERE id = $2',
        [JSON.stringify(cameraState), playerId]
    );
}
```

---

### Step 4: Update Backend Routes
**File**: `src/server/routes/gameRoutes.ts`

**Changes**:
1. Update `POST /api/game/updateCameraState` to:
   - Require authentication (`authenticateToken` middleware)
   - Extract `playerId` from request body (or from authenticated user)
   - Validate player ownership
   - Call new `updatePlayerCameraState()` method
2. Optionally add `GET /api/game/:gameId/camera-state/:playerId` for debugging (admin only)

**Updated Route**:
```typescript
router.post('/updateCameraState', authenticateToken, async (req, res) => {
    try {
        const { gameId, playerId, cameraState } = req.body;
        const userId = req.user?.id;
        
        if (!gameId || !playerId || !cameraState) {
            return res.status(400).json({ 
                error: 'Validation error',
                details: 'Game ID, player ID, and camera state are required'
            });
        }
        
        // Validate player belongs to authenticated user
        const player = await PlayerService.getPlayer(playerId, userId);
        if (!player) {
            return res.status(403).json({
                error: 'Forbidden',
                details: 'Player does not belong to authenticated user'
            });
        }
        
        await GameService.updatePlayerCameraState(gameId, playerId, cameraState);
        return res.status(200).json({ message: 'Camera state updated successfully' });
    } catch (error: any) {
        console.error('Error in /updateCameraState route:', error);
        return res.status(500).json({ 
            error: 'Server error',
            details: error.message || 'An unexpected error occurred'
        });
    }
});
```

---

### Step 5: Update PlayerService
**File**: `src/server/services/playerService.ts`

**Changes**:
1. Ensure `getPlayers()` includes `camera_state` in SELECT query
2. Map database `camera_state` to player object's `cameraState` field
3. Ensure only local player's camera state is returned (already filtered by userId)

**Check**:
- Verify `getPlayers(gameId, userId)` includes camera_state in query
- Map JSONB to TypeScript interface

---

### Step 6: Update CameraController (Client)
**File**: `src/client/components/CameraController.ts`

**Changes**:
1. Add `localPlayerId` parameter or get from GameStateService/PlayerStateService
2. Update `setupCamera()` to load from local player's camera state
3. Update `saveCameraState()` to include playerId in API call

**Key Changes**:
```typescript
export class CameraController {
    private localPlayerId: string | null = null;
    
    // Add method to set local player ID
    public setLocalPlayerId(playerId: string | null): void {
        this.localPlayerId = playerId;
    }
    
    public setupCamera(): void {
        // ... existing setup code ...
        
        // Load camera state from local player instead of gameState
        const localPlayer = this.getLocalPlayer();
        if (localPlayer?.cameraState) {
            this.camera.setZoom(localPlayer.cameraState.zoom);
            this.camera.scrollX = localPlayer.cameraState.scrollX;
            this.camera.scrollY = localPlayer.cameraState.scrollY;
        } else {
            // Use default settings
            // ... existing default code ...
        }
    }
    
    private getLocalPlayer() {
        // Get from gameState.players using localPlayerId
        if (!this.localPlayerId || !this.gameState.players) return null;
        return this.gameState.players.find(p => p.id === this.localPlayerId);
    }
    
    public async saveCameraState(): Promise<void> {
        if (!this.localPlayerId) {
            console.warn('Cannot save camera state: no local player ID');
            return;
        }
        
        const currentState: CameraState = {
            zoom: this.camera.zoom,
            scrollX: this.camera.scrollX,
            scrollY: this.camera.scrollY
        };
        
        // Update local player's state in gameState
        const localPlayer = this.getLocalPlayer();
        if (localPlayer) {
            localPlayer.cameraState = currentState;
        }
        
        try {
            // Save to database with playerId
            const response = await fetch('/api/game/updateCameraState', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: this.gameState.id,
                    playerId: this.localPlayerId,  // NEW: Include playerId
                    cameraState: currentState
                })
            });
            
            if (!response.ok) {
                console.error('Failed to save camera state:', await response.text());
            }
        } catch (error) {
            console.error('Error saving camera state:', error);
        }
    }
}
```

---

### Step 7: Update GameScene (Client)
**File**: `src/client/scenes/GameScene.ts`

**Changes**:
1. Get `localPlayerId` from `PlayerStateService`
2. Pass `localPlayerId` to `CameraController.setLocalPlayerId()`
3. Remove any direct camera state access from `gameState.cameraState`

**Code**:
```typescript
// In GameScene initialization
const localPlayerId = this.playerStateService.getLocalPlayerId();
this.cameraController.setLocalPlayerId(localPlayerId);
```

---

### Step 8: Update GameStateService.getGame() (Backend)
**File**: `src/server/services/gameService.ts`

**Changes**:
- Remove `cameraState` from return object (or make it undefined)
- Camera state is now part of player objects via `PlayerService.getPlayers()`

---

## Testing Checklist

### Database Migration
- [ ] Migration runs without errors
- [ ] Existing games with camera_state migrate correctly to first player
- [ ] Games without camera_state handle gracefully
- [ ] New games start without camera_state in games table

### Backend API
- [ ] `POST /api/game/updateCameraState` validates player ownership
- [ ] Unauthenticated requests are rejected
- [ ] Players can only update their own camera state
- [ ] Invalid playerId returns appropriate error
- [ ] Camera state persists after game reload

### Client
- [ ] Camera loads correctly for local player on game start
- [ ] Camera changes save for local player only
- [ ] Different players maintain independent camera states
- [ ] Camera state persists when switching turns
- [ ] Default camera state applies if player has no saved state
- [ ] Camera state updates when player rejoins game

### Multi-Player Testing
- [ ] Player A's camera changes don't affect Player B
- [ ] Both players can have different zoom/pan simultaneously
- [ ] Camera state persists across turn changes
- [ ] Camera state survives page refresh

---

## Rollback Plan

If issues arise, we can:
1. Keep `games.camera_state` column (don't drop it in migration)
2. Add feature flag to switch between global and per-player camera state
3. Migration can be reversed by copying camera_state back from players table

---

## Dependencies
- ✅ Issue #97 (Client Player Identification) - **COMPLETED**
- PlayerStateService provides `getLocalPlayerId()` method

---

## Related Issues
- Part of multi-player turn management epic (TURN_MANAGEMENT_PLAN.md Phase 2)
- Blocks issues that depend on per-player state (e.g., per-player demand cards)

