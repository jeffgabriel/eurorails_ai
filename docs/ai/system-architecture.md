# System Architecture Reference â€” EuroRails Online

> Companion document to the AI Bot PRD. Provides the implementation-level context an AI implementer needs to build correctly against the existing codebase.

---

## Table of Contents

1. [Database Schema](#1-database-schema)
2. [Socket Event Inventory](#2-socket-event-inventory)
3. [Shared Service API Contracts](#3-shared-service-api-contracts)
4. [Client State Flow](#4-client-state-flow)
5. [Human Turn Lifecycle Trace](#5-human-turn-lifecycle-trace)
6. [Coordinate Systems](#6-coordinate-systems)
7. [Defect-Informed Invariants](#7-defect-informed-invariants)

---

## 1. Database Schema

Base schema: `db/migrations/001_initial_schema.sql` through `029_grandfather_existing_users_email_verified.sql` (29 migrations total as of this writing). Migrations 030–033 described below are **required but not yet created** — they must be implemented as part of the AI bot work.

### 1.1 `users` table (migration 012)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| `id` | UUID | NO | `gen_random_uuid()` | PK |
| `username` | VARCHAR(50) | NO | â€” | UNIQUE |
| `email` | VARCHAR(255) | NO | â€” | UNIQUE |
| `password_hash` | VARCHAR(255) | NO | â€” | bcrypt |
| `email_verified` | BOOLEAN | YES | `false` | Grandfathered to `true` in mig 029 |
| `chat_enabled` | BOOLEAN | NO | `true` | mig 022 |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | |
| `last_active` | TIMESTAMPTZ | YES | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | YES | `NOW()` | auto-trigger |

**Indexes:** `idx_users_username`, `idx_users_email`, `idx_users_last_active`

> **Important:** Bots require a synthetic `users` row (password=`BOT_NO_LOGIN`, email=`bot-*@bot.internal`). The `players.user_id` FK constraint means a random UUID without a `users` row will 500.

### 1.2 `games` table (migrations 001, 011, 013, 017, 019; columns marked ⚠️ require planned mig 031)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| `id` | UUID | NO | `gen_random_uuid()` | PK |
| `status` | TEXT | YES | â€” | CHECK: `setup`, `initialBuild`, `active`, `completed` (+ `abandoned` via mig 013) |
| `current_player_index` | INTEGER | YES | `0` | Index into `ORDER BY created_at ASC` player list |
| `max_players` | INTEGER | YES | `6` | |
| `winner_id` | UUID | YES | â€” | FK â†’ `players(id)` ON DELETE SET NULL |
| `join_code` | VARCHAR(8) | YES | â€” | UNIQUE, for lobby join |
| `created_by` | UUID | YES | â€” | FK â†’ `users(id)` ON DELETE CASCADE |
| `is_public` | BOOLEAN | YES | `false` | |
| `victory_triggered` | BOOLEAN | YES | `false` | mig 017 |
| `victory_trigger_player_index` | INTEGER | YES | `-1` | mig 017 |
| `victory_threshold` | INTEGER | YES | `250` | 250M initially, 300M after tie |
| `final_turn_player_index` | INTEGER | YES | `-1` | mig 017 |
| `server_seq` | BIGINT | NO | `0` | Monotonic seq for socket state:init/state:patch ordering (mig 019) |
| `initial_build_round` | INTEGER | NO | `0` | **⚠️ PLANNED** mig 031: 0=not in initialBuild, 1=round 1, 2=round 2 |
| `initial_build_order` | JSONB | YES | â€” | **⚠️ PLANNED** mig 031: Plain `string[]` array of player IDs (build order). Round/index tracking done in application code via `initial_build_round` column. |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | YES | `NOW()` | auto-trigger |

**Indexes:** `idx_games_join_code`, `idx_games_created_by`, `idx_games_is_public`

> **Important:** During `initialBuild`, turn advancement MUST use `InitialBuildService.advanceTurn()` (reads `initial_build_round`/`initial_build_order`), NOT `PlayerService.updateCurrentPlayerIndex()`. **⚠️ `InitialBuildService` does not exist yet** — currently `LobbyService.startGame()` transitions directly from `setup` to `active`, skipping the `initialBuild` phase. Both the service and migration 031 must be created.

### 1.3 `players` table (migrations 001, 007, 008, 009, 011, 014, 021; columns marked ⚠️ require planned mig 033)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| `id` | UUID | NO | `gen_random_uuid()` | PK |
| `game_id` | UUID | YES | â€” | FK â†’ `games(id)` ON DELETE CASCADE |
| `user_id` | UUID | YES | â€” | FK â†’ `users(id)` ON DELETE CASCADE (mig 011+012) |
| `name` | TEXT | NO | â€” | |
| `color` | TEXT | YES | â€” | CHECK: `^#[0-9A-Fa-f]{6}$` |
| `money` | INTEGER | YES | `50` | ECU millions |
| `train_type` | TEXT | YES | `'Freight'` | |
| `position_x` | INTEGER | YES | â€” | **Pixel X coordinate** (mig 007) |
| `position_y` | INTEGER | YES | â€” | **Pixel Y coordinate** (mig 007) |
| `position_row` | INTEGER | YES | â€” | **Grid row** (mig 007) |
| `position_col` | INTEGER | YES | â€” | **Grid col** (mig 007) |
| `hand` | INTEGER[] | NO | `'{}'` | Array of exactly 3 demand card IDs. CHECK: `array_length(hand,1) IS NULL OR = 3` (mig 008) |
| `loads` | TEXT[] | NO | `'{}'` | Array of LoadType strings. CHECK: `array_length(loads,1) IS NULL OR <= 3` (mig 009) |
| `camera_state` | JSONB | YES | â€” | Per-player camera `{zoom, scrollX, scrollY}` (mig 014) |
| `current_turn_number` | INTEGER | YES | â€” | Incremented each turn end (mig 006) |
| `is_deleted` | BOOLEAN | NO | `false` | Soft delete for lobby listing (mig 015) |
| `last_seen_at` | TIMESTAMPTZ | NO | `NOW()` | Presence staleness (5-min timeout) (mig 015) |
| `debt_owed` | INTEGER | NO | `0` | Mercy borrowing debt, CHECK >= 0 (mig 021) |
| `is_online` | BOOLEAN | YES | `true` | (mig 011) |
| `is_bot` | BOOLEAN | NO | `false` | **⚠️ PLANNED** (mig 033) |
| `bot_config` | JSONB | YES | â€” | `{ skillLevel, archetype, botName }` **⚠️ PLANNED** (mig 033) |
| `created_at` | TIMESTAMPTZ | YES | `NOW()` | **Player ordering is `ORDER BY created_at ASC`** |
| `updated_at` | TIMESTAMPTZ | YES | `NOW()` | auto-trigger |

**Indexes:** `idx_players_user_id`, `idx_players_is_online`

#### Position Column Invariants

```
CRITICAL: All 4 position columns must be set together.
The read path in PlayerService.getPlayers (line ~495) uses:
  position_x !== null  â†’  as the sentinel for "player has a position"
If position_x is null but position_row/col are set, the player appears to have no position.
```

**Convention:** When writing position to DB, always SET all 4 columns:
```sql
UPDATE players
SET position_row = $1, position_col = $2, position_x = $3, position_y = $4
WHERE ...
```

### 1.4 `player_tracks` table (base schema)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| `id` | SERIAL | NO | auto | PK |
| `game_id` | UUID | YES | â€” | FK â†’ `games(id)` |
| `player_id` | UUID | YES | â€” | FK â†’ `players(id)` |
| `segments` | JSONB | NO | `'[]'` | Array of `TrackSegment` objects |
| `total_cost` | INTEGER | NO | `0` | Cumulative track spending |
| `turn_build_cost` | INTEGER | NO | `0` | Spending this turn (max 20M) |
| `last_build_timestamp` | TIMESTAMPTZ | YES | `NOW()` | |
| `created_at` / `updated_at` | TIMESTAMPTZ | â€” | `NOW()` | |

**Constraint:** `UNIQUE(game_id, player_id)` â€” upsert on save.

**Segments JSONB structure:**
```typescript
interface TrackSegment {
  from: { x: number; y: number; row: number; col: number; terrain: TerrainType };
  to:   { x: number; y: number; row: number; col: number; terrain: TerrainType };
  cost: number;
}
```

### 1.5 `turn_actions` table (migration 018)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| `id` | UUID | NO | `gen_random_uuid()` | PK |
| `player_id` | UUID | YES | â€” | FK â†’ `players(id)` |
| `game_id` | UUID | YES | â€” | FK â†’ `games(id)` |
| `turn_number` | INTEGER | NO | â€” | |
| `actions` | JSONB | NO | `'[]'` | Array of action records (moves, deliveries, fees) |

**Constraint:** `UNIQUE(player_id, game_id, turn_number)` â€” one record per player per game per turn (fixed in mig 020). Actions appended via `||` operator.

### 1.6 `bot_turn_audits` table — ⚠️ PLANNED (migrations 030, 032 not yet created)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| `id` | UUID | NO | `gen_random_uuid()` | PK |
| `game_id` | UUID | NO | â€” | FK â†’ `games(id)` |
| `player_id` | UUID | NO | â€” | No FK (player may be deleted) |
| `turn_number` | INTEGER | NO | â€” | |
| `archetype_name` | TEXT | NO | â€” | |
| `skill_level` | TEXT | NO | â€” | CHECK: `easy`, `medium`, `hard` |
| `current_plan` | TEXT | NO | `''` | |
| `archetype_rationale` | TEXT | NO | `''` | |
| `feasible_options` | JSONB | NO | `'[]'` | |
| `rejected_options` | JSONB | NO | `'[]'` | |
| `bot_status` | JSONB | NO | `'{}'` | |
| `duration_ms` | INTEGER | NO | `0` | |
| `snapshot_hash` | TEXT | NO | `''` | mig 032 |
| `selected_plan` | JSONB | NO | `'[]'` | mig 032 |
| `execution_result` | JSONB | NO | `'{}'` | mig 032 |
| `created_at` | TIMESTAMPTZ | NO | `NOW()` | |

**Indexes:** `idx_bot_turn_audits_game_player (game_id, player_id, turn_number DESC)`, `idx_bot_turn_audits_created_at`

### 1.7 `movement_history` table (migration 006)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| `id` | UUID | NO | `gen_random_uuid()` | PK |
| `player_id` | UUID | YES | â€” | FK â†’ `players(id)` |
| `game_id` | UUID | YES | â€” | FK â†’ `games(id)` |
| `movement_path` | JSONB | YES | â€” | Array of movement steps |
| `turn_number` | INTEGER | YES | â€” | |
| `created_at` / `updated_at` | TIMESTAMPTZ | â€” | `NOW()` | |

### 1.8 Other Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `load_chips` | Commodity state | `game_id`, `type` (TEXT), `city_name` (TEXT, nullable), `is_dropped` (BOOLEAN, default false). After mig 010: `location` and `player_id` columns dropped. |
| `event_cards` | Future event system | `game_id`, `type`, `effect` (JSONB), `status` â€” **Schema only, no logic implemented** |
| `demand_cards` | Card deck (legacy) | `city`, `payoff`, `goods` (JSONB), `status`. Superseded by in-memory `DemandDeckService` singleton |
| `game_logs` | Action logging | `game_id`, `player_id`, `action_type`, `action_data` (JSONB) |
| `chat_messages` | Game chat (mig 026) | `game_id`, `sender_user_id`, `recipient_type` ('player'/'game'), `recipient_id`, `message_text` (VARCHAR 500) |
| `chat_rate_limits` | Rate limiting (mig 027) | `user_id`, `game_id`, `message_count`, `window_start`. UNIQUE(user_id, game_id). 15 msgs/min limit |
| `game_message_counts` | Per-game limit (mig 028) | `game_id` (PK), `total_messages`. CHECK: 0-1000 |
| `user_blocks` | Block system (mig 024) | `blocker_user_id`, `blocked_user_id`. CHECK: no self-block |
| `schema_migrations` | Migration tracking | `version` (INTEGER PK) |

---

## 2. Socket Event Inventory

Transport: Socket.IO with WebSocket-only mode, JWT auth on connection.

### 2.1 Client â†’ Server Events

| Event | Payload | Emitter | Listener | Purpose |
|-------|---------|---------|----------|---------|
| `join` | `{ gameId }` | `socket.ts:172` | `socketService.ts:198` | Join game room; triggers `state:init` response + BotTurnTrigger reconnect check |
| `join-lobby` | `{ gameId }` | `socket.ts:247` | `socketService.ts:162` | Join lobby room |
| `leave-lobby` | `{ gameId }` | `socket.ts:256` | `socketService.ts:184` | Leave lobby room |
| `action` | `{ gameId, type, payload, clientSeq }` | `socket.ts:179` | `socketService.ts:259` | Game action; relayed as `state:patch` |
| `join-game-chat` | `{ gameId, userId }` | `socket.ts:320` | `socketService.ts:301` | Join chat room |
| `send-chat-message` | `{ tempId, gameId, recipientType, recipientId, messageText }` | `socket.ts:342` | `socketService.ts:363` | Send chat message |

### 2.2 Server â†’ Client Events

| Event | Payload | Emitter | Listener | Purpose |
|-------|---------|---------|----------|---------|
| `state:init` | `{ gameState: GameState, serverSeq }` | `socketService.ts:251` | `socket.ts:185` | Full game state on join |
| `state:patch` | `{ patch: Partial<GameState>, serverSeq }` | `socketService.ts:603` + routes | `socket.ts:196` | Incremental state delta |
| `turn:change` | `{ currentPlayerIndex, currentPlayerId?, gameId, timestamp }` | `socketService.ts:561` | `socket.ts:228` | Turn advancement. **Also triggers `BotTurnTrigger.onTurnChange()`** âš ï¸ Client TypeScript type expects `{ currentTurnUserId: ID; serverSeq: number }` â€” mismatch with server payload. |
| `track:updated` | `{ gameId, playerId, timestamp }` | `trackRoutes.ts:31` | `socket.ts:278` | Track changed (no segment data) |
| `lobby-updated` | `{ gameId, players, action, timestamp }` | `socketService.ts:550` | `socket.ts:264` | Lobby player list changed |
| `game-started` | `{ gameId, timestamp }` | lobbyService | `socket.ts:271` | Game transitioned to play |
| `victory:triggered` | `{ gameId, triggerPlayerIndex, triggerPlayerName, finalTurnPlayerIndex, victoryThreshold, timestamp }` | `socketService.ts:618` | `socket.ts:291` | Victory declared |
| `game:over` | `{ gameId, winnerId, winnerName, timestamp }` | `socketService.ts:642` | `socket.ts:302` | Game ended |
| `victory:tie-extended` | `{ gameId, newThreshold, timestamp }` | `socketService.ts:662` | `socket.ts:312` | Tie â†’ threshold raised to 300M |
| `bot:turn-start` | `{ botPlayerId, turnNumber }` | **⚠️ PLANNED** — will be emitted by `AIStrategyEngine` | **⚠️ PLANNED** — no listener yet | Bot beginning turn |
| `bot:turn-complete` | `{ botPlayerId, audit: StrategyAudit }` | **⚠️ PLANNED** — will be emitted by `AIStrategyEngine` | **⚠️ PLANNED** — no listener yet | Bot finished turn with audit |
| `bot:action` | `{ gameId, playerId, action, description, timestamp }` | **⚠️ PLANNED** — not yet emitted | **⚠️ PLANNED** — no listener yet | Per-action animation (future) |
| `error` | `{ code, message }` | `socketService.ts` (various) | `socket.ts:238` | Auth/state errors |

### 2.3 Rooms

| Room | Pattern | Events |
|------|---------|--------|
| Game | `{gameId}` | `state:patch`, `turn:change`, `track:updated`, `victory:*`, `game:over`, `bot:*` |
| Lobby | `lobby-{gameId}` | `lobby-updated`, `game-started` |
| Chat | `game:{gameId}:chat` | `new-chat-message` (broadcast) |
| DM | `game:{gameId}:dm:{sortedId1}:{sortedId2}` | `new-chat-message` (direct) |

### 2.4 Sequence Numbers

`state:init` and `state:patch` include `serverSeq` (monotonic integer). Client tracks `serverSeq` and detects gaps for resync. Stale patches (seq <= current) are dropped.

> **Important:** `emitTurnChange()` in `socketService.ts:553` must call `BotTurnTrigger.onTurnChange()` via dynamic import once implemented. **⚠️ This hook does not exist yet** — `emitTurnChange` currently only emits the socket event. Do NOT emit `turn:change` redundantly from route handlers â€” the callee already emits.

---

## 3. Shared Service API Contracts

### 3.1 PlayerService (`src/server/services/playerService.ts`)

Static class with methods accepting `(gameId, userId, ...)`. All mutations within `BEGIN`/`COMMIT`/`ROLLBACK` transactions with `FOR UPDATE` row locks.

#### `getPlayers(gameId: string, requestingUserId: string): Promise<Player[]>`
- **Reads:** `players` (ordered by `created_at ASC`), `player_tracks`
- **Position reconstruction (line ~495):**
  ```typescript
  if (row.position_x !== null) {
    position = { x: row.position_x, y: row.position_y, row: row.position_row, col: row.position_col };
  } else {
    position = null;  // â† if only row/col set, position is STILL null
  }
  ```
- **Hand filtering:** Other players' demand cards are hidden (returned as `[]`) unless `requestingUserId` matches

#### `moveTrainForUser(args: { gameId, userId, to: Point, movementCost? }): Promise<MoveResult>`
- **Writes:** `players.position_*` (all 4), `players.money` (fees), `turn_actions.actions`
- **Emits:** Nothing directly â€” route handler emits `state:patch`
- **Preconditions:** Game must be `active` (blocks during `initialBuild`). Must be player's turn.
- **Track usage fees:** Computes via `computeTrackUsageForMove()`, deducts 4M per opponent track used

#### `deliverLoadForUser(gameId, userId, city, loadType, cardId): Promise<Player>`
- **Writes:** `players.money`, `players.loads`, `players.hand`, `players.debt_owed`, `turn_actions`
- **In-memory:** `DemandDeckService.discardCard()` + `drawCard()`
- **Debt repayment:** `repayment = Math.min(payment, currentDebtOwed)`; `netPayment = payment - repayment`
- **Preconditions:** Game not `initialBuild`. Must be player's turn. Card must be in hand. Load must be on train.

#### `purchaseTrainType(gameId, userId, kind: 'upgrade'|'crossgrade', targetTrainType): Promise<Player>`
- **Writes:** `players.train_type`, `players.money`
- **Preconditions:**
  - `upgrade`: Cost 20M. `turnBuildCost === 0` required. Valid transitions: Freightâ†’Fast/Heavy, Fast/Heavyâ†’Super
  - `crossgrade`: Cost 5M. `turnBuildCost <= 15M` required. Only FastFreightâ†”HeavyFreight

> **Important:** UpgradeTrain during initialBuild hits `turnBuildCost !== 0` guard if track was built. OptionGenerator must check game phase.

#### Load Pickup — ⚠️ No `pickupLoadForUser` in PlayerService

> **Note:** Unlike other player actions, load pickup is NOT in PlayerService. The actual code path is:
> - **Route:** `POST /api/loads/pickup` → `loadRoutes.ts:53` (`handleLoadPickup`)
> - **Service:** `LoadService.pickupDroppedLoad(city, loadType, gameId)` — handles dropped loads only
> - **Client:** `LoadService.pickupLoad()` → `api.pickupLoad()` — handles both configured and dropped loads
> - Player's `loads` array is updated via the player update endpoint separately
>
> Bot implementation will need to orchestrate both the load service call and the player loads update, or a new unified `pickupLoadForUser` method should be created in PlayerService to match the pattern of other actions.

#### `discardHandForUser(gameId, userId): Promise<{ currentPlayerIndex, nextPlayerId, nextPlayerName }>`
- **Writes:** `players.hand`, `players.current_turn_number`, `games.current_player_index`
- **Emits:** `turn:change` + `state:patch` (via `emitTurnChange`)
- **Preconditions:** Game not `initialBuild`. No track building this turn. No server-tracked actions this turn.
- **Side effect:** Advances turn to next player

#### `updateCurrentPlayerIndex(gameId, nextIndex): Promise<void>`
- **Writes:** `games.current_player_index`
- **Emits:** `turn:change` (⚠️ must be hooked to trigger `BotTurnTrigger.onTurnChange()` once implemented)
- **Use:** Active-phase turn advancement only

#### `borrowForUser(gameId, userId, amount): Promise<Player>`
- **Writes:** `players.money` (+amount), `players.debt_owed` (+(amount*2))
- **Preconditions:** Amount 1-20. Must be player's turn.

### 3.2 TrackService (`src/server/services/trackService.ts`)

#### `saveTrackState(gameId, playerId, trackState: PlayerTrackState): Promise<void>`
- **Writes:** `player_tracks` (UPSERT via `ON CONFLICT (game_id, player_id)`)
- **No socket emission** â€” route handler emits `track:updated`

#### `getTrackState(gameId, playerId): Promise<PlayerTrackState | null>`
- **Reads:** `player_tracks`

#### `getAllTracks(gameId): Promise<PlayerTrackState[]>`
- **Reads:** All `player_tracks` rows for a game

### 3.3 LoadService (`src/server/services/loadService.ts`)

Singleton via `LoadService.getInstance()`.

#### `isLoadAvailableAtCity(city, loadType, gameId): Promise<boolean>`
- Checks static source cities + dropped loads

#### `pickupDroppedLoad(city, loadType, gameId): Promise<boolean>`
- Removes a dropped load from `load_chips`

#### `setLoadInCity(city, loadType, gameId): Promise<void>`
- Drops a load at a city. If a load already exists there, old load returns to tray.

### 3.4 InitialBuildService — ⚠️ PLANNED (does not exist yet)

> **This service must be created.** Currently, `LobbyService.startGame()` (line ~581) transitions directly from `setup` to `active`, skipping the `initialBuild` phase entirely. The initial build phase (2 rounds of track building before movement is allowed) is a core game rule that is not yet implemented in the server.

**Planned file:** `src/server/services/initialBuildService.ts`

#### `initPhase(client, gameId): Promise<void>` — to be created
- Sets `status = 'initialBuild'`, `initial_build_round = 1`, `initial_build_order = [playerIds]`
- Requires migration 031 for `initial_build_round` and `initial_build_order` columns

#### `advanceTurn(gameId): Promise<void>` — to be created
- **Reads:** `games.initial_build_round`, `games.initial_build_order`
- **Logic:**
  - Round 1 incomplete → advance `currentIndex` within round 1 order
  - Round 1 complete → set `round = 2`, reverse player order, reset `currentIndex = 0`
  - Round 2 complete → set `status = 'active'`, `initial_build_round = 0`
- **Emits:** `turn:change`

> **Important:** `BotTurnTrigger.advanceTurnAfterBot()` must check game status and call `InitialBuildService.advanceTurn()` during initialBuild, NOT `PlayerService.updateCurrentPlayerIndex()`.

### 3.5 Shared Services (environment-agnostic)

#### TrackBuildingService (`src/shared/services/TrackBuildingService.ts`)
```typescript
async addPlayerTrack(
  playerId: string, gameId: string,
  from: Milepost, to: Milepost,
  options?: TrackBuildOptions
): Promise<Result<TrackNetwork, TrackBuildError>>
```
- Uses neverthrow `Result<T, E>` pattern
- Validates: adjacency, terrain cost, turn budget (20M max), city connection limits (medium=3, small=2), first track must start from major city

#### TrackNetworkService (`src/shared/services/TrackNetworkService.ts`)
```typescript
createEmptyNetwork(): TrackNetwork
addTrackSegment(network, from: Milepost, to: Milepost): TrackNetwork
isConnected(network, from, to): boolean   // BFS with ferry edges
findPath(network, from, to): Milepost[] | null  // A* search
getReachableMileposts(network: TrackNetwork): Set<Milepost>
```

#### trackUsageFees (`src/shared/services/trackUsageFees.ts`)
```typescript
type Node = { row: number; col: number };

function buildUnionTrackGraph(args: {
  allTracks: PlayerTrackState[];
  majorCityGroups?: MajorCityGroup[];
  ferryEdges?: FerryEdge[];
}): { adjacency: Map<string, Set<string>>; edgeOwners: Map<string, Set<string>> }

function computeTrackUsageForMove(args: {
  allTracks: PlayerTrackState[];
  from: Node; to: Node;
  currentPlayerId: string;
  majorCityGroups?: MajorCityGroup[];
  ferryEdges?: FerryEdge[];
}): TrackUsageComputation
```
- Builds union graph from all players' segments + major city internal edges (ownerless) + ferry edges (ownerless)
- BFS pathfinding on union graph
- Returns `ownersUsed: Set<string>` (opponent player IDs whose track was traversed)

#### MovementValidator — ⚠️ PLANNED (does not exist yet)

**Planned file:** `src/shared/services/MovementValidator.ts`
```typescript
static validateMovePath(snapshot: WorldSnapshot, path: GridPoint[]): MovementValidationResult
```
- Server-side movement validation (to be extracted from client's `TrainMovementManager.canMoveTo()`)
- Will validate: hex adjacency, track connectivity, reversal rules, movement budget, ferry state
- Will use `isHexAdjacent()` for hex grid neighbor check

### 3.6 VictoryService (`src/server/services/victoryService.ts`)

```typescript
static async declareVictory(gameId, playerId, claimedCities): Promise<void>
static validateCitiesInTrack(trackSegments, claimedCities): boolean
```

> **Known gap:** `validateCitiesInTrack()` checks coordinate presence in segments but does NOT validate graph connectivity between cities. AI's `countConnectedMajorCities` must use proper BFS/DFS traversal.

### 3.7 DemandDeckService (`src/server/services/demandDeckService.ts`)

Singleton per game. In-memory deck management:
- `drawCard()` â€” draw from shuffled deck
- `discardCard(cardId)` â€” add to discard pile
- Reshuffles when draw pile exhausted

### 3.8 LobbyService (`src/server/services/lobbyService.ts`)

#### `addBot()` — ⚠️ PLANNED (does not exist yet)

```typescript
static async addBot(gameId, hostUserId, config: { skillLevel, archetype, name? }): Promise<Player>
```
- Will create synthetic `users` row for bot (required by FK constraint)
- Will resolve `'random'` archetype to concrete value (client rendering only maps concrete archetypes)
- Will auto-assign color from `getAvailableColors(gameId)`
- Requires migration 033 for `is_bot` and `bot_config` columns on `players` table
- Corresponding API routes (`POST /api/lobby/games/{id}/bots`, `DELETE /api/lobby/games/{id}/bots/{playerId}`) must also be created

---

## 4. Client State Flow

### 4.1 State Architecture

The client uses a **hybrid state model:**

| Layer | Technology | Purpose |
|-------|------------|---------|
| Lobby | Zustand stores (`game.store.ts`, `auth.store.ts`) | Game list, auth state |
| Game scene | Mutable `GameScene.gameState: GameState` | Single source of truth during gameplay |
| Services | `GameStateService`, `PlayerStateService` | Turn management, local player tracking |
| Components | Phaser managers (train, track, UI) | Rendering layer |

### 4.2 `handleTurnChange` (`GameScene.ts:1025`)

**Triggered by:** Socket `turn:change` event â†’ `GameStateService.updateCurrentPlayerIndex()` â†’ listeners â†’ `handleTurnChange()`

**Step-by-step:**
1. `refreshPlayerData()` â€” fetch updated player data from server
2. Compare `newActivePlayerId` vs `previousActivePlayerId` â€” show "It's your turn!" notification
3. `gameState.currentPlayerIndex = currentPlayerIndex`
4. `trackManager.resetTurnBuildLimit()` â€” reset crossgrade/upgrade rules
5. Handle ferry transitions â€” teleport train if at ferry, set `justCrossedFerry` flag
6. Reset movement points based on train type and ferry state:
   - Normal: `TRAIN_PROPERTIES[trainType].speed` (9 or 12)
   - Post-ferry: halved (5 or 6)
7. Update UI components: leaderboard, banners, demand card hand
8. If player has no position: prompt starting city selection

### 4.3 `refreshPlayerData` (`GameScene.ts:1280-1401`)

**API call:** `GET /api/players/{gameId}` with JWT auth

**State merge rules:**
- **Local player:** Preserve local `position`, `movementHistory`, `remainingMovement`, `ferryState` (client-managed). Take `money`, `turnNumber`, `hand` from server.
- **Other players:** Use server `trainState` as authoritative. Update train sprites.

### 4.4 Socket Patch Merging (`GameScene.ts:323-421`)

On `state:patch`:
1. Check `serverSeq` â€” drop if <= current (stale)
2. For each player in patch:
   - Local player: merge carefully (preserve client-managed state)
   - Other players: overwrite with server data
3. Update train sprite positions via `UIManager.updateTrainPosition()`

### 4.5 Train Position Rendering

**TrainSpriteManager** (`src/client/components/TrainSpriteManager.ts`):
- Reads `player.trainState.position` (type `Point | null`)
- Creates Phaser sprite at `(position.x + offsetX, position.y + offsetY)`
- Multiple trains at same location: stacked with `offset = index * 5`
- Texture: `{spritePrefix}_{colorName}` (e.g., `train_red`, `train_12_blue`)

### 4.6 Track Segment Rendering

**TrackDrawingManager** (`src/client/components/TrackDrawingManager.ts`):
- Loads segments via `GET /api/tracks/{gameId}/{playerId}`
- Draws lines between `(segment.from.x, segment.from.y)` and `(segment.to.x, segment.to.y)`
- Two Phaser Graphics layers: committed tracks (depth 1) + preview (depth 2)
- Refreshes on `track:updated` socket event

---

## 5. Human Turn Lifecycle Trace

### 5.1 Movement: Button Click â†’ UI Update

```
1. Player clicks milepost on map
   â””â”€ TrainMovementManager.canMoveTo(point)
      â”œâ”€ Validates: movement points, reversal rules, ferry state
      â””â”€ Returns { canMove, endMovement, distance }

2. Track usage fee check
   â””â”€ computeTrackUsageForMove({ allTracks, from, to, currentPlayerId })
      â””â”€ If opponent track used: show confirmation dialog (4M each)

3. Client â†’ Server
   â””â”€ POST /api/players/move-train
      Body: { gameId, to: { row, col, x, y }, movementCost }

4. Server Route (playerRoutes.ts:624)
   â””â”€ PlayerService.moveTrainForUser(args)
      â”œâ”€ BEGIN transaction (FOR UPDATE lock)
      â”œâ”€ Validate game status + turn ownership
      â”œâ”€ Compute track usage fees
      â”œâ”€ UPDATE players SET position_* (all 4), money
      â”œâ”€ UPDATE turn_actions (append action)
      â””â”€ COMMIT

5. Server â†’ Client
   â””â”€ emitStatePatch(gameId, { players: [affected...] })
      Event: state:patch { patch, serverSeq }

6. Client handler
   â””â”€ Merge patch into gameState.players
      â””â”€ UIManager.updateTrainPosition(playerId, x, y, row, col)
         â””â”€ TrainSpriteManager.createOrUpdateSprite()
```

### 5.2 Track Building

```
1. Player draws track on map (TrackDrawingManager)
   â””â”€ Validates terrain rules, costs, budget

2. Client â†’ Server
   â””â”€ POST /api/tracks/save
      Body: { gameId, playerId, trackState: { segments, totalCost, turnBuildCost } }

3. Server (trackRoutes.ts â†’ TrackService.saveTrackState)
   â””â”€ UPSERT player_tracks

4. Server â†’ Client
   â””â”€ io.to(gameId).emit('track:updated', { gameId, playerId, timestamp })

5. All clients
   â””â”€ Re-fetch track data â†’ redraw
```

### 5.3 Load Delivery

```
1. Player clicks "Deliver Load" button
   â””â”€ Selects load + matching demand card

2. Client â†’ Server
   â””â”€ POST /api/players/deliver-load
      Body: { gameId, city, loadType, cardId }

3. Server (playerRoutes.ts â†’ PlayerService.deliverLoadForUser)
   â”œâ”€ BEGIN transaction
   â”œâ”€ Validate card in hand + load on train
   â”œâ”€ Calculate payment (with debt repayment: repay = min(payment, debt))
   â”œâ”€ UPDATE players SET money, loads, hand, debt_owed
   â”œâ”€ DemandDeckService: discardCard + drawCard (replacement)
   â””â”€ COMMIT

4. Server â†’ Client: emitStatePatch({ players: [updated] })
```

### 5.4 Turn End / Pass Turn

```
1. Player clicks "Discard Hand" or end-turn action
   â””â”€ POST /api/players/discard-hand

2. Server (PlayerService.discardHandForUser)
   â”œâ”€ Validates: not initialBuild, no track building, no server-tracked actions
   â”œâ”€ Discard old hand â†’ draw 3 new cards
   â”œâ”€ UPDATE players SET hand, current_turn_number
   â”œâ”€ UPDATE games SET current_player_index = nextIndex
   â""â"€ emitTurnChange(gameId, nextIndex, nextPlayerId)
       â""â"€ âš ï¸ PLANNED: BotTurnTrigger.onTurnChange(gameId, nextIndex, nextPlayerId)
          â"œâ"€ Check: is next player a bot?
          â"œâ"€ Check: is at least one human connected?
          â""â"€ If bot: setTimeout â†' AIStrategyEngine.takeTurn()
```

### 5.5 Initial Build Phase â€" â š ï¸ NOT YET IMPLEMENTED

> **Current state:** `LobbyService.startGame()` transitions directly from `setup` to `active`, skipping `initialBuild`. The initial build phase described below is the planned behavior once `InitialBuildService` and migration 031 are created.

During `game.status === 'initialBuild'` (planned):
- Only track building + pass turn allowed (server blocks movement, delivery, pickup)
- Turn advancement uses `InitialBuildService.advanceTurn()`:
  - Round 1: clockwise order
  - Round 2: reverse order (last player goes first)
  - After round 2: transition to `status = 'active'`

### 5.6 Bot Turn Integration â€" â š ï¸ NOT YET IMPLEMENTED

> **Current state:** `emitTurnChange()` at `socketService.ts:553` only emits the socket event. It does not import or call `BotTurnTrigger`. All modules below must be created.

When `emitTurnChange()` fires (planned behavior):
1. `socketService.ts` dynamic-imports `BotTurnTrigger`
2. `BotTurnTrigger.onTurnChange()`:
   - Guard: `pendingBotTurns.has(gameId)` prevents double execution
   - Look up player at index â€" if not bot, exit
   - Check `hasConnectedHuman(gameId)` â€" if none, queue turn
   - `setTimeout(1500ms)` â†' `AIStrategyEngine.takeTurn()`
3. After bot completes, call `advanceTurnAfterBot()`:
   - If `initialBuild` â†' `InitialBuildService.advanceTurn()`
   - If `active` â†' `PlayerService.updateCurrentPlayerIndex()`

---

## 6. Coordinate Systems

### 6.1 Grid Coordinates (row, col)

**System:** Offset hex grid (even-q variant)
- **Rows:** 0â€“57 (58 rows)
- **Cols:** 0â€“63 (64 columns)
- **Odd-row offset:** Odd rows shift RIGHT by half a column

**Hex adjacency formula** (from `TrackDrawingManager.isAdjacent()` and `MovementValidator.isHexAdjacent()`):
```typescript
function isHexAdjacent(a: {row, col}, b: {row, col}): boolean {
  const rowDiff = a.row - b.row;
  const colDiff = a.col - b.col;

  // Same row: neighbors are Â±1 col
  if (rowDiff === 0) return Math.abs(colDiff) === 1;

  // Adjacent rows only (Â±1)
  if (Math.abs(rowDiff) !== 1) return false;

  // Moving down (rowDiff === 1): check FROM row parity
  if (rowDiff === 1) {
    const isFromOddRow = a.row % 2 === 1;
    return isFromOddRow
      ? (colDiff === 0 || colDiff === 1)   // Odd row: same col or col+1
      : (colDiff === 0 || colDiff === -1);  // Even row: same col or col-1
  }

  // Moving up (rowDiff === -1): check TO row parity
  if (rowDiff === -1) {
    const isToOddRow = b.row % 2 === 1;
    return isToOddRow
      ? (colDiff === 0 || colDiff === -1)
      : (colDiff === 0 || colDiff === 1);
  }
  return false;
}
```

### 6.2 Pixel Coordinates (x, y)

**System:** Phaser world coordinates (map image pixels)

**Constants** (`src/client/config/mapConfig.ts`):
```typescript
HORIZONTAL_SPACING = 50   // pixels between columns
VERTICAL_SPACING = 45     // pixels between rows
GRID_MARGIN = 120          // pixel offset from top-left
```

**Grid â†’ Pixel formula:**
```typescript
function calculateWorldCoordinates(col: number, row: number): { x: number, y: number } {
  const isOffsetRow = row % 2 === 1;  // Odd rows shift right
  const x = col * 50 + 120 + (isOffsetRow ? 25 : 0);
  const y = row * 45 + 120;
  return { x, y };
}
```

**World size:** ~3320 x 2710 pixels

### 6.3 gridPoints Data

**Source:** `/configuration/gridPoints.json` â€” flat array of milepost definitions:
```json
{
  "Id": "uuid",
  "Type": "Milepost" | "Mountain" | "Alpine" | "SmallCity" | "MediumCity" | "MajorCity" | "FerryPort" | "Water",
  "Name": "Berlin" | null,
  "GridX": 15,     // â† This is the COLUMN (col)
  "GridY": 30,     // â† This is the ROW (row)
  "Ocean": "Atlantic Ocean" | null
}
```

> **Convention:** In the JSON file, `GridX` = column, `GridY` = row. The client maps these to `gridPoints[row][col]`.

**GridPoint TypeScript type** (`GameTypes.ts:178-202`):
```typescript
interface GridPoint extends Point {
  id: string;
  terrain: TerrainType;
  ferryConnection?: FerryConnection;
  city?: CityData;          // { name, type, availableLoads }
  ocean?: string;
  name?: string;            // Ferry port name
  isFerryCity?: boolean;    // Dublin/Belfast hybrid
}

interface Point {
  x: number;   // pixel
  y: number;   // pixel
  row: number; // grid
  col: number; // grid
}
```

### 6.4 Authority Model

| Context | Authoritative System | Stored In |
|---------|---------------------|-----------|
| DB position storage | Grid (row, col) + Pixel (x, y) | `players.position_*` (all 4 columns) |
| DB position null-check | `position_x` | If `position_x IS NULL` â†’ player has no position |
| Pathfinding (AI) | Grid (row, col) | `trackUsageFees.ts` uses `Node = { row, col }` |
| Track segments | Both | `TrackSegment.from/to` has both `{x, y, row, col}` |
| Client rendering | Pixel (x, y) | Phaser sprites use world coordinates |
| Adjacency checks | Grid (row, col) | `isHexAdjacent()` operates on row/col |

### 6.5 TrackSegment Format

```typescript
{
  from: { x: 870, y: 570, row: 10, col: 15, terrain: TerrainType.Clear },
  to:   { x: 920, y: 570, row: 10, col: 16, terrain: TerrainType.Mountain },
  cost: 2
}
```

Both coordinate systems are stored in every segment endpoint. The `cost` is the terrain cost for building TO the `to` endpoint.

### 6.6 Major City Groups

Major cities occupy multiple grid points (center + outposts). Internal movement between points in the same major city is free (0 cost). Defined in `src/shared/services/majorCityGroups.ts`:

```typescript
interface MajorCityGroup {
  cityName: string;
  center: { row: number; col: number };
  outposts: Array<{ row: number; col: number }>;
}
```

The union track graph adds ownerless edges between center and outposts for each major city.

---

## 7. Implementation Invariants

These invariants capture critical architectural rules. Any AI implementer MUST respect these to build correctly against the existing codebase.

### INV-1: Position columns are a quad
**Rule:** When writing to `players.position_*`, always set ALL FOUR columns: `position_row`, `position_col`, `position_x`, `position_y`.
**Why:** `PlayerService.getPlayers()` uses `position_x !== null` as the sentinel. Setting only row/col leaves `position_x` null â†’ player appears unplaced.
**Code path:** `placeInitialTrain`, `moveTrainForUser`, any position update.

### INV-2: Bot users need a `users` row
**Rule:** Bot `user_id` must be a valid UUID that exists in the `users` table.
**Why:** `players.user_id` has `FOREIGN KEY REFERENCES users(id)`. A `bot-{uuid}` prefix is invalid UUID format. A random UUID without a `users` row violates the FK.
**Fix pattern:** Create synthetic `users` row with `password_hash='BOT_NO_LOGIN'`, `email='bot-{uuid}@bot.internal'`.

### INV-3: Turn advancement is phase-aware
**Rule:** Code that advances turns MUST check `game.status`:
- `initialBuild` â†’ `InitialBuildService.advanceTurn(gameId)`
- `active` â†’ `PlayerService.updateCurrentPlayerIndex(gameId, nextIndex)`
**Why:** InitialBuild has clockwise/counter-clockwise round logic and phase transitions. Using the wrong advancement mechanism breaks round progression.

### INV-4: No duplicate `turn:change` emissions
**Rule:** Never emit `turn:change` if the callee already emits it.
**Why:** Both emissions invoke `BotTurnTrigger.onTurnChange()`, and due to microtask timing both can pass the `pendingBotTurns` guard, causing double execution.
**Audit:** Before adding a new `emitTurnChange()` call, trace the full call chain.

### INV-5: OptionGenerator respects game phase
**Rule:** During `initialBuild`, only generate `BuildTrack`, `BuildTowardMajorCity`, and `PassTurn` options.
**Why:** Attempting UpgradeTrain during initialBuild hits `turnBuildCost !== 0` guard. Movement/delivery are blocked server-side.

### INV-6: Pathfinding needs a cold-start seed
**Rule:** When bot has no existing track (`trackSegments` empty), seed Dijkstra from `snapshot.position` (a major city).
**Why:** Dijkstra seeds from `networkNodes` (track endpoints). Empty network â†’ no sources â†’ no build options â†’ PassTurn forever.

### INV-7: Resolve meta-options before storage
**Rule:** `'random'` archetype must be resolved to a concrete `ArchetypeId` before writing to `bot_config`.
**Why:** Client rendering (`getArchetypeColors()`) only maps 5 concrete archetypes. `'random'` returns `undefined` â†’ crash.

### INV-8: New columns need migrations
**Rule:** Any new column referenced in an INSERT/UPDATE must have a corresponding migration in `db/migrations/`.
**Why:** TypeScript compiles but queries fail at runtime without the column in the actual DB.

### INV-9: Audit all `WHERE user_id = $X` before changing semantics
**Rule:** The codebase has 30+ queries using `WHERE user_id = $X`. Setting `user_id = NULL` for bots would break all of them (SQL `NULL != NULL`).
**Why:** `WHERE col = $X` never matches NULL in SQL.