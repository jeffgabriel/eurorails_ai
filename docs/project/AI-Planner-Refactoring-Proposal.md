# AI Planner Refactoring Proposal

## Executive Summary

The current AI planner architecture has fundamental design flaws that cause AI players to fail silently when their planned actions cannot be executed. This document analyzes the current architecture, identifies root causes of failures, and proposes a refactored architecture with proper fallback handling, geographic awareness, and resilient execution.

---

## Current Architecture Analysis

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        AIService                                 │
│  - Orchestrates AI turn execution                               │
│  - Calls AIPlanner.planTurn()                                   │
│  - Executes returned actions via execute*Action() methods       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        AIPlanner                                 │
│  - planTurn(): Entry point, generates and selects actions       │
│  - generateOptions(): Creates TurnOption[] for all action types │
│  - evaluateOptions(): Scores options by personality/difficulty  │
│  - selectActions(): Picks best actions to execute               │
└─────────────────────────────────────────────────────────────────┘
          │                   │                    │
          ▼                   ▼                    ▼
┌─────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ AIPathfinder │    │   AIEvaluator   │    │ AITrackBuilder  │
│ - Route calc │    │ - Score cards   │    │ - Build track   │
│ - Build opts │    │ - Eval position │    │ - A* pathfind   │
└─────────────┘    └─────────────────┘    └─────────────────┘
```

### Data Flow

1. **AIService.executeAITurn()** calls **AIPlanner.planTurn()**
2. **planTurn()** calls **generateOptions()** which delegates to:
   - `generateDeliveryOptions()` - uses AIEvaluator
   - `generatePickupOptions()` - uses AIEvaluator
   - `generateMovementOptions()` - direct calculation
   - `generateBuildOptions()` - uses AIPathfinder
   - `generateUpgradeOptions()` - direct calculation
3. Options are **evaluated and ranked** by evaluateOptions()
4. **selectActions()** picks best action per category
5. AIService **executes** each action via specific execute*Action() methods

### Key Files

| File | Purpose | Lines |
|------|---------|-------|
| `aiService.ts` | Turn orchestration, action execution | ~700 |
| `aiPlanner.ts` | Strategic decision-making | ~645 |
| `aiPathfinder.ts` | Route calculation, build evaluation | ~490 |
| `aiTrackBuilder.ts` | Server-side track pathfinding | ~565 |
| `aiEvaluator.ts` | Position and card scoring | ~515 |
| `types.ts` | Type definitions | ~150 |

---

## Identified Problems

### Problem 1: No Fallback Strategy

**Location:** `aiPlanner.ts:321-357` - `generateBuildOptions()`

**Issue:** The planner generates a single build target based on `AIPathfinder.evaluateTrackBuildOptions()`. If that target is unreachable (e.g., across water), execution fails silently.

```typescript
// Current behavior
const buildCandidates = pathfinder.evaluateTrackBuildOptions(player, gameState);
for (const candidate of buildCandidates.slice(0, 5)) {
  if (candidate.cost <= buildBudget) {
    options.push({ /* single target */ });
  }
}
```

**Impact:** AI does nothing when primary build target fails.

### Problem 2: Geographic Unawareness

**Location:** `aiPathfinder.ts:153-237` - `evaluateTrackBuildOptions()`

**Issue:** The pathfinder recommends build targets based purely on distance calculation without considering:
- Water bodies (English Channel, Mediterranean, etc.)
- Ferry port requirements for crossing water
- Continent/island isolation (England vs. Continental Europe)

```typescript
// Current: Simple distance calculation
const distToCity = Math.abs(endpoint.row - cityGroup.center.row) +
                   Math.abs(endpoint.col - cityGroup.center.col);
```

**Impact:** AI in London tries to build directly to Paris, ignoring the English Channel.

### Problem 3: Planner-Executor Disconnect

**Location:**
- `aiPlanner.ts` generates `TurnOption.details.targetRow/targetCol`
- `aiService.ts:488-555` tries to execute with `AITrackBuilder`

**Issue:** The planner uses `AIPathfinder` for recommendations, but execution uses `AITrackBuilder`. These two systems don't share state or validation logic.

```
Planner (AIPathfinder): "Build toward Paris (29,32)"
           ↓
