/**
 * AI Track Builder - Server-side track pathfinding and building for AI players
 *
 * This service loads the grid data from configuration and provides pathfinding
 * capabilities to calculate valid track segments between mileposts.
 */

import { TerrainType } from '../../../shared/types/GameTypes';
import { TrackSegment, PlayerTrackState } from '../../../shared/types/TrackTypes';
import { TrackService } from '../trackService';
import { getMajorCityGroups, getAllCityCoordinates } from '../../../shared/services/majorCityGroups';
import { getWaterCrossingExtraCost } from '../../../shared/config/waterCrossings';
import {
  isAdjacentHexGrid,
  getHexNeighborOffsets,
  calculateTerrainBuildCost,
  hexGridHeuristic,
  TERRAIN_BUILD_COSTS,
  TRACK_BUILD_BUDGET_PER_TURN,
} from '../../../shared/utils/hexGridUtils';

// Load grid points from configuration
import gridPointsConfig from '../../../../configuration/gridPoints.json';

/**
 * Represents a grid point loaded from configuration
 */
interface GridPointData {
  Id: string;
  Type: string;
  Name: string | null;
  GridX: number;
  GridY: number;
  Ocean: string | null;
}

/**
 * Internal milepost representation for pathfinding
 */
interface Milepost {
  id: string;
  row: number;
  col: number;
  x: number;  // Pixel x (calculated from row/col)
  y: number;  // Pixel y (calculated from row/col)
  terrain: TerrainType;
  name: string | null;
  isOcean: boolean;
}

// Terrain costs and budget are imported from shared/utils/hexGridUtils.ts

/**
 * AI Track Builder Service
 */
export class AITrackBuilder {
  private mileposts: Map<string, Milepost> = new Map();
  private gridByCoord: Map<string, Milepost> = new Map();
  private initialized: boolean = false;

  constructor() {
    this.initialize();
  }

  /**
   * Initialize the grid data from configuration
   */
  private initialize(): void {
    if (this.initialized) return;

    const gridPoints = gridPointsConfig as GridPointData[];

    for (const point of gridPoints) {
      const terrain = this.parseTerrainType(point.Type);

      // Skip water points - they're not buildable
      if (terrain === TerrainType.Water || point.Ocean) {
        continue;
      }

      const milepost: Milepost = {
        id: point.Id,
        row: point.GridY,
        col: point.GridX,
        x: this.calculatePixelX(point.GridX, point.GridY),
        y: this.calculatePixelY(point.GridY),
        terrain,
        name: point.Name,
        isOcean: point.Ocean !== null,
      };

      this.mileposts.set(point.Id, milepost);
      this.gridByCoord.set(`${point.GridY},${point.GridX}`, milepost);
    }

    this.initialized = true;
    console.log(`AITrackBuilder initialized with ${this.mileposts.size} mileposts`);
  }

  /**
   * Parse terrain type from string
   */
  private parseTerrainType(type: string): TerrainType {
    switch (type) {
      case 'Major City':
      case 'Major City Outpost':
        return TerrainType.MajorCity;
      case 'Medium City':
        return TerrainType.MediumCity;
      case 'Small City':
        return TerrainType.SmallCity;
      case 'Mountain':
        return TerrainType.Mountain;
      case 'Alpine':
        return TerrainType.Alpine;
      case 'Ferry Port':
        return TerrainType.FerryPort;
      case 'Water':
      case 'Ocean':
        return TerrainType.Water;
      case 'Milepost':
      case 'Clear':
      default:
        return TerrainType.Clear;
    }
  }

  /**
   * Calculate pixel X from grid coordinates (approximation for segment data)
   */
  private calculatePixelX(col: number, row: number): number {
    // Hex grid: offset for odd rows
    const HEX_SIZE = 50;  // Approximate hex size
    const isOddRow = row % 2 === 1;
    const xOffset = isOddRow ? HEX_SIZE / 2 : 0;
    return col * HEX_SIZE * 0.866 + xOffset + 100;  // 100 = margin
  }

  /**
   * Calculate pixel Y from grid coordinates
   */
  private calculatePixelY(row: number): number {
    const HEX_SIZE = 50;
    return row * HEX_SIZE * 0.75 + 100;  // 100 = margin
  }

