# Ferry-City Feature Documentation

## Overview

Dublin and Belfast are unique locations in Eurorails that function as both **ferry ports** AND **cities**. This document describes the implementation that handles these hybrid locations.

## Problem Statement (GitHub Issue #199)

When a train crosses a ferry to Dublin or Belfast:
1. Train appeared to teleport and disconnect from the track network
2. City load/unload dialog didn't appear
3. Train couldn't move back over the ferry
4. General issues with ferry return trips

## Implementation

### Key Concepts

#### Ferry-City Detection (`isFerryCity` flag)
Grid points that are both ferry ports and cities are marked with `isFerryCity: true` in `mapConfig.ts`. This flag is set dynamically when a ferry port has associated city data.

```typescript
// In mapConfig.ts
if (point.city) {
  point.isFerryCity = true;
}
```

#### Ferry Connection Data
Each ferry has a `FerryConnection` object with:
- `Name`: Ferry route name (e.g., "Belfast_Stranraer")
- `connections`: Array of two `FerryPoint` objects (the endpoints)
- `cost`: Build cost for the ferry route

### Ferry Crossing Flow

#### Standard Ferry Crossing (A → B)
1. Player moves TO ferry port A
2. `ferryState` is set with `status: 'just_arrived'`, `otherSide: B`
3. Turn ends, movement set to 0
4. Next turn: `handleFerryTurnTransition()` runs
   - Train teleports to ferry port B
   - `justCrossedFerry` flag set to `true`
   - Movement history cleared
   - `ferryState` cleared
5. Player moves at **half speed** this turn

#### Ferry Return Trip (B → A)
When a player at ferry port B clicks ferry port A to return:
1. `isMovingBackAcrossFerry()` detects this is a return trip
2. `ferryState` is **NOT** set (prevents teleportation loop)
3. `justCrossedFerry` is set to `true` (ensures half-speed next turn)
4. Movement history is cleared
5. Turn ends
6. Next turn: Player moves at **half speed**, stays at ferry port A

### Key Files

| File | Purpose |
|------|---------|
| `src/client/config/mapConfig.ts` | Ferry connection setup, `isFerryCity` flag |
| `src/client/components/TrainMovementManager.ts` | Movement validation, ferry return trip detection |
| `src/client/scenes/GameScene.ts` | Ferry state transitions, teleportation logic |
| `src/shared/services/trackUsageFees.ts` | Ferry edges in union track graph |
| `src/shared/services/majorCityGroups.ts` | `FerryEdge` type, `getFerryEdges()` |
| `src/shared/services/TrackNetworkService.ts` | Path finding with ferry edges |

### Key Methods

#### `isMovingBackAcrossFerry(from, to)` - TrainMovementManager.ts
Detects if the player is crossing back across a ferry (return trip).

```typescript
private isMovingBackAcrossFerry(from: Point, to: GridPoint): boolean {
  const fromGridPoint = this.getGridPointAtPosition(from.row, from.col);
  if (!fromGridPoint?.ferryConnection) return false;

  const [pointA, pointB] = fromGridPoint.ferryConnection.connections;
  // Check if destination is the other end of this ferry
  // and current position is one of the ferry endpoints
}
```

#### `handleFerryTurnTransition(player)` - GameScene.ts
Handles ferry state machine at turn start:
- `just_arrived` → Teleport to other side, set half-speed
- `ready_to_cross` → Clear ferry state (player didn't use ferry)

#### `getFerryEdges()` - majorCityGroups.ts
Returns all ferry connections as edges for path finding:

```typescript
export function getFerryEdges(): FerryEdge[] {
  // Returns array of { name, pointA, pointB } for each ferry
}
```

### Server-Side Path Validation

Ferry edges are added to the union track graph in `buildUnionTrackGraph()`:

```typescript
// Ferry edges are public/ownerless - no track usage fees
const ferries = args.ferryEdges ?? getFerryEdges();
for (const ferry of ferries) {
  addUndirectedEdge(adjacency, pointAKey, pointBKey);
  // Not added to edgeOwners - ferries are free to use
}
```

## Testing

Integration tests are in `src/client/__tests__/TrainMovementManager.test.ts`:

- `TrainMovementManager Ferry-City Integration` test suite
- Ferry return trip detection tests
- `justCrossedFerry` bypass tests
- Teleport loop prevention tests
- Half-speed after ferry crossing tests

Run tests:
```bash
npm test -- --testPathPatterns="TrainMovementManager.test.ts"
```

## Game Rules Reference

From the Eurorails rulebook:

> **Using Ferries**
> To use a ferry, the player must:
> 1. Move to the ferry port and stop movement for that turn
> 2. On the next turn, start counting from the opposite ferry port and move at half rate
> 3. If not using the ferry, a ferry port milepost is treated as a clear milepost

> **Ferry Ports**
> - Only 2 players may build to (and from) a single ferry line
> - Dublin costs ECU 8 million to build to, and Belfast costs ECU 4 million (plus ferry costs)
