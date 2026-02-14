/**
 * MapTopology — Server-side hex grid utilities for AI bot pathfinding.
 *
 * Loads gridPoints.json once, caches in memory, and provides
 * neighbor lookup, coordinate conversion, and terrain cost helpers.
 */

import fs from 'fs';
import path from 'path';
import { TerrainType } from '../../../shared/types/GameTypes';

/** Parsed grid point from gridPoints.json */
export interface GridPointData {
  row: number;
  col: number;
  terrain: TerrainType;
  name?: string;
  ocean?: string;
}

/** Grid coordinate pair */
export interface GridCoord {
  row: number;
  col: number;
}

// ── Constants ──────────────────────────────────────────────────────────
const HORIZONTAL_SPACING = 50;
const VERTICAL_SPACING = 45;
const GRID_MARGIN = 120;

// ── Cache ──────────────────────────────────────────────────────────────
let gridPointsCache: Map<string, GridPointData> | null = null;

function makeKey(row: number, col: number): string {
  return `${row},${col}`;
}

// ── Type mapping (mirrors client mapConfig.ts) ─────────────────────────
function mapTypeToTerrain(type: string): TerrainType {
  switch (type) {
    case 'Clear':
    case 'Milepost':
      return TerrainType.Clear;
    case 'Mountain':
      return TerrainType.Mountain;
    case 'Alpine':
      return TerrainType.Alpine;
    case 'Small City':
      return TerrainType.SmallCity;
    case 'Medium City':
      return TerrainType.MediumCity;
    case 'Major City':
    case 'Major City Outpost':
      return TerrainType.MajorCity;
    case 'Ferry Port':
      return TerrainType.FerryPort;
    case 'Water':
      return TerrainType.Water;
    default:
      return TerrainType.Clear;
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/** Load gridPoints.json into a Map keyed by "row,col". Cached after first call. */
export function loadGridPoints(): Map<string, GridPointData> {
  if (gridPointsCache) return gridPointsCache;

  const filePath = path.resolve(__dirname, '../../../../configuration/gridPoints.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Array<{
    GridX: number;
    GridY: number;
    Type: string;
    Name?: string;
    Ocean?: string;
  }>;

  const map = new Map<string, GridPointData>();
  for (const mp of raw) {
    if (typeof mp.GridX !== 'number' || typeof mp.GridY !== 'number') continue;
    const row = mp.GridY;
    const col = mp.GridX;
    map.set(makeKey(row, col), {
      row,
      col,
      terrain: mapTypeToTerrain(mp.Type),
      name: mp.Name ?? undefined,
      ocean: mp.Ocean ?? undefined,
    });
  }

  gridPointsCache = map;
  return map;
}

/**
 * Return valid hex neighbors for a grid position.
 * Uses even-q offset: even rows offset left, odd rows offset right.
 * Excludes water tiles and coordinates that don't exist on the map.
 */
export function getHexNeighbors(row: number, col: number): GridCoord[] {
  const grid = loadGridPoints();
  const isEvenRow = row % 2 === 0;

  const deltas: [number, number][] = isEvenRow
    ? [[-1, -1], [-1, 0], [0, -1], [0, 1], [1, -1], [1, 0]]
    : [[-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0], [1, 1]];

  const neighbors: GridCoord[] = [];
  for (const [dr, dc] of deltas) {
    const nr = row + dr;
    const nc = col + dc;
    const point = grid.get(makeKey(nr, nc));
    if (point && !isWater(point.terrain)) {
      neighbors.push({ row: nr, col: nc });
    }
  }
  return neighbors;
}

/** Convert grid coordinates to pixel coordinates. */
export function gridToPixel(row: number, col: number): { x: number; y: number } {
  const isOffsetRow = row % 2 === 1;
  const x = col * HORIZONTAL_SPACING + GRID_MARGIN + (isOffsetRow ? HORIZONTAL_SPACING / 2 : 0);
  const y = row * VERTICAL_SPACING + GRID_MARGIN;
  return { x, y };
}

/** Return the build cost for a terrain type in ECU millions. */
export function getTerrainCost(terrain: TerrainType): number {
  switch (terrain) {
    case TerrainType.Clear:       return 1;
    case TerrainType.Mountain:    return 2;
    case TerrainType.Alpine:      return 5;
    case TerrainType.SmallCity:   return 3;
    case TerrainType.MediumCity:  return 3;
    case TerrainType.MajorCity:   return 5;
    case TerrainType.FerryPort:   return 0; // actual cost is ferryConnection.cost (4–16M), applied at call site
    case TerrainType.Water:       return Infinity;
    default:                      return 1;
  }
}

/** Check if a terrain type is water (unbuildable). */
export function isWater(terrain: TerrainType): boolean {
  return terrain === TerrainType.Water;
}

/** Reset the cache (for testing). */
export function _resetCache(): void {
  gridPointsCache = null;
}
