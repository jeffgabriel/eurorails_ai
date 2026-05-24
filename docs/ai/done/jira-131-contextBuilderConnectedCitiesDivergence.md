# JIRA-131: ContextBuilder Reports Disconnected Cities as "Connected" — Victory Check Disagrees

_Game `361153a6`: Flash hits 265M cash + 7 "connected" cities at Turn 118, LLM knows it won, but game never ends. Root cause: two different implementations of "connected major cities" that disagree._

## Summary

`ContextBuilder.computeConnectedMajorCities()` and `connectedMajorCities.ts getConnectedMajorCities()` compute the same concept using different algorithms. ContextBuilder overcounts — it reports any city with track touching it as "connected," even if that track is a disconnected island. The victory check correctly requires all cities in a single continuous network via BFS. When they disagree, the LLM believes it has won and stops building toward victory, while the game refuses to end.

## The Evidence

### Game `361153a6` — Flash: 7 "connected" cities, victory never fires

Flash built toward London across T115 and T117 (6 segments, 13M total). At T118, ContextBuilder reports 7 connected cities including London. The LLM's reasoning at T118:

> "I have already achieved the victory conditions of 250M ECU and 7 major cities connected. I am finishing the Beer delivery to Beograd because both cities are already on my track network"

Flash then spends turns 118-121 delivering Beer to Beograd instead of fixing the track gap, because it thinks it's already won. `checkBotVictory()` never fires — `getConnectedMajorCities()` returns < 7 because London is in a separate connected component.

| Turn | Cash | Cities (ContextBuilder) | Cities (Victory Check) | Action |
|------|------|------------------------|----------------------|--------|
| 117 | 265 | 6 (no London yet) | — | BuildTrack (2 segments toward London) |
| 118 | 265 | **7** (London appears) | **< 7** (London disconnected) | MoveTrain — LLM thinks it won |
| 119 | 265 | 7 | < 7 | MoveTrain — still thinks it won |
| 120 | 265 | 7 | < 7 | MoveTrain — delivering Beer |
| 121 | 265 | 7 | < 7 | MoveTrain — game log ends, no victory |

### Game `eb69a74e` — Haiku: London connects correctly, victory works

Haiku built toward London at T121-122 via a ferry route. The victory check accepted Haiku's London connection — proving the BFS + ferry edge logic in `getConnectedMajorCities()` is correct. Haiku's track formed a continuous path through the ferry; Flash's did not.

This confirms the issue is not in the victory check — it's in ContextBuilder giving false information.

## Root Cause: Two Implementations, Different Algorithms

### ContextBuilder.computeConnectedMajorCities() (lines 1967-1989)

```typescript
private static computeConnectedMajorCities(
  segments: TrackSegment[], gridPoints: GridPoint[]
): string[] {
  const network = buildTrackNetwork(segments);
  const majorCityPoints = gridPoints.filter(
    gp => gp.terrain === TerrainType.MajorCity && gp.city,
  );
  const connectedCities: string[] = [];
  for (const mc of majorCityPoints) {
    const key = `${mc.row},${mc.col}`;
    if (network.nodes.has(key)) {    // ← just checks node existence
      connectedCities.push(mc.city!.name);
    }
  }
  return Array.from(new Set(connectedCities));
}
```

