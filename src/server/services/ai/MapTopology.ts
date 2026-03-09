/**
 * MapTopology — Server-side hex grid utilities for AI bot pathfinding.
 *
 * Loads gridPoints.json once, caches in memory, and provides
 * neighbor lookup, coordinate conversion, and terrain cost helpers.
 */

import fs from 'fs';
import path from 'path';
import { TerrainType, WaterCrossingType } from '../../../shared/types/GameTypes';
import type { FerryEdge } from '../../../shared/services/majorCityGroups';
import waterCrossingsData from '../../../../configuration/waterCrossings.json';

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

export function makeKey(row: number, col: number): string {
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

/** Compute the distance between two hex grid positions using cube coordinates. */
export function hexDistance(r1: number, c1: number, r2: number, c2: number): number {
  // Offset hex → cube coordinate conversion
  const x1 = c1 - Math.floor(r1 / 2);
  const z1 = r1;
  const y1 = -x1 - z1;
  const x2 = c2 - Math.floor(r2 / 2);
  const z2 = r2;
  const y2 = -x2 - z2;
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
}

/**
 * Find the paired ferry port for a given ferry port coordinate.
 * Uses ferryEdges data to look up which port is on the other side of the crossing.
 *
 * @returns The paired port coordinates, or null if the position is not a ferry port.
 */
export function getFerryPairPort(
  row: number,
  col: number,
  ferryEdges: Array<{ name: string; pointA: { row: number; col: number }; pointB: { row: number; col: number }; cost: number }>,
): { row: number; col: number } | null {
  for (const edge of ferryEdges) {
    if (edge.pointA.row === row && edge.pointA.col === col) {
      return { row: edge.pointB.row, col: edge.pointB.col };
    }
    if (edge.pointB.row === row && edge.pointB.col === col) {
      return { row: edge.pointA.row, col: edge.pointA.col };
    }
  }
  return null;
}

// ── Ferry route info ──────────────────────────────────────────────────

export interface FerryRouteInfo {
  /** Whether the bot has track at a departure ferry port and can cross for free */
  canCrossFerry: boolean;
  /** Departure-side ferry ports on the source landmass */
  departurePorts: GridCoord[];
  /** Arrival-side ferry ports (partners of departure ports) */
  arrivalPorts: GridCoord[];
  /** Cheapest ferry connection cost (ECU millions) */
  cheapestFerryCost: number;
}

/**
 * BFS flood-fill from source positions across non-water tiles.
 * Returns the set of "row,col" keys reachable from sources without crossing water.
 */
export function computeLandmass(
  sources: GridCoord[],
  grid: Map<string, GridPointData>,
): Set<string> {
  const landmass = new Set<string>();
  const queue: GridCoord[] = [];
  for (const src of sources) {
    const key = makeKey(src.row, src.col);
    if (!landmass.has(key)) {
      landmass.add(key);
      queue.push(src);
    }
  }
  while (queue.length > 0) {
    const node = queue.pop()!;
    for (const nb of getHexNeighbors(node.row, node.col)) {
      const nbKey = makeKey(nb.row, nb.col);
      if (landmass.has(nbKey)) continue;
      const nbData = grid.get(nbKey);
      if (!nbData || nbData.terrain === TerrainType.Water) continue;
      landmass.add(nbKey);
      queue.push(nb);
    }
  }
  return landmass;
}

/**
 * Analyze ferry crossing state for a bot on a given landmass.
 * Returns whether the bot can cross a ferry, the departure/arrival ports,
 * and the cheapest ferry cost.
 */
export function computeFerryRouteInfo(
  sourceLandmass: Set<string>,
  onNetwork: Set<string>,
  ferryEdges: FerryEdge[],
): FerryRouteInfo {
  let canCrossFerry = false;
  const departurePorts: GridCoord[] = [];
  const arrivalPorts: GridCoord[] = [];
  let cheapestFerryCost = Infinity;
  const seen = new Set<string>();

  for (const ferry of ferryEdges) {
    const aKey = makeKey(ferry.pointA.row, ferry.pointA.col);
    const bKey = makeKey(ferry.pointB.row, ferry.pointB.col);
    const aOnSource = sourceLandmass.has(aKey);
    const bOnSource = sourceLandmass.has(bKey);

    if (aOnSource && !bOnSource) {
      if (onNetwork.has(aKey)) canCrossFerry = true;
      if (!seen.has(aKey)) {
        seen.add(aKey);
        departurePorts.push({ row: ferry.pointA.row, col: ferry.pointA.col });
        arrivalPorts.push({ row: ferry.pointB.row, col: ferry.pointB.col });
        if (ferry.cost < cheapestFerryCost) cheapestFerryCost = ferry.cost;
      }
    } else if (bOnSource && !aOnSource) {
      if (onNetwork.has(bKey)) canCrossFerry = true;
      if (!seen.has(bKey)) {
        seen.add(bKey);
        departurePorts.push({ row: ferry.pointB.row, col: ferry.pointB.col });
        arrivalPorts.push({ row: ferry.pointA.row, col: ferry.pointA.col });
        if (ferry.cost < cheapestFerryCost) cheapestFerryCost = ferry.cost;
      }
    }
    // If both on same landmass, this ferry is irrelevant for crossing
  }

  return { canCrossFerry, departurePorts, arrivalPorts, cheapestFerryCost };
}

// ── Water crossing cost lookup (shared with computeBuildSegments) ────
// River = +2M, Lake/Ocean inlet = +3M (additive to terrain cost).
const _waterCrossingCosts = new Map<string, number>();
for (const edge of (waterCrossingsData as { riverEdges?: string[]; nonRiverWaterEdges?: string[] }).riverEdges ?? []) {
  _waterCrossingCosts.set(edge, WaterCrossingType.River); // 2
}
for (const edge of (waterCrossingsData as { riverEdges?: string[]; nonRiverWaterEdges?: string[] }).nonRiverWaterEdges ?? []) {
  _waterCrossingCosts.set(edge, WaterCrossingType.Lake); // 3
}

/** Extra cost for building across a river, lake, or ocean inlet. */
export function getWaterCrossingCost(fromRow: number, fromCol: number, toRow: number, toCol: number): number {
  const a = `${fromRow},${fromCol}`;
  const b = `${toRow},${toCol}`;
  const key = a <= b ? `${a}|${b}` : `${b}|${a}`;
  return _waterCrossingCosts.get(key) ?? 0;
}

// ── Terrain-aware cost estimation via Dijkstra ──────────────────────

interface CostNode {
  row: number;
  col: number;
  cost: number;
}

class CostHeap {
  private data: CostNode[] = [];
  get size(): number { return this.data.length; }

  push(node: CostNode): void {
    this.data.push(node);
    let i = this.data.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i].cost >= this.data[parent].cost) break;
      [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
      i = parent;
    }
  }

  pop(): CostNode | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      let i = 0;
      while (true) {
        let smallest = i;
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        if (left < this.data.length && this.data[left].cost < this.data[smallest].cost) smallest = left;
        if (right < this.data.length && this.data[right].cost < this.data[smallest].cost) smallest = right;
        if (smallest === i) break;
        [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * Estimate the minimum terrain-aware build cost between two hex positions.
 * Uses Dijkstra's algorithm over the actual hex grid with real terrain costs
 * and water crossing surcharges. Returns cost in ECU millions.
 *
 * Returns 0 if source equals target or target is unreachable.
 */
export function estimatePathCost(
  fromRow: number, fromCol: number,
  toRow: number, toCol: number,
): number {
  if (fromRow === toRow && fromCol === toCol) return 0;

  const grid = loadGridPoints();
  const targetKey = makeKey(toRow, toCol);
  if (!grid.has(targetKey)) return 0;

  const visited = new Map<string, number>();
  const heap = new CostHeap();
  const startKey = makeKey(fromRow, fromCol);
  heap.push({ row: fromRow, col: fromCol, cost: 0 });
  visited.set(startKey, 0);

  while (heap.size > 0) {
    const current = heap.pop()!;
    const currentKey = makeKey(current.row, current.col);

    if (currentKey === targetKey) return Math.round(current.cost);

    // Skip if we've already found a cheaper path to this node
    if (current.cost > (visited.get(currentKey) ?? Infinity)) continue;

    for (const nb of getHexNeighbors(current.row, current.col)) {
      const nbData = grid.get(makeKey(nb.row, nb.col));
      if (!nbData) continue;

      const terrainCost = getTerrainCost(nbData.terrain);
      if (terrainCost === Infinity) continue;

      const waterCost = getWaterCrossingCost(current.row, current.col, nb.row, nb.col);
      const newCost = current.cost + terrainCost + waterCost;

      const nbKey = makeKey(nb.row, nb.col);
      if (newCost < (visited.get(nbKey) ?? Infinity)) {
        visited.set(nbKey, newCost);
        heap.push({ row: nb.row, col: nb.col, cost: newCost });
      }
    }
  }

  return 0; // Target unreachable
}

/**
 * Estimate the minimum hop count (milepost edges) between two hex positions.
 * Uses BFS over the actual hex grid — unlike hexDistance() which returns
 * straight-line Chebyshev distance ignoring map topology.
 *
 * Returns 0 if source equals target or target is unreachable.
 */
export function estimateHopDistance(
  fromRow: number, fromCol: number,
  toRow: number, toCol: number,
): number {
  if (fromRow === toRow && fromCol === toCol) return 0;

  const grid = loadGridPoints();
  const startKey = makeKey(fromRow, fromCol);
  const targetKey = makeKey(toRow, toCol);
  if (!grid.has(startKey) || !grid.has(targetKey)) return 0;

  const visited = new Set<string>();
  visited.add(startKey);
  const queue: Array<{ key: string; hops: number }> = [{ key: startKey, hops: 0 }];

  while (queue.length > 0) {
    const { key, hops } = queue.shift()!;
    const [row, col] = key.split(',').map(Number);

    for (const nb of getHexNeighbors(row, col)) {
      const nbKey = makeKey(nb.row, nb.col);
      if (!grid.has(nbKey)) continue;

      const nbData = grid.get(nbKey)!;
      if (nbData.terrain === TerrainType.Water) continue;

      if (nbKey === targetKey) return hops + 1;

      if (!visited.has(nbKey)) {
        visited.add(nbKey);
        queue.push({ key: nbKey, hops: hops + 1 });
      }
    }
  }

  return 0; // Target unreachable
}

/** Reset the cache (for testing). */
export function _resetCache(): void {
  gridPointsCache = null;
}
