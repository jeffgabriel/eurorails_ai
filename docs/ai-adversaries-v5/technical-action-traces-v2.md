
# Technical Action Traces â€” EuroRails Online

> Full code-path traces for every core game action. Each trace follows the path from user input through client, server, database, socket, and back to client rendering. Grounded in actual code with file paths and line numbers.
>
> Companion to [User Journeys](./user-journeys.md) and [System Architecture Reference](./system-architecture.md).

---

## Table of Contents

1. [Build Track](#1-build-track)
2. [Move Train](#2-move-train)
3. [Pick Up Load](#3-pick-up-load)
4. [Deliver Load](#4-deliver-load)
5. [End Turn / Advance to Next Player](#5-end-turn--advance-to-next-player)
6. [Upgrade Train](#6-upgrade-train)
7. [Initial Game Setup / Train Placement](#7-initial-game-setup--train-placement)
8. [Cross-Cutting Concerns](#cross-cutting-concerns)
   - [Coordinate Systems](#coordinate-systems--where-grid-vs-pixel-appears)
   - [Socket Event Completeness](#socket-event-completeness--db-writes-without-events)
   - [Implicit Contracts](#implicit-contracts)
   - [Route Handler vs Service Layer](#route-handler-vs-service-layer--logic-location)
9. [Appendix A: Socket Event Reference](#appendix-a-complete-socket-event-reference)
10. [Appendix B: Database Schema](#appendix-b-database-schema-quick-reference)
11. [Appendix C: Key Constants](#appendix-c-key-constants)

---

## 1. Build Track

### User Input

Human player toggles "crayon mode" via the crayon button in `PlayerHandScene`, then clicks mileposts on the map to draw track segments. A preview path (green = valid, red = invalid) renders on hover via Dijkstra pathfinding. Each click commits a segment locally.

When the player exits drawing mode (clicks crayon button again or clicks "Next Player"), all locally-drawn segments are saved to the server.

### Client Processing

**Drawing mode toggle:** `GameScene.toggleDrawingMode()` â†’ `TrackDrawingManager.toggleDrawingMode()` (line 299)

**Click handler:** `TrackDrawingManager.handleDrawingClick()` (line 575)
- Validates: starting point is a major city OR connected to existing network
- Pathfinding: Uses Dijkstra to compute path from last clicked point to target
- For each segment in the path:
  - Calculates cost via `calculateTrackCost()` (line 1275)
  - Validates cost via `isValidCost()` (line 358): `previousSessionsCost + turnBuildCost + segmentCost <= turnBuildLimit(20M)` AND `<= playerMoney`
  - Creates `TrackSegment` object (line 655-671):
    ```typescript
    {
      from: { x, y, row, col, terrain: TerrainType },
      to:   { x, y, row, col, terrain: TerrainType },
      cost: number
    }
    ```
  - Pushes to `currentSegments[]` array
  - Draws immediately on canvas via `drawTrackSegment()` (line 1461)

**Hover preview:** `handleDrawingHover()` (line 732)
- Normal mode: Dijkstra pathfinding â†’ green preview
- SHIFT mode: Direct adjacency only â†’ orange preview
- Invalid paths: red preview (water, over budget, overlapping opponents)
- Cost updates in real-time: `queueCostUpdate()` with 100ms debounce â†’ `PlayerHandScene.getBuildCostDisplay()` (line 220) renders with color coding:
  - White: normal
  - Yellow: 80%+ of turn limit
  - Orange: over turn limit
  - Red: insufficient funds

**Cost calculation:** `calculateTrackCost()` (line 1275-1354)
- Base: `TERRAIN_COSTS[to.terrain]` (Clear=1, Mountain=2, Alpine=5, SmallCity=3, MediumCity=3, MajorCity=5, Water=0, FerryPort=0)
- Major city first connection: fixed 5 ECU
- Ferry port: `ferryConnection.cost` per route (4-16 ECU, route-specific)- Water crossing: `getWaterCrossingExtraCost()` â†’ River=2, Lake=3, Ocean Inlet=3 (additive)

**Undo (uncommitted):** `undoLastUncommittedSegment()` (line 137)
- Pops from `currentSegments[]`, subtracts cost from `turnBuildCost`, redraws

### Client â†’ Server

**Trigger:** Exiting drawing mode â†’ `saveCurrentTracks()` (line 418)

```
POST /api/tracks/save
Authorization: Bearer {jwt}
Body: {
  gameId: string,
  playerId: string,
  trackState: {
    playerId: string,
    gameId: string,
    segments: TrackSegment[],      // ALL segments (existing + new)
    totalCost: number,              // cumulative ever
    turnBuildCost: number,          // this turn only
    lastBuildTimestamp: Date
  }
}
```

### Server Processing

**Route:** `trackRoutes.ts` line 13-46
**Service:** `TrackService.saveTrackState(gameId, playerId, trackState)`

**Database write:**
```sql
INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost)
VALUES ($1, $2, $3::jsonb, $4, $5)
ON CONFLICT (game_id, player_id)
DO UPDATE SET segments = $3::jsonb, total_cost = $4, turn_build_cost = $5, updated_at = CURRENT_TIMESTAMP;
```

**Columns written:**
| Table | Column | Value |
|-------|--------|-------|
| `player_tracks` | `segments` | JSONB array of ALL `TrackSegment` objects |
| `player_tracks` | `total_cost` | Cumulative cost (INTEGER) |
| `player_tracks` | `turn_build_cost` | This turn's spend (INTEGER, max 20) |
| `player_tracks` | `last_build_timestamp` | TIMESTAMPTZ |

### Server â†’ Client

**Socket event:** `track:updated`
**Emitter:** `trackRoutes.ts` line 28-36
```typescript
io.to(gameId).emit('track:updated', {
  gameId,
  playerId,
  timestamp: Date.now()
});
```

**Note:** The event payload does NOT include segment data â€” clients must re-fetch.

### Client Handling

**Listener:** `GameScene.ts` line 1230-1243
```typescript
socketService.onTrackUpdated(async (data) => {
  if (data.gameId === this.gameState.id && this.trackManager) {
    await this.trackManager.loadExistingTracks();  // GET /api/tracks/{gameId}
    this.trackManager.drawAllTracks();              // Redraws ALL player tracks
  }
});
```

**Rendering:** `TrackDrawingManager.drawAllTracks()` (line 279)
- Iterates `playerTracks` map (all players)
- For each player's segments: draws colored lines from `(from.x, from.y)` to `(to.x, to.y)`
- Color: `parseInt(player.color.replace('#', '0x'))`

### State Changes Summary

| Layer | What Changes |
|-------|-------------|
| DB: `player_tracks.segments` | All segments (JSONB) |
| DB: `player_tracks.turn_build_cost` | This turn's spend |
| DB: `player_tracks.total_cost` | Cumulative spend |
| Client: `TrackDrawingManager.playerTracks` | Map of all players' tracks |
| Client: canvas | Track lines rendered |
| **NOT changed yet:** `players.money` | Deducted at turn end, not at save time |

### Bot Implementation Notes

- **Ferry port costs:** `FerryPort` terrain has a base cost of 0, but building to a ferry port requires paying the route-specific `ferryConnection.cost` (4-16 ECU). If you use the flat terrain cost instead, Dijkstra will route through ferry ports as "free" nodes and produce segments with `cost: 0`, which validation will reject.
- **Pixel coordinates:** Segments MUST include valid `x, y` pixel coordinates (computed via `calculateWorldCoordinates(col, row)`). If `x:0, y:0` is stored, tracks render at the top-left corner of the map, not at the correct milepost.
- **Socket emission:** The route handler emits `track:updated`. If a bot saves track via `TrackService.saveTrackState()` directly (bypassing the route), it MUST also emit `track:updated` or the human player won't see the bot's track.
- **Turn build limit:** The 20M limit is enforced client-side via `isValidCost()`. The server stores `turn_build_cost` but does not currently hard-reject saves that exceed 20M. The bot's `PlanValidator` must enforce this.

---

## 2. Move Train

### User Input

Human clicks on a connected milepost along their track (or through major cities via the red area). The train sprite animates to the new position.

### Client Processing

**Click handler flow:**
1. Map click â†’ `MovementExecutor.executeMovement(currentPlayer, destination, pointer)` (`MovementExecutor.ts`)
2. **Validation:** `TrainMovementManager.canMoveTo(point)` (validates movement points, reversal rules, ferry state, hex adjacency)
3. **Track usage check:** `computeTrackUsageForMove({ allTracks, from, to, currentPlayerId })` from `trackUsageFees.ts`
   - If opponent track used: confirmation dialog appears ("Fee: ECU 4M. Continue?")
   - If player cancels: movement points restored, no API call
4. If valid: immediately deducts movement points client-side

### Client â†’ Server

```
POST /api/players/move-train
Authorization: Bearer {jwt}
Body: {
  gameId: string,
  to: { row: number, col: number, x: number, y: number },
  movementCost: number
}
```

**File:** `PlayerStateService.ts` line 229 (`moveTrainWithFees`)

### Server Processing

**Route:** `playerRoutes.ts` line 624
**Service:** `PlayerService.moveTrainForUser(args)` (line 1062)

**Database transaction:**
```sql
BEGIN;

-- 1. Fetch player with row lock
SELECT id, money, position_row, position_col, position_x, position_y, current_turn_number
FROM players WHERE game_id = $1 AND user_id = $2 FOR UPDATE;

-- 2. Validate game status (must be 'active', NOT 'initialBuild')
SELECT current_player_index, status FROM games WHERE id = $1 FOR UPDATE;

-- 3. Validate it's this player's turn
SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2;

-- 4. Compute track usage fees (4M per opponent whose track is traversed)
-- Reads: player_tracks for all players
-- Reads: turn_actions to check which opponents already paid this turn

-- 5. Update payer money (decrease) and payee money (increase)
UPDATE players SET money = money - $1 WHERE id = $2;  -- payer
UPDATE players SET money = money + $1 WHERE id = $2;  -- each payee

-- 6. Update position (ALL 4 COLUMNS â€” see INV-1)
UPDATE players
SET position_row = $1, position_col = $2, position_x = $3, position_y = $4
WHERE game_id = $5 AND id = $6;

-- 7. Record action in turn_actions
INSERT INTO turn_actions (player_id, game_id, turn_number, actions)
VALUES ($1, $2, $3, $4::jsonb)
ON CONFLICT (player_id, game_id, turn_number)
DO UPDATE SET actions = turn_actions.actions || $4::jsonb;

-- 8. Record movement history
INSERT INTO movement_history (player_id, game_id, turn_number, movement_path)
VALUES ($1, $2, $3, $4::jsonb)
ON CONFLICT DO UPDATE SET movement_path = $4;

COMMIT;
```

**Columns written:**
| Table | Column | Value |
|-------|--------|-------|
| `players` | `position_row` | Grid row (INTEGER) |
| `players` | `position_col` | Grid col (INTEGER) |
| `players` | `position_x` | Pixel X (INTEGER) |
| `players` | `position_y` | Pixel Y (INTEGER) |
| `players` | `money` | Updated (decreased by fees) |
| `turn_actions` | `actions` | JSONB append with move record |
| `movement_history` | `movement_path` | JSONB movement path |

**Preconditions enforced:**
- Game status must be `'active'` (blocks during `initialBuild` â€” line 1179)
- Must be player's turn
- Sufficient money for track usage fees

**Server response:**
```json
{
  "feeTotal": 8,
  "ownersUsed": ["player-uuid-1", "player-uuid-2"],
  "ownersPaid": [{ "playerId": "player-uuid-1", "amount": 4 }],
  "affectedPlayerIds": ["current-player-uuid", "player-uuid-1"],
  "updatedPosition": { "row": 15, "col": 22, "x": 1024, "y": 768 },
  "updatedMoney": 142
}
```

### Server â†’ Client

**Socket event:** `state:patch`
**Emitter:** `playerRoutes.ts` line 660 â†’ `emitStatePatch(gameId, { players: [affected...] })`
```typescript
state:patch {
  patch: { players: [updatedPlayerData...] },
  serverSeq: N
}
```

**Payload includes:** Updated position, money for all affected players (payer + payees)

### Client Handling

**Listener:** `GameScene.ts` line 324 (socket `state:patch` handler)
1. Check `serverSeq` â€” drop if stale (seq <= current)
2. For local player: merge carefully (preserve client-managed `remainingMovement`, `ferryState`, `movementHistory`)
3. For other players: overwrite with server data
4. `UIManager.updateTrainPosition(playerId, x, y, row, col)` â†’ `TrainSpriteManager.createOrUpdateSprite()`
5. Sprite placed at `(x + offsetX, y + offsetY)` where offset is for stacking multiple trains

### State Changes Summary

| Layer | What Changes |
|-------|-------------|
| DB: `players.position_*` | All 4 position columns |
| DB: `players.money` | Decreased by fees (payer), increased (payees) |
| DB: `turn_actions.actions` | Move action appended |
| DB: `movement_history` | Movement path updated |
| Client: `gameState.players[i].trainState.position` | Updated position |
| Client: `gameState.players[i].money` | Updated money |
| Client: train sprites | Repositioned on map |

### Bot Implementation Notes

- **Position Quad (INV-1):** When updating position, ALL 4 columns (`position_row`, `position_col`, `position_x`, `position_y`) must be set. The read path uses `position_x !== null` as the sentinel â€” if only row/col are set, the player appears to have no position.
- **Coordinate conversion:** To compute pixel coordinates from grid: `x = col * 50 + 120 + (row % 2 === 1 ? 25 : 0)`, `y = row * 45 + 120`
- **Movement during initialBuild is blocked server-side** (line 1179). Bots must not attempt movement during initialBuild.- **Route handler logic:** Track usage fee computation and payment tracking lives in the route handler / PlayerService method. Bots calling `moveTrainForUser` get this for free. If bots bypass this (direct DB writes), fees won't be computed.

---

## 3. Pick Up Load

### User Input

Human's train arrives at a city with available loads. `LoadDialogScene` appears automatically. Human clicks a load in the "Available for Pickup" section.

### Client Processing

**Dialog:** `LoadDialogScene.ts`
- `createPickupSection()` (line 160): Lists available loads from `LoadService.getCityLoadDetails(cityName)`
- Each load shown as a button: `(loadType) (count)`
- Click handler: `handleLoadPickup(loadType)` (line 327)
  - Validates train capacity: `TRAIN_PROPERTIES[trainType].capacity` (Freight/FastFreight=2, HeavyFreight/Superfreight=3)
  - Calls `LoadService.pickupLoad()` â€” server authoritative
  - Calls `PlayerStateService.updatePlayerLoads()` â€” persists to server

### Client â†' Server

```
POST /api/loads/pickup
Authorization: Bearer {jwt}
Body: {
  gameId: string,
  cityName: string,
  loadType: string   // e.g., "Oil", "Wine", "Steel"
}
```

### Server Processing

> **Note:** Unlike other player actions, load pickup does NOT use a `PlayerService` method. There is no `PlayerService.pickupLoadForUser()`.

**Route:** `loadRoutes.ts:53` (`handleLoadPickup`)
**Service:** `LoadService.pickupDroppedLoad(city, loadType, gameId)` â€" handles dropped loads
**Player loads update:** Player's `loads` array is updated via the player update endpoint separately

**For dropped loads:**
```sql
UPDATE load_chips SET is_dropped = false
WHERE city_name = $1 AND type = $2 AND game_id = $3 AND is_dropped = true;
```

**Columns written:**
| Table | Column | Value |
|-------|--------|-------|
| `load_chips` | `is_dropped` | Set to `false` (if dropping up dropped load) |

> **Bot implementation note:** A unified `pickupLoadForUser` method should be created in PlayerService to handle both configured and dropped load pickups in a single transaction, matching the pattern of other player actions like `deliverLoadForUser`.

### Server â†’ Client

**Socket event:** `state:patch`
```typescript
state:patch { patch: { players: [updatedPlayer] }, serverSeq }
```

### Client Handling

1. `state:patch` handler merges updated `loads` array into player state
2. `PlayerHandScene` refreshes to show load chip on train card
3. `LoadDialogScene` may refresh if still open (remaining loads updated)

### Bot Implementation Notes

- **Load availability is global:** Some loads have limited supply. The bot must check `LoadService.isLoadAvailableAtCity()` before planning a pickup.
- **Dropped loads:** Players can drop loads at cities. Dropped loads are tracked in the `load_chips` table with `is_dropped=true` and `city_name` set. A bot can pick up a dropped load the same way as a source load.
- **No pickup during initialBuild:** Server blocks this. OptionGenerator must not generate PickupLoad during initialBuild.
---

## 4. Deliver Load

### User Input

Human is at a city matching one of their demand cards and carrying the required load. `LoadDialogScene` shows the "Can be Delivered" section. Human clicks the delivery button.

### Client Processing

**Dialog:** `LoadDialogScene.ts`
- `createDeliverySection()` (line 184): Lists deliverable loads (loads on train that match a demand card for this city)
- Each deliverable load shows: load type and payment amount
- Click handler: `handleLoadDelivery({ type, payment, cardId })` (line 393)
  1. `LoadService.returnLoad()` â€” puts load chip back in tray
  2. `PlayerStateService.deliverLoad()` â€” processes delivery server-side

### Client â†’ Server

```
POST /api/players/deliver-load
Authorization: Bearer {jwt}
Body: {
  gameId: string,
  city: string,         // e.g., "Berlin"
  loadType: string,     // e.g., "Wine"
  cardId: number        // demand card ID from player's hand
}
```

### Server Processing

**Service:** `PlayerService.deliverLoadForUser(gameId, userId, city, loadType, cardId)` (line 781)

**Database transaction:**
```sql
BEGIN;

-- 1. Fetch player (FOR UPDATE)
SELECT id, money, debt_owed, hand, loads, current_turn_number
FROM players WHERE game_id = $1 AND user_id = $2 FOR UPDATE;

-- 2. Validate game status (NOT initialBuild)
SELECT current_player_index, status FROM games WHERE id = $1 FOR UPDATE;

-- 3. Validate it's player's turn
-- 4. Validate card in hand (cardId exists in hand INTEGER[])
-- 5. Validate load on train (loadType exists in loads TEXT[])
-- 6. Validate demand card matches city and loadType

-- 7. Calculate payment with debt repayment
--    repayment = min(payment, debt_owed)
--    netPayment = payment - repayment
--    updatedMoney = money + netPayment
--    updatedDebt = debt_owed - repayment

-- 8. Replace demand card
--    DemandDeckService.discardCard(cardId) â†’ add to discard pile
--    DemandDeckService.drawCard() â†’ draw replacement from deck
--    newHand = hand.filter(id => id !== cardId).concat(newCard.id)

-- 9. Remove load from train
--    newLoads = loads.filter(l => l !== loadType)  (removes first match)

-- 10. Update player
UPDATE players
SET money = $1, hand = $2, loads = $3, debt_owed = $4
WHERE game_id = $5 AND id = $6;

-- 11. Record action
INSERT INTO turn_actions ... ON CONFLICT DO UPDATE SET actions = actions || $7::jsonb;
-- Action: { kind: "deliver", city, loadType, cardIdUsed, newCardIdDrawn, payment, repayment }

COMMIT;
```

**Rollback compensation:** If the transaction fails after in-memory deck mutations, compensates to restore consistency:
```typescript
if (drewCardId) demandDeckService.returnDealtCardToTop(drewCardId);
if (discardedCardId) demandDeckService.returnDiscardedCardToDealt(discardedCardId);
```

**Columns written:**
| Table | Column | Value |
|-------|--------|-------|
| `players` | `money` | Increased by net payment (INTEGER) |
| `players` | `hand` | INTEGER[] â€” old card replaced with new |
| `players` | `loads` | TEXT[] â€” delivered load removed |
| `players` | `debt_owed` | Decreased by repayment (INTEGER) |
| `turn_actions` | `actions` | Delivery action appended |
| In-memory | `DemandDeckService.dealtCards` | Card removed |
| In-memory | `DemandDeckService.discardPile` | Card added |
| In-memory | `DemandDeckService.drawPile` | Card drawn |

**Server response:**
```json
{
  "payment": 12,
  "repayment": 0,
  "updatedMoney": 62,
  "updatedDebtOwed": 0,
  "updatedLoads": ["Coal"],
  "newCard": { "id": 42, "demands": [{ "city": "Paris", "resource": "Wine", "payment": 8 }] }
}
```

### Server â†’ Client

**Socket event:** `state:patch`
```typescript
state:patch {
  patch: { players: [updatedPlayer] },
  serverSeq
}
```

Player data includes updated money, hand (new card visible), loads (delivered load removed).

### Client Handling

1. `state:patch` merges updated player data
2. Money display updates in leaderboard
3. Demand card hand refreshes (old card gone, new card appears)
4. Load chip removed from train display
5. `LoadDialogScene` closes after successful delivery

### Bot Implementation Notes

- **One demand per card:** A demand card can only be fulfilled once. The bot must track which card matches which delivery.
- **Debt repayment is automatic:** If the bot has debt (from mercy borrowing), payment is automatically split: `min(payment, debt)` goes to debt repayment, remainder goes to cash.
- **Card replacement:** After delivery, the bot's hand changes. The `WorldSnapshot` must be refreshed if the bot plans multiple deliveries in one turn.
- **No delivery during initialBuild:** Server blocks this.
---

## 5. End Turn / Advance to Next Player

### User Input

Human clicks the green **"Next Player"** button in the leaderboard (upper-right corner of screen).

**Button location:** `LeaderboardManager.ts` `createNextPlayerButton()` (line 291), button text at line 315
- Text: "Next Player" (interactive when it's local player's turn)
- Text: "Wait Your Turn" (grayed out, non-interactive when not player's turn)
- Click: calls `nextPlayerCallback()` â†’ `GameScene.nextPlayerTurn()`

**Alternative:** "More actions..." â†’ "Discard & End Turn" button in `PlayerHandScene.ts` line 664
- Discards entire hand, draws 3 new cards, then advances turn
- Only available if: no track built, no server-tracked actions this turn

### Client Processing

**`GameScene.nextPlayerTurn()`** (line 719):

1. **Exit drawing mode** (line 749): If still drawing, toggles off â†’ triggers save
2. **Deduct build cost** (line 759-772):
   - `buildCost = playerTracks.get(playerId).turnBuildCost`
   - If cost > 0: `POST /api/players/updatePlayerMoney` with `money - buildCost`
3. **End-turn cleanup** (line 777-780):
   - `trackManager.endTurnCleanup(playerId)` â†’ `clearLastBuildCost()` resets `turn_build_cost = 0` in DB
   - `uiManager.clearTurnUndoStack()` â†’ clears undo history
4. **Increment turn number** (line 785)
5. **Check victory** (line 798): If local player meets conditions, prompt declaration
6. **Advance turn** (line 820): `gameStateService.nextPlayerTurn()`

### Client â†’ Server

```
POST /api/players/updateCurrentPlayer
Authorization: Bearer {jwt}
Body: {
  gameId: string,
  currentPlayerIndex: number   // (currentIndex + 1) % playerCount
}
```

**File:** `GameStateService.ts` line 74

### Server Processing

**Service:** `PlayerService.updateCurrentPlayerIndex(gameId, nextIndex)`

**Database:**
```sql
UPDATE games SET current_player_index = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2;
```

**Column written:**
| Table | Column | Value |
|-------|--------|-------|
| `games` | `current_player_index` | Next player index (INTEGER) |

**Then:** `emitTurnChange(gameId, nextIndex, nextPlayerId)` (from `socketService.ts` line 553)

### Server â†’ Client (Two Events)

**Event 1:** `turn:change`
```typescript
io.to(gameId).emit('turn:change', {
  currentPlayerIndex: number,
  currentPlayerId: string,
  gameId: string,
  timestamp: number
});
```

**Event 2 (sometimes):** `state:patch` with `{ currentPlayerIndex }`

### Client Handling

**Listener:** `socket.ts` line 225 â†' `GameStateService.updateCurrentPlayerIndex()` â†' triggers listeners â†' `GameScene.handleTurnChange()` (line 1025)

**`handleTurnChange()` step-by-step:**
1. `refreshPlayerData()` â€” `GET /api/players/{gameId}`, merge server data into local state
2. Compare `newActivePlayerId` vs `previousActivePlayerId` â†’ show "It's your turn!" toast (4000ms) if local player just became active
3. Set `gameState.currentPlayerIndex = currentPlayerIndex`
4. `trackManager.resetTurnBuildLimit()` â†’ 20M budget restored
5. Handle ferry transitions (teleport train, set `justCrossedFerry` flag)
6. Reset movement points: `TRAIN_PROPERTIES[trainType].speed` (9 or 12), halved if post-ferry
7. Update UI: leaderboard (highlight active player), hand display, banners
8. If player has no position: prompt starting city selection

### Side Effect: Bot Turn Trigger â€" â š ï¸ PLANNED (not yet implemented)

> **Current state:** `emitTurnChange()` at `socketService.ts:553` only emits the socket event. The `BotTurnTrigger` module does not exist on this branch. The behavior below describes the planned integration.

**Planned:** `emitTurnChange()` will dynamic-import and call `BotTurnTrigger`:

```typescript
import('../ai/BotTurnTrigger').then(({ BotTurnTrigger }) => {
  BotTurnTrigger.onTurnChange(gameId, currentPlayerIndex, currentPlayerId);
});
```

**Planned `BotTurnTrigger.onTurnChange()` behavior:**
1. Guard: `pendingBotTurns.has(gameId)` â†' prevent double execution2. Look up player at index â†' if not `is_bot`, return
3. Check `hasConnectedHuman(gameId)` â†' if none, queue turn for later
4. `pendingBotTurns.add(gameId)` â†' `setTimeout(1500ms)` â†' `executeBotTurn()`
5. On completion: `advanceTurnAfterBot()`:
   - If `status === 'initialBuild'`: `InitialBuildService.advanceTurn(gameId)`   - If `status === 'active'`: `PlayerService.updateCurrentPlayerIndex(gameId, nextIndex)`

### State Changes Summary

| Layer | What Changes |
|-------|-------------|
| DB: `games.current_player_index` | Advanced to next player |
| DB: `players.money` | Decreased by build cost (if any) |
| DB: `player_tracks.turn_build_cost` | Reset to 0 |
| DB: `players.current_turn_number` | Incremented |
| Client: `gameState.currentPlayerIndex` | Updated |
| Client: leaderboard | New player highlighted |
| Client: movement/ferry state | Reset for new turn |
| Side effect: `BotTurnTrigger` | **⚠️ PLANNED** — will schedule bot execution once implemented |

### Alternative: Discard & End Turn

The "Discard & End Turn" button (`PlayerHandScene.ts` line 664) follows a different server path:

**Endpoint:** `POST /api/players/discard-hand` (authenticated)
**Payload:** `{ "gameId": "uuid" }`

**Service:** `PlayerService.discardHandForUser(gameId, userId)` (line 1555) â€” within a single transaction:
1. Lock player + game rows (`FOR UPDATE`)
2. Block during `initialBuild`
3. Verify constraints: `turn_build_cost === 0`, no `turn_actions` this turn
4. Discard old hand â†’ `demandDeckService.discardCard(id)` for each
5. Draw 3 new cards â†’ `demandDeckService.drawCard()` x 3
6. Update `players.hand`, increment `players.current_turn_number`
7. Calculate `nextIndex = (currentPlayerIndex + 1) % playerCount`
8. Update `games.current_player_index`
9. Commit â†’ emit `turn:change` AND `state:patch`

**Response:** `{ "currentPlayerIndex": 1, "nextPlayerId": "uuid", "nextPlayerName": "Alice" }`

**Key difference:** This path emits TWO socket events (`turn:change` + `state:patch`) AND the HTTP response includes `currentPlayerIndex` â€” the client may receive turn change notifications from three sources. This is a potential race condition surface.

### All `turn:change` Emission Points

| Location | When |
|----------|------|
| `PlayerService.updateCurrentPlayerIndex()` (playerService.ts:593) | Normal "Next Player" turn advancement |
| `PlayerService.discardHandForUser()` (playerService.ts:1555) | Discard & End Turn |
| `InitialBuildService.advanceTurn()` | **⚠️ PLANNED** — within-round, round transition, phase transition |
| `BotTurnTrigger.advanceTurnAfterBot()` â†' calls `PlayerService.updateCurrentPlayerIndex()` | **⚠️ PLANNED** — after bot completes its turn |

### Bot Implementation Notes

- **Double Execution Prevention:** The `pendingBotTurns` Set prevents a bot from executing twice for the same game. Redundant `emitTurnChange()` calls â€” one from the service, one from the route handler. Fix: only emit from the service.
- **Phase-Aware Advancement (INV-3):** During `initialBuild`, turn advancement MUST use `InitialBuildService.advanceTurn()`, not `PlayerService.updateCurrentPlayerIndex()`. The former handles round transitions (clockwise â†’ counter-clockwise) and the phase transition to `active`.
- **Route handler logic:** `GameScene.nextPlayerTurn()` deducts build cost and clears turn build cost as separate clientâ†’server calls before calling `updateCurrentPlayer`. Bots must ensure build cost is properly deducted from money and turn build cost is reset. The `TurnExecutor` handles this within its transaction.
- **Turn number increment:** The client increments `current_turn_number` and persists it. Bots must also increment this per turn.
- **Bot turn chaining:** When `emitTurnChange()` fires and the next player is a bot, `BotTurnTrigger` schedules execution after 1500ms delay. After the bot completes, `advanceTurnAfterBot()` emits another `turn:change`, potentially chaining into the next bot.

---

## 6. Upgrade Train

### User Input

Human opens "More actions..." menu in PlayerHandScene, then clicks "Upgrade" or "Crossgrade" option, selects target train type from a modal.

### Client Processing

**Trigger:** `PlayerHandScene.ts` â†’ `openActionsModal()` (line 548)
**Service call:** `GameStateService.purchaseTrainType(gameId, kind, targetTrainType)` (line 286)

**Valid transitions:**
| From | To | Kind | Cost |
|------|----|------|------|
| Freight | FastFreight | upgrade | 20M |
| Freight | HeavyFreight | upgrade | 20M |
| FastFreight | Superfreight | upgrade | 20M |
| HeavyFreight | Superfreight | upgrade | 20M |
| FastFreight | HeavyFreight | crossgrade | 5M |
| HeavyFreight | FastFreight | crossgrade | 5M |

### Client â†’ Server

```
POST /api/players/upgrade-train
Authorization: Bearer {jwt}
Body: {
  gameId: string,
  kind: "upgrade" | "crossgrade",
  targetTrainType: string
}
```

### Server Processing

**Route:** `playerRoutes.ts` line 388
**Service:** `PlayerService.purchaseTrainType(gameId, userId, kind, targetTrainType)` (line 1932)

**Validations:**
- `upgrade`: `turnBuildCost === 0` required (can't upgrade AND build in same turn)
- `crossgrade`: `turnBuildCost <= 15` required (can crossgrade + build up to 15M)
- Valid transition exists (see table above)
- Sufficient funds

**Database:**
```sql
BEGIN;
SELECT id, money, train_type FROM players WHERE game_id = $1 AND user_id = $2;
-- Validate game turn, funds, transition legality
UPDATE players SET train_type = $1, money = money - $2 WHERE game_id = $3 AND id = $4;
COMMIT;
```

**Columns written:**
| Table | Column | Value |
|-------|--------|-------|
| `players` | `train_type` | New train type string |
| `players` | `money` | Decreased by cost |

### Server â†’ Client

**Socket event:** `state:patch` with updated player (new train_type, reduced money)

### Client Handling

1. Train type updates in game state
2. Train sprite texture changes: `TrainSpriteManager.refreshTrainSpriteTextures()`
3. Money display updates in leaderboard
4. Speed/capacity properties change for future turns

### Bot Implementation Notes

- **Phase restriction (INV-5):** Attempting UpgradeTrain during `initialBuild` hits the `turnBuildCost !== 0` guard if track was already built that turn. The `OptionGenerator` must not generate UpgradeTrain options during `initialBuild`.- **Crossgrade + build interaction:** After a crossgrade (5M), the turn build limit reduces to 15M. `TrackDrawingManager.setTurnBuildLimit(15)` is called. The bot's `PlanValidator` must account for this.

---

## 7. Initial Game Setup / Train Placement

### Overview

The game starts in `initialBuild` phase. Players build track (no movement) for 2 rounds. Train placement happens when a player first enters the active phase and has no position.

### Lobby â†' Game Start

> **⚠️ Current state:** `LobbyService.startGame()` (line ~581) transitions directly from `setup` to `active`, skipping initialBuild. The flow below describes the **planned** behavior.

**Host clicks "Start Game":**
1. `POST /api/lobby/games/{id}/start`
2. `LobbyService.startGame()` → validates creator, setup status, 2+ players
3. **PLANNED:** `InitialBuildService.initPhase(client, gameId)`:
   ```sql
   SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC;
   UPDATE games SET
     status = 'initialBuild',
     initial_build_round = 1,
     initial_build_order = $1,    -- JSON array of player IDs
     current_player_index = 0
   WHERE id = $2;
   ```
4. Socket: `game-started` emitted to `lobby-{gameId}` room
5. Clients navigate to `/game/{gameId}` → `SetupScene` → `GameScene`

### InitialBuild Phase — ⚠️ NOT YET IMPLEMENTED

> Requires `InitialBuildService` and migration 031. Currently, games skip this phase entirely.

**What players can do (planned):**
- Build track (up to 20M per turn) — must start from a major city
- Pass turn (via "Next Player" button)
- **Cannot:** move train, pick up loads, deliver loads

**What players cannot do during initialBuild (server-enforced when status is `initialBuild`):**
- `moveTrainForUser()` checks `status !== 'initialBuild'`
- `deliverLoadForUser()` checks game status
- Load pickup route checks game status
- `OptionGenerator.generate()` only generates BuildTrack/BuildTowardMajorCity/PassTurn during initialBuild
**Turn advancement during initialBuild (planned):**
- `InitialBuildService.advanceTurn(gameId)`:
  - Round 1: advance `currentIndex` within clockwise order
  - Round 1 complete → Round 2: reverse order, reset `currentIndex = 0`
  - Round 2 complete → transition to `active`

### Train Placement (First Active Turn)

**When a player enters the active phase with no position:**

`handleTurnChange()` (GameScene.ts line 1025) detects `player.position === null` and prompts starting city selection.

**Client flow:**
1. `CitySelectionManager` activates â€” major cities become clickable
2. Human clicks a major city â†’ position set locally
3. Position persisted to server (all 4 columns)

**Bot flow (in AIStrategyEngine):**
1. `AIStrategyEngine.takeTurn()` checks if bot has a position
2. If no position: auto-place at best major city (closest to demand card destinations)
3. `placeInitialTrain()` â€” sets all 4 position columns: `position_row`, `position_col`, `position_x`, `position_y`4. `position_x` computed from grid: `col * 50 + 120 + (row % 2 === 1 ? 25 : 0)`
5. `position_y` computed from grid: `row * 45 + 120`

### State Changes at Game Start

| Table | Column | Before | After |
|-------|--------|--------|-------|
| `games` | `status` | `'setup'` | `'initialBuild'` |
| `games` | `initial_build_round` | `0` | `1` |
| `games` | `initial_build_order` | `NULL` | `[playerId1, playerId2, ...]` |
| `games` | `current_player_index` | `0` | `0` |

### State Changes at Active Transition

| Table | Column | Before | After |
|-------|--------|--------|-------|
| `games` | `status` | `'initialBuild'` | `'active'` |
| `games` | `initial_build_round` | `2` | `0` |
| `games` | `initial_build_order` | `[...]` | `NULL` |
| `games` | `current_player_index` | last in round 2 | index of first active player |

### Bot Implementation Notes

- **Cold Start (INV-6):** On the bot's first build turn, it has no track. Dijkstra seeds from `networkNodes` (track endpoints). Empty network â†’ no sources â†’ no build options â†’ PassTurn forever. Fix: when `networkNodes` is empty and `snapshot.position` exists, seed Dijkstra from the bot's position (a major city).
- **Position Quad (INV-1):** `placeInitialTrain` must set all 4 position columns (`position_row`, `position_col`, `position_x`, `position_y`). The read path uses `position_x !== null` as the sentinel. Pixel coords computed from grid.
- **Bot User Row (INV-2):** Bot players need a synthetic `users` row (FK constraint on `players.user_id REFERENCES users(id)`). Created by `LobbyService.addBot()` with `password_hash='BOT_NO_LOGIN'`.
- **Random Archetype (INV-7):** `'random'` must be resolved to a concrete archetype before storing in `bot_config`. Client-side `getArchetypeColors('random')` returns `undefined` â†’ crash.

---

## Cross-Cutting Concerns

### Coordinate Systems â€” Where Grid vs Pixel Appears

| Action | Grid (row, col) Used For | Pixel (x, y) Used For |
|--------|--------------------------|----------------------|
| Build Track | Adjacency validation, pathfinding | Segment storage (`from.x`, `to.x`), rendering |
| Move Train | Server validation, DB position | Client rendering, DB position |
| Pick Up Load | City position matching (`isPlayerAtCity`) | Not used |
| Deliver Load | City position matching | Not used |
| Train Placement | Major city lookup | Sprite positioning, DB storage |

**Authority:** Grid coordinates are authoritative for game logic. Pixel coordinates are derived via deterministic formula and stored for rendering convenience.

### Socket Event Completeness â€” DB Writes Without Events

| DB Write | Socket Event | Coverage |
|----------|-------------|----------|
| `player_tracks` save | `track:updated` | âœ… Emitted by route handler |
| `players.position_*` move | `state:patch` | âœ… Emitted by route handler |
| `players.money` (fees) | `state:patch` | âœ… Included in move response |
| `players.loads` pickup | `state:patch` | âœ… |
| `players.hand/money` delivery | `state:patch` | âœ… |
| `players.train_type` upgrade | `state:patch` | âœ… |
| `games.current_player_index` | `turn:change` | âœ… |
| `player_tracks.turn_build_cost` reset | None | âš ï¸ Client resets locally via `endTurnCleanup` |
| `players.money` build cost deduction | None | âš ï¸ Client deducts locally, persists via separate API call |
| `bot_turn_audits` | `bot:turn-complete` (includes audit) | âœ… |

**Gaps flagged with âš ï¸:** These writes happen without socket events. The client handles them through local state management and polling-based reconciliation (`refreshPlayerData`). Bot implementations that bypass the standard flow must ensure these are covered.

### Route Handler vs Service Layer â€” Logic Location

| Game Logic | Location | Bot Access |
|------------|----------|------------|
| Track usage fee computation | `PlayerService.moveTrainForUser()` | âœ… Via service call |
| Turn ownership validation | `PlayerService.*` methods | âœ… Via service call |
| Demand card draw/discard | `DemandDeckService` (in-memory) | âœ… Via service singleton |
| Track save + socket emit | `trackRoutes.ts` route handler | âš ï¸ Bot must emit `track:updated` separately |
| Build cost deduction from money | `GameScene.nextPlayerTurn()` (CLIENT) | âŒ Bot must handle server-side |
| Turn build cost reset | `TrackDrawingManager.endTurnCleanup()` (CLIENT) | âŒ Bot must handle server-side |
| Movement point tracking | `TrainMovementManager` (CLIENT) | âŒ Bot manages via WorldSnapshot |
| Ferry state management | `GameScene.handleTurnChange()` (CLIENT) | âŒ Bot must track in AI pipeline |

**Items marked âŒ** are client-only logic that bots must replicate server-side. These are the highest-risk areas for bot implementation.

### Implicit Contracts

These are undocumented assumptions in the codebase where code uses one column/field as a proxy for another, or assumes multiple fields are always set together. Breaking these contracts causes silent failures.

**Contract 1: `position_x !== null` means "player has a position"**

Location: `playerService.ts:495`
```typescript
row.position_x !== null
  ? { x: row.position_x, y: row.position_y, row: row.position_row, col: row.position_col }
  : undefined
```

**Rule:** ALL 4 position columns (`position_x`, `position_y`, `position_row`, `position_col`) must be set or cleared together. `position_x` is the sentinel check.

**Known risk:** Setting only `position_row`/`position_col` â†’ `position_x` remained null â†’ player appeared to have no position â†’ downstream systems (Dijkstra seeding, movement) failed silently.

**Contract 2: All 4 segment coordinate fields required**

Each `TrackSegment.from` and `.to` must have `x`, `y`, `row`, `col`, and `terrain`. Client rendering reads pixel coords directly: `segment.from.x` â†’ Phaser `moveTo()`.

**Known risk:** Segments with `x: 0, y: 0` â†’ tracks rendered at top-left corner â†’ invisible to players.

**Contract 3: `placeInitialTrain` defaults can silently corrupt**

In `AIStrategyEngine.ts:422-427`:
```typescript
const posX = centerPoint?.x ?? 0;  // âš ï¸ Should be ?? null
const posY = centerPoint?.y ?? 0;  // âš ï¸ Should be ?? null
```
If `centerPoint` lookup fails, bot gets placed at pixel (0,0) instead of having no position. This silently corrupts state â€” the player appears to be positioned but at the wrong location.

**Contract 4: Players ordered by `created_at` for index resolution**

Turn index resolves to a player via:
```sql
SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC LIMIT 1 OFFSET $2
```
The `current_player_index` is an offset into this ordered set. Players MUST NOT be reordered or deleted without updating indices.

**Contract 5: `hand` stores card IDs, not card objects**

`players.hand` is an `INTEGER[]` of demand card IDs. Full card objects are retrieved via `demandDeckService.getCard(cardId)`. Client `getPlayers()` call enriches IDs to full objects. Bot code must work with IDs and use the same deck service.

**Contract 6: `paidOpponentIds` tracks per-turn fee payments**

Track usage fees are per-opponent, per-turn. The `paidOpponentIds` set (reconstructed from `turn_actions`) prevents double-charging. Bot must record moves in `turn_actions` to prevent being charged twice for the same opponent in a multi-move turn.

---

## Appendix A: Complete Socket Event Reference

| Event | Direction | Payload | Trigger |
|-------|-----------|---------|---------|
| `state:init` | Server â†’ Client | Full `GameState` | Client joins game |
| `state:patch` | Server â†’ Client | `{ patch: Partial<GameState>, serverSeq: number }` | Any state change |
| `turn:change` | Server â†’ Client | `{ currentPlayerIndex, currentPlayerId?, gameId, timestamp }` | Turn advancement |
| `track:updated` | Server â†’ Client | `{ gameId, playerId, timestamp }` | Track saved |
| `victory:triggered` | Server â†’ Client | Victory data | Player declares victory |
| `game:over` | Server â†’ Client | `{ winnerId, winnerName }` | Game completed |
| `victory:tie-extended` | Server â†’ Client | `{ newThreshold }` | Tie threshold raised |
| `bot:turn-start` | Server â†’ Client | Bot turn info | Bot begins turn |
| `bot:action` | Server â†’ Client | Bot action info | Bot takes action |
| `bot:turn-complete` | Server â†’ Client | Bot turn result | Bot finishes turn |
| `action` | Client â†’ Server | `{ type, payload, clientSeq }` | Client state action |
| `join` | Client â†’ Server | `{ gameId }` | Join game room |

## Appendix B: Database Schema Quick Reference

### `players` table
```
id VARCHAR(255) PK
game_id VARCHAR(255) FKâ†’games
user_id UUID FKâ†’users
name VARCHAR(255)
color VARCHAR(7)
money INTEGER DEFAULT 50
train_type VARCHAR(50) DEFAULT 'Freight'
position_x INTEGER          -- Pixel X (sentinel for "has position")
position_y INTEGER          -- Pixel Y
position_row INTEGER        -- Grid row (authoritative)
position_col INTEGER        -- Grid col (authoritative)
loads JSONB DEFAULT '[]'    -- Array of LoadType strings
hand INTEGER[]              -- Array of demand card IDs
is_bot BOOLEAN              -- ⚠️ PLANNED (mig 033)
bot_config JSONB            -- ⚠️ PLANNED (mig 033) {skillLevel, archetype, botId, botName}
debt_owed INTEGER           -- Mercy rule borrowing
current_turn_number INTEGER
is_online BOOLEAN
last_seen_at TIMESTAMPTZ
is_deleted BOOLEAN
camera_state JSONB
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

### `player_tracks` table
```
id SERIAL PK
game_id UUID FKâ†’games
player_id UUID FKâ†’players
segments JSONB DEFAULT '[]'  -- Array of TrackSegment
total_cost INTEGER DEFAULT 0
turn_build_cost INTEGER DEFAULT 0
last_build_timestamp TIMESTAMPTZ
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
UNIQUE(game_id, player_id)
```

### `games` table
```
id VARCHAR(255) PK
status VARCHAR(50)           -- setup|initialBuild|active|completed|abandoned
current_player_index INTEGER
server_seq INTEGER           -- Monotonic counter for state:patch ordering
initial_build_order JSONB    -- Player IDs in build order
initial_build_round INTEGER  -- 1 or 2
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

### `turn_actions` table
```
player_id UUID
game_id UUID
turn_number INTEGER
actions JSONB                -- Array of action objects
UNIQUE(player_id, game_id, turn_number)
```

### `movement_history` table
```
player_id UUID
game_id UUID
turn_number INTEGER
movement_path JSONB          -- Array of movement segments
UNIQUE(player_id, game_id, turn_number)
```

### `load_chips` table
```
id SERIAL PK
game_id UUID FKâ†’games
type VARCHAR                 -- LoadType name
city_name VARCHAR
is_dropped BOOLEAN DEFAULT false
```

## Appendix C: Key Constants

```typescript
INITIAL_PLAYER_MONEY = 50           // 50M ECU starting cash
VICTORY_INITIAL_THRESHOLD = 250     // 250M ECU to win
VICTORY_TIE_THRESHOLD = 300         // 300M ECU after tie
TRACK_USAGE_FEE = 4                 // 4M ECU per opponent per turn
MAX_BUILD_PER_TURN = 20             // 20M ECU build budget per turn
UPGRADE_COST = 20                   // 20M ECU for upgrade
CROSSGRADE_COST = 5                 // 5M ECU for crossgrade
CROSSGRADE_BUILD_LIMIT = 15         // 15M ECU max track spend with crossgrade

// Train Properties
TRAIN_PROPERTIES = {
  freight:       { speed: 9,  capacity: 2 },
  fast_freight:  { speed: 12, capacity: 2 },
  heavy_freight: { speed: 9,  capacity: 3 },
  superfreight:  { speed: 12, capacity: 3 },
}

// Terrain Costs (ECU M)
TERRAIN_COSTS = {
  Clear: 1, Mountain: 2, Alpine: 5,
  SmallCity: 3, MediumCity: 3, MajorCity: 5,
  FerryPort: route-specific (4-16),
}

// Water Crossing Additional Costs
WATER_CROSSING_COSTS = {
  River: 2, Lake: 3, OceanInlet: 3,
}
```