  /**
   * Check if two grid points are adjacent in the hex grid
   * Uses shared utility from hexGridUtils.ts
   */
  private isAdjacent(p1: Milepost, p2: Milepost): boolean {
    return isAdjacentHexGrid(p1, p2);
  }

  /**
   * Get all adjacent mileposts for a given point
   * Uses shared hex neighbor offsets from hexGridUtils.ts
   */
  private getNeighbors(milepost: Milepost): Milepost[] {
    const neighbors: Milepost[] = [];
    const offsets = getHexNeighborOffsets();

    for (const offset of offsets) {
      const neighborRow = milepost.row + offset.rowDelta;
      const neighborCol = milepost.col + offset.colDelta;
      const key = `${neighborRow},${neighborCol}`;
      const neighbor = this.gridByCoord.get(key);

      if (neighbor && neighbor.terrain !== TerrainType.Water && this.isAdjacent(milepost, neighbor)) {
        neighbors.push(neighbor);
      }
    }

    return neighbors;
  }

  /**
   * Calculate the cost to build track to a milepost
   * Uses shared terrain cost calculation from hexGridUtils.ts
   */
  private calculateSegmentCost(from: Milepost, to: Milepost): number {
    // Use shared terrain cost calculation
    return calculateTerrainBuildCost(to.terrain);
  }

  /**
   * Calculate heuristic distance for A* (Manhattan distance adapted for hex)
   * Uses shared heuristic from hexGridUtils.ts
   */
  private heuristic(from: Milepost, to: Milepost): number {
    return hexGridHeuristic(from, to);
  }

  /**
   * Find the shortest path from a start point to a target point using A*
   */
  findPath(
    startRow: number,
    startCol: number,
    targetRow: number,
    targetCol: number,
    existingTrack: TrackSegment[] = [],
    otherPlayersTracks: TrackSegment[] = []
  ): { path: Milepost[]; cost: number } | null {
    const startKey = `${startRow},${startCol}`;
    const targetKey = `${targetRow},${targetCol}`;

    const start = this.gridByCoord.get(startKey);
    const target = this.gridByCoord.get(targetKey);

    if (!start || !target) {
      console.log(`AITrackBuilder: Start or target not found: ${startKey} -> ${targetKey}`);
      return null;
    }

    // Build set of coordinates in existing track
    const existingTrackCoords = new Set<string>();
    for (const segment of existingTrack) {
      existingTrackCoords.add(`${segment.from.row},${segment.from.col}`);
      existingTrackCoords.add(`${segment.to.row},${segment.to.col}`);
    }

    // Build set of segments owned by other players (can't build on these)
    const otherPlayersSegments = new Set<string>();
    for (const segment of otherPlayersTracks) {
      const segKey = this.segmentKey(segment.from.row, segment.from.col, segment.to.row, segment.to.col);
      otherPlayersSegments.add(segKey);
    }

    // A* algorithm
    const openSet = new Set<string>([startKey]);
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>();
    const fScore = new Map<string, number>();

    gScore.set(startKey, 0);
    fScore.set(startKey, this.heuristic(start, target));

    while (openSet.size > 0) {
      // Get node with lowest fScore
      let currentKey = '';
      let lowestF = Infinity;
      for (const key of openSet) {
        const f = fScore.get(key) ?? Infinity;
        if (f < lowestF) {
          lowestF = f;
          currentKey = key;
        }
      }

      if (currentKey === targetKey) {
        // Reconstruct path
        const path: Milepost[] = [];
        let current = currentKey;
        while (current) {
          const milepost = this.gridByCoord.get(current);
          if (milepost) path.unshift(milepost);
          current = cameFrom.get(current) || '';
        }

        // Calculate total cost
        let totalCost = 0;
        for (let i = 0; i < path.length - 1; i++) {
          const segKey = this.segmentKey(path[i].row, path[i].col, path[i + 1].row, path[i + 1].col);
          // Only add cost if this segment isn't already owned
          const fromKey = `${path[i].row},${path[i].col}`;
          const toKey = `${path[i + 1].row},${path[i + 1].col}`;
          if (!existingTrackCoords.has(fromKey) || !existingTrackCoords.has(toKey)) {
            totalCost += this.calculateSegmentCost(path[i], path[i + 1]);
          }
        }

        return { path, cost: totalCost };
      }

      openSet.delete(currentKey);
      const current = this.gridByCoord.get(currentKey);
      if (!current) continue;

      for (const neighbor of this.getNeighbors(current)) {
        const neighborKey = `${neighbor.row},${neighbor.col}`;

        // Check if segment exists on other players' tracks
        const segKey = this.segmentKey(current.row, current.col, neighbor.row, neighbor.col);
        if (otherPlayersSegments.has(segKey)) {
          continue;  // Can't build on other players' track
        }

        // Calculate tentative gScore
        const segmentCost = existingTrackCoords.has(neighborKey) ? 0 : this.calculateSegmentCost(current, neighbor);
        const tentativeG = (gScore.get(currentKey) ?? Infinity) + segmentCost;

        if (tentativeG < (gScore.get(neighborKey) ?? Infinity)) {
          cameFrom.set(neighborKey, currentKey);
          gScore.set(neighborKey, tentativeG);
          fScore.set(neighborKey, tentativeG + this.heuristic(neighbor, target));

          if (!openSet.has(neighborKey)) {
            openSet.add(neighborKey);
          }
        }
      }
    }

    // No path found
    return null;
  }