Executor (AITrackBuilder): "No valid path to (29,32)" ← FAILURE
```

### Problem 4: Missing Validation at Planning Stage

**Location:** `aiPlanner.ts:321-357`

**Issue:** Options are generated without validating that they're actually achievable. The validation only happens at execution time, when it's too late to pick an alternative.

### Problem 5: Grid Data Inconsistency

**Location:** `aiTrackBuilder.ts:76-78`

**Issue:** Coastal points with `Ocean` field were being excluded, causing entire coastlines to be missing from the pathfinder's grid.

```typescript
// Bug: Excluded all coastal cities and ferry ports
if (terrain === TerrainType.Water || point.Ocean) {
  continue;
}
```

---

## Proposed Architecture

### Design Principles

1. **Validate at planning time** - Don't generate options that can't be executed
2. **Always have fallbacks** - Every strategy should have backup options
3. **Unified geography model** - Single source of truth for reachability
4. **Fail gracefully** - If all options fail, do something reasonable (build any track)
5. **Geographic awareness** - Understand landmasses, water bodies, ferry requirements

### New Component: GeographyService

Create a shared service that understands the game map topology:

```typescript
// src/shared/services/geographyService.ts

export class GeographyService {
  private landmasses: Map<string, Set<string>>; // landmass ID -> set of milepost keys
  private ferryConnections: Map<string, string>; // ferry port key -> connected landmass

  /**
   * Determine which landmass a coordinate belongs to
   */
  getLandmass(row: number, col: number): string;

  /**
   * Check if two points are on the same landmass (reachable without ferry)
   */
  areSameLandmass(point1: GridCoord, point2: GridCoord): boolean;

  /**
   * Get ferry ports that connect two landmasses
   */
  getFerryRoute(fromLandmass: string, toLandmass: string): FerryRoute[];

  /**
   * Get all major cities on a specific landmass
   */
  getMajorCitiesOnLandmass(landmass: string): MajorCityGroup[];

  /**
   * Get reachable destinations from a starting point
   * (considers current track network and ferry access)
   */
  getReachableDestinations(
    startPoint: GridCoord,
    playerTrack: TrackSegment[]
  ): GridCoord[];
}
```

### Refactored AIPlanner

```typescript
// src/server/services/ai/aiPlanner.ts (refactored)

export class AIPlanner {
  private geographyService = getGeographyService();

  /**
   * Plan turn with fallback strategies
   */
  planTurn(gameState: AIGameState, player: Player, config: AIConfig): AITurnPlan {
    // Phase 1: Generate validated options only
    const options = this.generateValidatedOptions(gameState, player, config);

    // Phase 2: Rank by strategy
    const ranked = this.rankOptions(options, player, config);

    // Phase 3: Select with fallbacks
    const selected = this.selectWithFallbacks(ranked, gameState, player);

    return this.buildPlan(selected, config);
  }

  /**
   * Only generate options that are validated as executable
   */
  private generateValidatedOptions(
    gameState: AIGameState,
    player: Player,
    config: AIConfig
  ): ValidatedOption[] {
    const options: ValidatedOption[] = [];

    // For build options, validate reachability BEFORE adding
    const buildCandidates = this.generateBuildCandidates(player, gameState);
    for (const candidate of buildCandidates) {
      const validation = this.validateBuildOption(candidate, player, gameState);
      if (validation.isValid) {
        options.push({
          ...candidate,
          validation,
          fallbacks: validation.alternatives,
        });
      }
    }

    // Similar validation for other option types...
    return options;
  }

  /**
   * Validate a build option is actually achievable
   */
  private validateBuildOption(
    option: BuildCandidate,
    player: Player,
    gameState: AIGameState
  ): BuildValidation {
    const playerTrack = gameState.allTrack.get(player.id) || [];

    // Check 1: Is target on same landmass as any of our track?
    const targetLandmass = this.geographyService.getLandmass(
      option.targetRow, option.targetCol
    );

    const ourLandmasses = this.getPlayerLandmasses(playerTrack);

    if (!ourLandmasses.has(targetLandmass)) {
      // Need ferry access - check if we have it
      const ferryRoute = this.findFerryAccess(ourLandmasses, targetLandmass);
      if (!ferryRoute) {
        return {
          isValid: false,
          reason: 'No ferry access to target landmass',
          alternatives: this.findAlternativesOnSameLandmass(ourLandmasses, player),
        };
      }
    }

    // Check 2: Can we actually pathfind there?
    const trackBuilder = getAITrackBuilder();
    const pathResult = trackBuilder.buildTrackToTarget(
      gameState.gameId,
      player.id,
      option.targetRow,
      option.targetCol,
      Math.min(player.money, 20)
    );

    if (!pathResult || pathResult.segments.length === 0) {
      return {
        isValid: false,
        reason: 'No valid path found',
        alternatives: this.findNearbyBuildableTargets(option, player, gameState),
      };
    }

    return { isValid: true, path: pathResult };
  }

