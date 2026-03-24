# Code Duplication Analysis: Pathfinding & Cost Calculations

_Date: 2026-03-10_

## Overview

Analysis of duplicated game mechanics between the bot AI pipeline and client-side/shared code paths, focused on pathfinding, terrain costs, and movement calculations.

---

## 1. Terrain Cost — 3 Separate Copies (HIGH PRIORITY)

The same cost table is hardcoded in three places:

| Location | Water Value | Used By |
|----------|-------------|---------|
| `src/server/services/ai/MapTopology.ts:134-146` | Infinity | Bot Dijkstra pathfinding |
| `src/client/components/TrackDrawingManager.ts:36-45` | 0 | Human path preview UI |
| `src/shared/services/TrackBuildingService.ts:47-59` | 0 | Track building validation |

All three share identical values for the core terrain types:
- Clear=1, Mountain=2, Alpine=5, SmallCity=3, MediumCity=3, MajorCity=5, FerryPort=0

**Bug:** The client and shared versions set Water=0 instead of Infinity. This could allow the UI to suggest building on water tiles.

**Fix:** Extract to a single `src/shared/config/terrainCosts.ts` constant. All three consumers import from it.

---

## 2. Water Crossing Cost — Shared Exists But Server Reimplements

A proper shared utility already exists:
- **Shared:** `src/shared/config/waterCrossings.ts` → `getWaterCrossingExtraCost(from, to)`
- **Client:** `src/client/components/TrackDrawingManager.ts:1360` — correctly uses the shared function

**Duplication:** `src/server/services/ai/computeBuildSegments.ts:24-40` reimplements its own `getWaterCrossingCost()` with separate edge normalization logic instead of using the shared function.

**Fix:** Use the existing shared `getWaterCrossingExtraCost()` in `computeBuildSegments.ts`.

---

## 3. Pathfinding Algorithms — 4 Separate Implementations

| Location | Algorithm | Purpose |
|----------|-----------|---------|
| `src/server/services/ai/computeBuildSegments.ts` | Dijkstra w/ min-heap | Bot track building (budget-constrained, multi-source) |
| `src/client/components/TrackDrawingManager.ts:958-1213` | Dijkstra O(n²) | Human path preview (limited search area) |
| `src/shared/services/TrackNetworkService.ts:97-153` | A* | Route connectivity checking |
| `src/shared/services/trackUsageFees.ts:114-150` | Dijkstra-like | Cheapest movement path (prefer own track) |

Each is optimized for a different use case, so full unification isn't practical. However, they share common primitives that should be extracted:
- Hex grid adjacency / neighbor lookup
- Terrain cost evaluation
- Major city red-area traversal (free intra-city edges)
- Water crossing cost lookup

**Recommendation:** Create a shared graph abstraction and cost function interface rather than each implementation hardcoding terrain/water/city logic independently.

---

## 4. Hex Grid Utilities — Duplicated

Two separate implementations of hex neighbor lookup:
- `src/server/services/ai/MapTopology.ts` → `getHexNeighbors()`
- `src/client/components/TrackDrawingManager.ts:1239-1282` → inline hex adjacency logic

**Fix:** Extract to `src/shared/utils/hexGrid.ts` with neighbor lookup, distance calculation, and coordinate conversion.

---

## 5. Major City Groups — Duplicated

Major city connectivity data appears in two places:
- `src/shared/services/majorCityGroups.ts` — exports `getMajorCityLookup()`, `getMajorCityGroups()`, `isIntraCityEdge()`
- `src/client/config/mapConfig.ts` — mirrors the same major city group data

**Fix:** Consolidate to the shared module; client config should import from it.

---

## 6. What's Properly Shared (Good Examples)

- **Train properties** (speed, capacity) — centralized in `src/shared/types/GameTypes.ts` (`TRAIN_PROPERTIES`), used by both client and server.
- **Water crossings config** — exists in `src/shared/config/waterCrossings.ts`, though not universally adopted.

These demonstrate the pattern the rest should follow.

---

## Recommended Refactoring Priority

### Phase 1 — Low-hanging fruit (low risk)
1. Extract terrain costs to `src/shared/config/terrainCosts.ts`
2. Use shared `getWaterCrossingExtraCost()` in `computeBuildSegments.ts`
3. Fix Water=0 bug in client/shared terrain cost maps

### Phase 2 — Moderate effort
4. Extract hex grid utilities to `src/shared/utils/hexGrid.ts`
5. Consolidate major city groups to single shared source

### Phase 3 — Larger refactor
6. Define a shared graph cost interface that all four pathfinding implementations use for terrain/water/city cost evaluation, while keeping their algorithm-specific optimizations