**Problems:**
- No BFS / no connected component analysis — any city milepost in the graph counts
- No implicit intra-city edges (major city outposts aren't linked)
- No implicit ferry edges
- A disconnected 2-segment stub touching a major city milepost registers as "connected"

### connectedMajorCities.ts getConnectedMajorCities() (lines 78-133)

```typescript
export function getConnectedMajorCities(segments: TrackSegment[]): MajorCityCoordinate[] {
  const graph = buildTrackGraph(segments);  // adds intra-city + ferry edges
  // BFS to find connected components
  // Return cities from largest component only
}
```

**Correct behavior:**
- Adds implicit edges within major cities (all outposts connected)
- Adds implicit ferry edges (both endpoints present = connected)
- BFS finds all connected components
- Only counts cities in the single largest component

### Where Each Is Used

| Function | Used By | Effect |
|----------|---------|--------|
| `ContextBuilder.computeConnectedMajorCities()` | AI context (LLM prompt), NDJSON game log, debug panel | LLM sees inflated city count, makes wrong decisions |
| `getConnectedMajorCities()` | `checkBotVictory()`, victory declaration | Correct count, but LLM never knows the truth |

## Fix

Replace `ContextBuilder.computeConnectedMajorCities()` with a call to `getConnectedMajorCities()` from `connectedMajorCities.ts`, extracting city names:

```typescript
import { getConnectedMajorCities } from './connectedMajorCities';

// Replace the existing method body:
private static computeConnectedMajorCities(
  segments: TrackSegment[],
  _gridPoints: GridPoint[],
): string[] {
  return getConnectedMajorCities(segments).map(c => c.name);
}
```

This ensures:
1. **One source of truth** — AI context and victory check use the same algorithm
2. **LLM gets accurate information** — if London is disconnected, the prompt says 6 cities, not 7
3. **Bot will build the missing link** — instead of thinking it's won and wandering off to deliver Beer
4. **NDJSON log and debug panel are accurate** — post-game analysis won't show phantom connections

### What Doesn't Change

- Victory check logic (`checkBotVictory`, `VictoryService.declareVictory`) — already correct
- Ferry edge detection — proven correct by Haiku's `eb69a74e` game
- Track building logic
- JIRA-125 victory build priority — will now receive accurate city counts, making it more effective

## Bug 2: Bot Final Turn Resolution Never Fires

Discovered while testing Bug 1's fix on the live `361153a6` game. After restarting the server, Flash correctly declared victory (the ContextBuilder fix worked — Flash could now see London was connected). The "final round" banner appeared. But the game still wouldn't end.

### Root Cause

In `BotTurnTrigger.onTurnChange()` (line 256-260), the turn advance ran **before** the final turn check:

```typescript
// BEFORE (broken)
await advanceTurnAfterBot(gameId);        // advances current_player_index: 1 → 2
await checkAndResolveFinalTurn(gameId);   // isFinalTurn() checks: 2 === 1 → false (always)
```

`VictoryService.isFinalTurn()` checks `current_player_index === final_turn_player_index`. By the time it reads the DB, the index has already advanced past the final turn player. The check can never match for bot turns.

The client-side code (GameScene.ts:1064-1068) doesn't have this bug because it checks **before** advancing the turn.

### DB State at Time of Discovery

| Field | Value |
|-------|-------|
| `victory_triggered` | true |
| `victory_trigger_player_index` | 2 (Flash) |
| `final_turn_player_index` | 1 (Haiku) |
| `current_player_index` | 0 (human) |
| `winner_id` | null — game stuck |

### Fix

Moved `checkAndResolveFinalTurn()` before `advanceTurnAfterBot()` in `BotTurnTrigger.ts`:

```typescript
// AFTER (fixed)
await checkAndResolveFinalTurn(gameId);   // isFinalTurn() checks: 1 === 1 → true → resolveVictory()
await advanceTurnAfterBot(gameId);        // only runs if game didn't end
```

### Verified

Restarted server, played through human turn, Haiku took final turn, `resolveVictory()` fired, game ended with Flash as winner.

## Impact

Two bugs compounded in game `361153a6`:

1. **Bug 1 (ContextBuilder)** — Flash thought London was connected when it wasn't. The LLM stopped building and spent 4 turns delivering Beer. Cost: Flash couldn't declare victory.
2. **Bug 2 (BotTurnTrigger)** — Even after Bug 1 was fixed and Flash declared victory, the final turn resolution never fired because the turn advanced before the check. Cost: game stuck in "final round" limbo.

Both bugs are now fixed. In future games, the LLM will see accurate city connectivity (Bug 1) and bot victory resolution will fire correctly (Bug 2).
