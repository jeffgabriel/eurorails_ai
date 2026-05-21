# ActiveEffectManager API Reference

## Overview

`ActiveEffectManager` is a stateless service that manages persistent event card effects for the Eurorails game. It reads and writes the `games.active_event` JSONB array column to track effects that span multiple turns (e.g., Strike, Snow, Flood, Derailment). Every call reads from the database — there is no in-memory cache, guaranteeing correctness after server restarts.

**File:** `src/server/services/ActiveEffectManager.ts`

All write methods accept a `PoolClient` and require the caller to manage the transaction. Writes use `SELECT ... FOR UPDATE` to prevent concurrent modifications.

---

## Key Types

Defined in `src/shared/types/EventCard.ts`:

| Type | Description |
|------|-------------|
| `ActiveEffectRecord` | Persisted shape stored in `games.active_event` JSONB array |
| `ActiveEffect` | Runtime shape returned by `getActiveEffects`; `affectedZone` is a `Set<string>` |
| `MovementRestriction` | Restriction on train movement (`half_rate`, `blocked_terrain`, `no_movement_on_player_rail`) |
| `BuildRestriction` | Restriction on track building (`blocked_terrain`, `no_build_for_player`) |
| `PickupDeliveryRestriction` | Restriction on pickup/delivery in a zone (`no_pickup_delivery_in_zone`) |

`games.active_event` stores a `ActiveEffectRecord[]` JSON array (or `null` when no effects are active).

---

## Class Definition

```typescript
class ActiveEffectManager {
  async getActiveEffects(gameId: string): Promise<ActiveEffect[]>;

  async addActiveEffect(
    gameId: string,
    descriptor: ActiveEffectDescriptor,
    cardType: EventCardType,
    perPlayerEffects: PerPlayerEffect[],
    client: PoolClient,
    riverName?: string,
  ): Promise<void>;

  async cleanupExpiredEffects(
    gameId: string,
    completedPlayerIndex: number,
    completedTurnNumber: number,
    client: PoolClient,
  ): Promise<{ expiredCardIds: number[] }>;

  async getMovementRestrictions(gameId: string): Promise<MovementRestriction[]>;
  async getBuildRestrictions(gameId: string): Promise<BuildRestriction[]>;
  async getPickupDeliveryRestrictions(gameId: string): Promise<PickupDeliveryRestriction[]>;

  async consumeLostTurn(
    gameId: string,
    playerId: string,
    client: PoolClient,
  ): Promise<boolean>;
}

export const activeEffectManager = new ActiveEffectManager();
```

---

## Methods

### `getActiveEffects(gameId)`

Reads all currently active effects from the database.

**Parameters:**
- `gameId: string` — The game UUID.

**Returns:** `Promise<ActiveEffect[]>` — All active effects. Returns `[]` if `active_event` is null or empty.

**Behavior:**
- Reads `games.active_event` without locking (read-only).
- Deserializes each `ActiveEffectRecord` into `ActiveEffect`, converting `affectedZone: string[]` to `affectedZone: Set<string>` for O(1) membership checks.

**Example:**
```typescript
const effects = await activeEffectManager.getActiveEffects(gameId);
for (const effect of effects) {
  if (effect.affectedZone.has(playerMilepostKey)) {
    // player is in the affected zone
  }
}
```

---

### `addActiveEffect(gameId, descriptor, cardType, perPlayerEffects, client, riverName?)`

Persists a new active effect by appending it to the `games.active_event` array inside the caller's transaction.

**Parameters:**
- `gameId: string` — The game UUID.
- `descriptor: ActiveEffectDescriptor` — From `EventCardResult.persistentEffectDescriptor` (returned by `EventCardService.processEventCard`).
- `cardType: EventCardType` — From the drawn event card's `.type` field.
- `perPlayerEffects: PerPlayerEffect[]` — From `EventCardResult.perPlayerEffects`. Used to extract `pendingLostTurns` for Derailment cards.
- `client: PoolClient` — Caller-owned database client (must already be in a transaction).
- `riverName?: string` — **Flood only.** The river name from `effectConfig.river` (e.g., `"Rhine"`). Stored as `floodedRiver` for rebuild-blocking logic in SP-2.

**Returns:** `Promise<void>`

**Behavior:**
- Uses `SELECT active_event FROM games WHERE id = $1 FOR UPDATE` to lock the game row.
- Builds restriction arrays from `cardType` and `affectedZone`:
  - **Strike (coastal, zone non-empty):** `PickupDeliveryRestriction` with `no_pickup_delivery_in_zone`
  - **Strike (rail, zone empty):** `MovementRestriction` with `no_movement_on_player_rail` + `BuildRestriction` with `no_build_for_player`, both targeting `drawingPlayerId`
  - **Snow:** `MovementRestriction` with `half_rate` + `blocked_terrain`, and `BuildRestriction` with `blocked_terrain`
  - **Flood:** No restrictions (bridge removal handled in P2; rebuild blocking via `floodedRiver`)
  - **Derailment:** No movement/build restrictions; extracts `pendingLostTurns` from `perPlayerEffects`