  /**
   * Select actions with automatic fallback
   */
  private selectWithFallbacks(
    ranked: ValidatedOption[],
    gameState: AIGameState,
    player: Player
  ): SelectedAction[] {
    const selected: SelectedAction[] = [];

    for (const option of ranked) {
      if (selected.length >= 3) break; // Max 3 actions per turn

      // Try primary option
      if (this.canExecute(option, gameState, player)) {
        selected.push({ option, usedFallback: false });
        continue;
      }

      // Try fallbacks
      for (const fallback of option.fallbacks || []) {
        if (this.canExecute(fallback, gameState, player)) {
          selected.push({ option: fallback, usedFallback: true });
          break;
        }
      }
    }

    // If nothing selected, use emergency fallback
    if (selected.length === 0) {
      const emergency = this.getEmergencyAction(player, gameState);
      if (emergency) {
        selected.push({ option: emergency, usedFallback: true, emergency: true });
      }
    }

    return selected;
  }

  /**
   * Emergency fallback: build ANY valid track from current position
   */
  private getEmergencyAction(
    player: Player,
    gameState: AIGameState
  ): ValidatedOption | null {
    const playerTrack = gameState.allTrack.get(player.id) || [];

    if (playerTrack.length === 0) {
      // No track yet - pick any major city and build one segment
      const landmass = this.pickStartingLandmass(player);
      const cities = this.geographyService.getMajorCitiesOnLandmass(landmass);

      if (cities.length > 0) {
        const startCity = cities[0];
        const neighbors = this.getAdjacentBuildableMileposts(startCity.center);

        if (neighbors.length > 0) {
          return {
            type: 'build',
            details: {
              targetRow: neighbors[0].row,
              targetCol: neighbors[0].col,
              cost: 1,
            },
            validation: { isValid: true },
          };
        }
      }
    } else {
      // Have track - extend from any endpoint
      const endpoints = this.findTrackEndpoints(playerTrack);
      for (const endpoint of endpoints) {
        const neighbors = this.getAdjacentBuildableMileposts(endpoint);
        for (const neighbor of neighbors) {
          if (!this.isAlreadyBuilt(neighbor, playerTrack)) {
            return {
              type: 'build',
              details: {
                targetRow: neighbor.row,
                targetCol: neighbor.col,
                cost: this.estimateBuildCost(neighbor),
              },
              validation: { isValid: true },
            };
          }
        }
      }
    }

    return null; // Truly no options (shouldn't happen)
  }
}
```

### Refactored Build Flow for Initial Phase

```typescript
// Special handling for initial building phase (turns 1-2)

private generateInitialBuildOptions(
  player: Player,
  gameState: AIGameState
): ValidatedOption[] {
  const options: ValidatedOption[] = [];

  // Strategy: Pick a "home base" major city and expand from it
  const homeCity = this.selectHomeMajorCity(player, gameState);

  if (!homeCity) {
    // Fallback: any major city
    const allCities = getMajorCityGroups();
    return this.generateBuildFromCity(allCities[0], player, gameState);
  }

  // Build outward from home city toward demand card destinations
  // But only destinations on the SAME LANDMASS
  const homeLandmass = this.geographyService.getLandmass(
    homeCity.center.row,
    homeCity.center.col
  );

  for (const card of player.hand || []) {
    for (const demand of card.demands) {
      const destCity = this.findCityByName(demand.city);
      if (!destCity) continue;

      const destLandmass = this.geographyService.getLandmass(
        destCity.center.row,
        destCity.center.col
      );

      // Only consider same-landmass destinations initially
      if (destLandmass === homeLandmass) {
        const buildOption = this.planBuildToward(homeCity, destCity, player);
        if (buildOption) {
          options.push(buildOption);
        }
      }
    }
  }

  // Fallback: just build one segment from home city
  if (options.length === 0) {
    const fallback = this.buildOneSegmentFromCity(homeCity, player);
    if (fallback) {
      options.push(fallback);
    }
  }

  return options;
}