  /**
   * Create a canonical key for a segment (order-independent)
   */
  private segmentKey(row1: number, col1: number, row2: number, col2: number): string {
    const key1 = `${row1},${col1}`;
    const key2 = `${row2},${col2}`;
    return key1 < key2 ? `${key1}-${key2}` : `${key2}-${key1}`;
  }

  /**
   * Build track from current network to a target point
   * Returns the segments to add and their total cost
   */
  async buildTrackToTarget(
    gameId: string,
    playerId: string,
    targetRow: number,
    targetCol: number,
    budget: number = TRACK_BUILD_BUDGET_PER_TURN
  ): Promise<{ segments: TrackSegment[]; cost: number } | null> {
    // Get current player's track
    const playerTrack = await TrackService.getTrackState(gameId, playerId);
    const existingSegments = playerTrack?.segments || [];

    // Get all other players' tracks
    const allTracks = await TrackService.getAllTracks(gameId);
    const otherPlayersTracks: TrackSegment[] = [];
    for (const track of allTracks) {
      if (track.playerId !== playerId) {
        otherPlayersTracks.push(...track.segments);
      }
    }

    // Find a starting point - endpoint of existing track or major city
    let startPoint = this.findBestStartingPoint(existingSegments, targetRow, targetCol);

    if (!startPoint) {
      console.log(`AITrackBuilder: No valid starting point found`);
      return null;
    }

    // Find path
    const result = this.findPath(
      startPoint.row,
      startPoint.col,
      targetRow,
      targetCol,
      existingSegments,
      otherPlayersTracks
    );

    if (!result) {
      console.log(`AITrackBuilder: No path found from (${startPoint.row},${startPoint.col}) to (${targetRow},${targetCol})`);
      return null;
    }

    // Check budget
    if (result.cost > budget) {
      console.log(`AITrackBuilder: Path cost ${result.cost} exceeds budget ${budget}`);
      // Return partial path within budget
      return this.getPartialPath(result.path, budget, existingSegments);
    }

    // Convert path to segments
    const segments = this.pathToSegments(result.path, existingSegments);

    return { segments, cost: result.cost };
  }