- Appends the new `ActiveEffectRecord` to the existing array (or creates `[record]` if `active_event` is null).

**Example:**
```typescript
await activeEffectManager.addActiveEffect(
  gameId,
  result.persistentEffectDescriptor!,
  card.type,
  result.perPlayerEffects,
  client,
  card.type === EventCardType.Flood
    ? (card.effectConfig as FloodEffect).river
    : undefined,
);
```

---

### `cleanupExpiredEffects(gameId, completedPlayerIndex, completedTurnNumber, client)`

Removes all effects that have expired after the specified player's turn completion. Returns the card IDs of expired effects for socket broadcast.

**Parameters:**
- `gameId: string` — The game UUID.
- `completedPlayerIndex: number` — Zero-based index of the player who just completed their turn.
- `completedTurnNumber: number` — The turn number that just completed.
- `client: PoolClient` — Caller-owned database client (must be in a transaction).

**Returns:** `Promise<{ expiredCardIds: number[] }>` — Card IDs of effects that were removed. Empty array if none expired.

**Behavior:**
- Uses `SELECT ... FOR UPDATE` to lock the game row.
- An effect expires when **both** conditions are true:
  - `record.drawingPlayerIndex === completedPlayerIndex`
  - `record.expiresAfterTurnNumber <= completedTurnNumber`
- Writes the remaining (non-expired) effects back to `games.active_event`. Sets to `null` if all effects expired.
- Per rulebook: effects expire "at the end of the drawing player's next turn."

**Example:**
```typescript
const { expiredCardIds } = await activeEffectManager.cleanupExpiredEffects(
  gameId,
  currentPlayerIndex,
  currentTurnNumber,
  client,
);
// Broadcast expiredCardIds via socket
```

---

### `getMovementRestrictions(gameId)`

Aggregates movement restrictions across all active effects.

**Parameters:**
- `gameId: string` — The game UUID.

**Returns:** `Promise<MovementRestriction[]>` — Union of all active effects' movement restrictions. Empty array if no effects are active.

**Behavior:**
- Calls `getActiveEffects` internally (read-only, no locking).
- Concatenates `restrictions.movement` from all effects into a single array.
- Callers apply all restrictions to determine whether a move is valid.

---

### `getBuildRestrictions(gameId)`

Aggregates build restrictions across all active effects.

**Parameters:**
- `gameId: string` — The game UUID.

**Returns:** `Promise<BuildRestriction[]>` — Union of all active effects' build restrictions. Empty array if no effects are active.

---

### `getPickupDeliveryRestrictions(gameId)`

Aggregates pickup/delivery restrictions across all active effects.

**Parameters:**
- `gameId: string` — The game UUID.

**Returns:** `Promise<PickupDeliveryRestriction[]>` — Union of all active effects' pickup/delivery restrictions. Empty array if no effects are active.

---

### `consumeLostTurn(gameId, playerId, client)`

Removes a player's pending lost turn from the first matching active effect. A player loses **at most one turn** regardless of how many Derailment cards hit them simultaneously.

**Parameters:**
- `gameId: string` — The game UUID.
- `playerId: string` — The player whose lost turn is being consumed.
- `client: PoolClient` — Caller-owned database client (must be in a transaction).

**Returns:** `Promise<boolean>` — `true` if the player had a pending lost turn that was consumed, `false` otherwise.

**Behavior:**
- Uses `SELECT ... FOR UPDATE` to lock the game row.
- Scans all active effects' `pendingLostTurns` arrays for the player.
- Removes the player from the **first** matching effect only (prevents double-consumption).
- Writes the modified array back to `games.active_event`.

**Example:**
```typescript
const hadLostTurn = await activeEffectManager.consumeLostTurn(gameId, playerId, client);
if (hadLostTurn) {
  // Skip player's turn — their turn has been consumed
  return;
}
```

---

## Singleton Export

A singleton instance is exported for use across the server:

```typescript
import { activeEffectManager } from '../services/ActiveEffectManager';
```

---

## Dependency Notes

This service is the foundation for P3 sub-projects:

| Consumer | Usage |
|----------|-------|
| SP-2 (PlayerService) | Calls restriction query methods before validating moves/builds |
| SP-3 (Turn lifecycle) | Calls `cleanupExpiredEffects` at turn end; `consumeLostTurn` at turn start |
| SP-4 (SocketService) | Broadcasts `expiredCardIds` from `cleanupExpiredEffects` |
