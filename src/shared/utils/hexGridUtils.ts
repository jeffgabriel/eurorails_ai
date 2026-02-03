/**
 * Shared hex grid utility functions
 *
 * These utilities handle hex grid adjacency calculations that are used by:
 * - Client: TrackDrawingManager for track building UI
 * - Server: AITrackBuilder for AI pathfinding
 * - Shared: TrackBuildingService for validation
 */

import { TerrainType } from '../types/GameTypes';

/**
 * Minimal interface for grid points with row/col coordinates
 */
export interface GridCoordinate {
  row: number;
  col: number;
}

/**
 * Terrain costs for building track (in ECU millions)
 * Shared constant used by AITrackBuilder, TrackBuildingService, and TrackDrawingManager
 */
export const TERRAIN_BUILD_COSTS: Record<TerrainType, number> = {
  [TerrainType.Clear]: 1,
  [TerrainType.Mountain]: 2,
  [TerrainType.Alpine]: 5,
  [TerrainType.SmallCity]: 3,
  [TerrainType.MediumCity]: 3,
  [TerrainType.MajorCity]: 5,
  [TerrainType.Water]: 0,  // Impassable
  [TerrainType.FerryPort]: 0,
};

/**
 * Maximum ECU that can be spent on track building per turn
 */
export const TRACK_BUILD_BUDGET_PER_TURN = 20;

/**
 * Check if two grid points are adjacent in a hex grid
 *
 * Hex grid adjacency rules:
 * - Same row: must be consecutive columns (|colDiff| === 1)
 * - Adjacent rows: depends on odd/even row offset
 *   - Even rows can connect to: (row+1, col) and (row+1, col-1)
 *   - Odd rows can connect to: (row+1, col) and (row+1, col+1)
 *
 * @param point1 First grid coordinate
 * @param point2 Second grid coordinate
 * @returns true if the points are adjacent in the hex grid
 */
export function isAdjacentHexGrid(point1: GridCoordinate, point2: GridCoordinate): boolean {
  if (!point1 || !point2) {
    return false;
  }

  const rowDiff = point2.row - point1.row;
  const colDiff = point2.col - point1.col;

  // Same row adjacency - must be consecutive columns
  if (rowDiff === 0) {
    return Math.abs(colDiff) === 1;
  }

  // Must be adjacent rows
  if (Math.abs(rowDiff) !== 1) {
    return false;
  }

  // For hex grid:
  // Even rows can connect to: (row+1, col) and (row+1, col-1)
  // Odd rows can connect to: (row+1, col) and (row+1, col+1)
  const isFromOddRow = point1.row % 2 === 1;

  if (rowDiff === 1) {  // Moving down
    if (isFromOddRow) {
      return colDiff === 0 || colDiff === 1;
    } else {
      return colDiff === 0 || colDiff === -1;
    }
  } else {  // Moving up (rowDiff === -1)
    const isToOddRow = point2.row % 2 === 1;
    if (isToOddRow) {
      return colDiff === 0 || colDiff === -1;
    } else {
      return colDiff === 0 || colDiff === 1;
    }
  }
}

/**
 * Get the relative offsets for all possible hex neighbors
 *
 * Note: Not all of these will be valid for a given row due to hex grid offset.
 * Use isAdjacentHexGrid to verify actual adjacency.
 *
 * @returns Array of row/col offsets to check
 */
export function getHexNeighborOffsets(): { rowDelta: number; colDelta: number }[] {
  return [
    { rowDelta: 0, colDelta: -1 },   // Left
    { rowDelta: 0, colDelta: 1 },    // Right
    { rowDelta: -1, colDelta: -1 },  // Upper left
    { rowDelta: -1, colDelta: 0 },   // Upper
    { rowDelta: -1, colDelta: 1 },   // Upper right
    { rowDelta: 1, colDelta: -1 },   // Lower left
    { rowDelta: 1, colDelta: 0 },    // Lower
    { rowDelta: 1, colDelta: 1 },    // Lower right
  ];
}

/**
 * Calculate the terrain-based cost for building to a milepost
 *
 * @param toTerrain The terrain type of the destination milepost
 * @returns Cost in ECU millions
 */
export function calculateTerrainBuildCost(toTerrain: TerrainType): number {
  return TERRAIN_BUILD_COSTS[toTerrain] || 1;
}

/**
 * Calculate hex grid heuristic distance for A* pathfinding
 * Uses Manhattan distance adapted for hex grid
 *
 * @param from Starting coordinate
 * @param to Target coordinate
 * @returns Estimated distance
 */
export function hexGridHeuristic(from: GridCoordinate, to: GridCoordinate): number {
  return Math.abs(from.row - to.row) + Math.abs(from.col - to.col);
}