  /**
   * Find the best starting point for building towards a target
   */
  private findBestStartingPoint(
    existingSegments: TrackSegment[],
    targetRow: number,
    targetCol: number
  ): { row: number; col: number } | null {
    if (existingSegments.length === 0) {
      // No existing track - need to start from a major city
      const majorCities = getMajorCityGroups();
      let bestCity: { row: number; col: number } | null = null;
      let bestDistance = Infinity;

      for (const city of majorCities) {
        const dist = Math.abs(city.center.row - targetRow) + Math.abs(city.center.col - targetCol);
        if (dist < bestDistance) {
          bestDistance = dist;
          bestCity = { row: city.center.row, col: city.center.col };
        }
      }

      return bestCity;
    }

    // Find the endpoint closest to target
    const endpoints = new Set<string>();
    const endpointCounts = new Map<string, number>();

    for (const segment of existingSegments) {
      const fromKey = `${segment.from.row},${segment.from.col}`;
      const toKey = `${segment.to.row},${segment.to.col}`;
      endpointCounts.set(fromKey, (endpointCounts.get(fromKey) || 0) + 1);
      endpointCounts.set(toKey, (endpointCounts.get(toKey) || 0) + 1);
    }

    // Endpoints are nodes with only one connection
    for (const [key, count] of endpointCounts) {
      if (count === 1) {
        endpoints.add(key);
      }
    }

    // Also include all nodes for flexibility
    let bestPoint: { row: number; col: number } | null = null;
    let bestDistance = Infinity;

    for (const key of endpointCounts.keys()) {
      const [row, col] = key.split(',').map(Number);
      const dist = Math.abs(row - targetRow) + Math.abs(col - targetCol);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestPoint = { row, col };
      }
    }

    return bestPoint;
  }

  /**
   * Get a partial path that fits within budget
   */
  private getPartialPath(
    path: Milepost[],
    budget: number,
    existingSegments: TrackSegment[]
  ): { segments: TrackSegment[]; cost: number } {
    const existingCoords = new Set<string>();
    for (const seg of existingSegments) {
      existingCoords.add(`${seg.from.row},${seg.from.col}`);
      existingCoords.add(`${seg.to.row},${seg.to.col}`);
    }

    const segments: TrackSegment[] = [];
    let cost = 0;

    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i];
      const to = path[i + 1];

      // Check if this segment already exists
      const fromKey = `${from.row},${from.col}`;
      const toKey = `${to.row},${to.col}`;

      if (existingCoords.has(fromKey) && existingCoords.has(toKey)) {
        // Already have this segment
        continue;
      }

      const segmentCost = this.calculateSegmentCost(from, to);
      if (cost + segmentCost > budget) {
        break;  // Would exceed budget
      }

      segments.push({
        from: {
          x: from.x,
          y: from.y,
          row: from.row,
          col: from.col,
          terrain: from.terrain,
        },
        to: {
          x: to.x,
          y: to.y,
          row: to.row,
          col: to.col,
          terrain: to.terrain,
        },
        cost: segmentCost,
      });

      cost += segmentCost;
      existingCoords.add(toKey);  // Track as now owned
    }

    return { segments, cost };
  }

  /**
   * Convert a path of mileposts to track segments
   */
  private pathToSegments(path: Milepost[], existingSegments: TrackSegment[]): TrackSegment[] {
    const existingCoords = new Set<string>();
    for (const seg of existingSegments) {
      existingCoords.add(`${seg.from.row},${seg.from.col}`);
      existingCoords.add(`${seg.to.row},${seg.to.col}`);
    }

    const segments: TrackSegment[] = [];

    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i];
      const to = path[i + 1];

      // Skip if already owned
      const fromKey = `${from.row},${from.col}`;
      const toKey = `${to.row},${to.col}`;
      if (existingCoords.has(fromKey) && existingCoords.has(toKey)) {
        continue;
      }

      segments.push({
        from: {
          x: from.x,
          y: from.y,
          row: from.row,
          col: from.col,
          terrain: from.terrain,
        },
        to: {
          x: to.x,
          y: to.y,
          row: to.row,
          col: to.col,
          terrain: to.terrain,
        },
        cost: this.calculateSegmentCost(from, to),
      });
    }

    return segments;
  }

  /**
   * Get milepost at specific coordinates
   */
  getMilepost(row: number, col: number): Milepost | undefined {
    return this.gridByCoord.get(`${row},${col}`);
  }
}

// Singleton instance
let trackBuilderInstance: AITrackBuilder | null = null;

export function getAITrackBuilder(): AITrackBuilder {
  if (!trackBuilderInstance) {
    trackBuilderInstance = new AITrackBuilder();
  }
  return trackBuilderInstance;
}