private selectHomeMajorCity(
  player: Player,
  gameState: AIGameState
): MajorCityGroup | null {
  // Consider:
  // 1. Which cities are near load sources for our demand cards
  // 2. Which cities have good connectivity to multiple destinations
  // 3. Avoid cities other players are already building from

  const allCities = getMajorCityGroups();
  const scores = new Map<string, number>();

  for (const city of allCities) {
    let score = 0;

    // Score based on demand card relevance
    for (const card of player.hand || []) {
      for (const demand of card.demands) {
        // Check if loads are available near this city
        const nearbyLoads = this.getLoadsNearCity(city, gameState);
        if (nearbyLoads.includes(demand.resource)) {
          score += demand.payment * 0.5;
        }

        // Check if delivery destination is reachable from this city
        const destCity = this.findCityByName(demand.city);
        if (destCity && this.geographyService.areSameLandmass(
          city.center, destCity.center
        )) {
          score += demand.payment * 0.3;
        }
      }
    }

    // Penalize if other players are already there
    const otherPlayersHere = this.countPlayersWithTrackAtCity(city, gameState);
    score -= otherPlayersHere * 10;

    scores.set(city.cityName, score);
  }

  // Return highest-scored city
  let bestCity: MajorCityGroup | null = null;
  let bestScore = -Infinity;

  for (const city of allCities) {
    const score = scores.get(city.cityName) || 0;
    if (score > bestScore) {
      bestScore = score;
      bestCity = city;
    }
  }

  return bestCity;
}
```

---

## Implementation Plan

### Phase 1: Quick Fix (Unblock Gameplay)
**Estimated effort: 2-4 hours**

1. Fix `aiTrackBuilder.ts` grid initialization (done - Issue 18)
2. Add emergency fallback to `executeActions()`:
   - If build fails, try to build ANY adjacent milepost
   - Log fallback usage for debugging

```typescript
// Quick fix in aiService.ts
case 'build':
  const buildResult = await this.executeBuildAction(gameId, playerId, action, player);
  if (!buildResult.success) {
    // Emergency fallback: build any adjacent track
    const fallbackResult = await this.executeEmergencyBuild(gameId, playerId, player);
    if (fallbackResult.success) {
      console.log(`AI ${playerId} used fallback build`);
    }
  }
  break;
```

### Phase 2: Geography Service
**Estimated effort: 1-2 days**

1. Create `GeographyService` with landmass detection
2. Precompute landmass data from grid configuration
3. Implement ferry route lookup
4. Add tests for geography calculations

### Phase 3: Planner Refactor
**Estimated effort: 2-3 days**

1. Integrate `GeographyService` into `AIPlanner`
2. Add validation at option generation time
3. Implement fallback selection logic
4. Add `selectHomeMajorCity()` for initial building phase
5. Update tests for new behavior

### Phase 4: Testing & Polish
**Estimated effort: 1-2 days**

1. Integration tests with various scenarios:
   - AI starting in England
   - AI starting on continent
   - AI with track on multiple landmasses
2. Performance testing (pathfinding should be fast)
3. Debug logging for AI decision transparency

---

## Success Criteria

1. **No silent failures**: AI always takes some action (even if fallback)
2. **Geographic intelligence**: AI doesn't try to build across water without ferry
3. **Resilient execution**: If primary plan fails, fallback kicks in
4. **Observable behavior**: Logs clearly show why AI made each decision
5. **Test coverage**: All new code has unit tests, key scenarios have integration tests

---

## Appendix: Current Data Flow Trace

```
Human ends turn
  └─> POST /api/game/:gameId/end-turn
        └─> PlayerService.endTurnForUser()
              └─> If nextPlayer.is_ai:
                    └─> aiService.executeAITurn(gameId, playerId)
                          ├─> getGameStateAndPlayer()
                          ├─> placeAITrainAtStartingCity() [if needed]
                          ├─> aiPlanner.planTurn() ← PLANNING HAPPENS HERE
                          │     ├─> generateOptions()
                          │     │     ├─> generateDeliveryOptions()
                          │     │     ├─> generatePickupOptions()
                          │     │     ├─> generateMovementOptions()
                          │     │     ├─> generateBuildOptions() ← USES AIPathfinder
                          │     │     └─> generateUpgradeOptions()
                          │     ├─> evaluateOptions()
                          │     └─> selectActions()
                          ├─> executeActions() ← EXECUTION HAPPENS HERE
                          │     ├─> executeBuildAction() ← USES AITrackBuilder
                          │     ├─> executeMoveAction()
                          │     ├─> executePickupAction()
                          │     └─> executeDeliverAction()
                          └─> emitTurnComplete()
```

---

## References

- `src/server/services/ai/aiPlanner.ts` - Strategic planning
- `src/server/services/ai/aiPathfinder.ts` - Route and build evaluation
- `src/server/services/ai/aiTrackBuilder.ts` - Server-side A* pathfinding
- `src/server/services/ai/aiService.ts` - Turn orchestration
- `src/server/services/ai/aiEvaluator.ts` - Position and card scoring
- `configuration/gridPoints.json` - Map data with terrain and ocean info
- `docs/project/ai-debugging-log.md` - Bug history and fixes
