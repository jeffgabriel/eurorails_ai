# JIRA-177: Build Advisor LLM Context Improvements

**Status:** TODO

## Problem

The build advisor LLM call produces correct waypoints in open terrain but fails spectacularly in several recurring scenarios:

1. **Ferry points (e.g., Le Havre → England):** The LLM doesn't see the English Channel ferries and tries to build track into the ocean.
2. **Tight narrow corridors (especially UK):** Criss-cross tracks from the same bot, redundant and tangled routes.
3. **Redundant parallel lines:** Builds Le Havre → Milan when an existing line from Ruhr → Lyon already provides the connection.

## Root Causes

### 1. Ferry ports are invisible on the corridor map
`MapRenderer.ts:16` — `TerrainType.FerryPort` renders as `'.'` (same as clear terrain). The LLM cannot distinguish a ferry port from an empty milepost. Ferry connections (`FerryConnection` objects with paired ports and costs) exist in the data model but are **never included** in the prompt.

### 2. Water is impassable but the prompt doesn't say so
The system prompt (`systemPrompts.ts:410-422`) mentions water crossing costs (river +2M, lake +3M, ocean inlet +3M) but **never states that open water (`~`) is impassable for building**. The LLM interprets `~` as expensive terrain rather than a hard wall, and tries to route through it.

### 3. No track segment connectivity — just scattered dots
Bot track renders as individual `B` cells on the map. The LLM cannot tell which `B` cells connect to which. Two disconnected track branches both show as scattered `B` markers, so the LLM may propose building a redundant parallel line because it can't see the existing route already reaches the destination through a different path.

### 4. Hex topology is hidden behind a flat grid
The map renders as a rectangular grid but the game uses hex adjacency. In narrow corridors (UK, Scandinavia), the LLM guesses connections from visual proximity on a flat grid. Two cells that look adjacent may not be hex-neighbors, producing criss-cross waypoints.

## Proposed Fixes

### Fix 1: Show ferry ports and connections (highest impact)

**MapRenderer.ts:**
- Change `TerrainType.FerryPort` rendering from `'.'` to `'F'`.

**systemPrompts.ts — add FERRY CONNECTIONS section to user prompt:**
- List each ferry route visible in the corridor with: name, endpoint coordinates, cost.
- Example:
  ```
  FERRY CONNECTIONS (within corridor):
    English Channel (Calais): (12,8) ↔ (10,7) — cost 15M
    English Channel (Le Havre): (14,6) ↔ (12,5) — cost 20M
  ```
- Pass `gridPoints` (or extracted ferry data) into `getBuildAdvisorPrompt()` to generate this section.

**System prompt — add ferry rule:**
```
FERRIES: Ferry ports (F) connect across water. You must route through a ferry port to cross water — you cannot build across open water (~).
```

### Fix 2: Explicitly state water is impassable

**systemPrompts.ts — add to TRACK BUILDING RULES:**
```
- Water (~) is impassable — you CANNOT build track across open water. Use ferry connections to cross water bodies.
- River/lake/inlet crossings are only possible where the map has adjacent land mileposts across the water feature.
```

### Fix 3: Show track as connected segments

**Add a TRACK NETWORK section to user prompt:**
- Instead of (or in addition to) relying on `B` dots, list bot's track as connected segments grouped by contiguous path.
- Example:
  ```
  YOUR TRACK NETWORK:
    Segment chain: Paris(14,6) → (13,7) → (12,8) → Bruxelles(11,9) → (10,10) → Ruhr(9,11)
    Segment chain: Ruhr(9,11) → (10,12) → (11,13) → Lyon(14,14) → (15,15) → Milano(17,16)
  ```
- This tells the LLM exactly what's connected and prevents redundant parallel builds.
- **Implementation:** Walk `existingSegments` from endpoints, grouping into chains. Annotate city names where segments pass through cities.

### Fix 4: Add legend entry for ferry and water impassability

**MapRenderer.ts legend:**
```
F=ferry port ~=water(impassable)
```

Currently `~` appears on the map with no legend entry and `F` doesn't exist at all.

## Implementation Order

1. **Fix 1 + Fix 2 + Fix 4** together (ferry visibility + water rules + legend) — this is the critical fix for the ocean-building failures and should be done as a single change.
2. **Fix 3** (track connectivity) — addresses the redundant-line and UK criss-cross problems. Can be done independently.

## Files to Modify

| File | Change |
|------|--------|
| `src/server/services/ai/MapRenderer.ts` | Ferry port char `'F'`, legend update, `~=water(impassable)` |
| `src/server/services/ai/prompts/systemPrompts.ts` | Ferry connections section, water impassability rule, ferry rule in system prompt |
| `src/server/services/ai/BuildAdvisor.ts` | Pass ferry connection data through to prompt builder |

## Out of Scope

- Hex topology visualization (would require a fundamentally different map format — ASCII can't represent hex adjacency well). The waypoint snapping already handles most hex-adjacency misses.
- Demand card inclusion (intentionally excluded per JIRA-148).
- Geographic water body labels (nice-to-have but ferry connections section solves the core problem).
