import {
  Point,
  TerrainType,
  PlayerTrackState,
  GridPoint,
} from "../../shared/types/GameTypes";
import { majorCityGroups } from "../config/mapConfig";

export interface MovementSegment {
  from: Point;
  to: Point;
  type: 'normal' | 'city_entry' | 'city_internal' | 'city_exit' | 'invalid';
  cost: number;
}

export interface MovementCostResult {
  totalCost: number;
  isValid: boolean;
  segments: MovementSegment[];
  errorMessage?: string;
}

export class MovementCostCalculator {
  private cityNodeMap: Map<string, string> = new Map(); // nodeKey -> cityName
  private cityPerimeterNodes: Map<string, Set<string>> = new Map(); // cityName -> Set of nodeKeys

  constructor() {
    this.initializeCityMappings();
  }

  /**
   * Initialize mappings from majorCityGroups to identify which nodes belong to which cities
   */
  private initializeCityMappings(): void {
    Object.entries(majorCityGroups).forEach(([cityName, group]) => {
      if (!group || group.length === 0) return;
      
      const perimeterNodeSet = new Set<string>();
      
      // The first item is the center, the rest are perimeter nodes
      group.slice(1, 7).forEach(outpost => {
        if (typeof outpost.GridX === 'number' && typeof outpost.GridY === 'number') {
          const nodeKey = this.getNodeKey({ row: outpost.GridY, col: outpost.GridX, x: 0, y: 0 });
          this.cityNodeMap.set(nodeKey, cityName);
          perimeterNodeSet.add(nodeKey);
        }
      });
      
      this.cityPerimeterNodes.set(cityName, perimeterNodeSet);
    });
  }

  /**
   * Get a unique key for a node position
   */
  private getNodeKey(point: Point): string {
    return `${point.row},${point.col}`;
  }

  /**
   * Check if a node is within a major city (perimeter node)
   */
  public isNodeInMajorCity(point: Point): boolean {
    const nodeKey = this.getNodeKey(point);
    return this.cityNodeMap.has(nodeKey);
  }

  /**
   * Get the city name for a node, if it belongs to a major city
   */
  public getCityForNode(point: Point): string | null {
    const nodeKey = this.getNodeKey(point);
    return this.cityNodeMap.get(nodeKey) || null;
  }

  /**
   * Check if two nodes are in the same major city
   */
  public areNodesInSameCity(point1: Point, point2: Point): boolean {
    const city1 = this.getCityForNode(point1);
    const city2 = this.getCityForNode(point2);
    return city1 !== null && city2 !== null && city1 === city2;
  }

  /**
   * Calculate movement cost from one point to another using player's track
   */
  public calculateMovementCost(
    from: Point,
    to: Point,
    playerTrackState: PlayerTrackState | null,
    allPoints: GridPoint[]
  ): MovementCostResult {
    // Handle same position
    if (from.row === to.row && from.col === to.col) {
      return {
        totalCost: 0,
        isValid: true,
        segments: []
      };
    }

    // Special case: Starting from a major city center (train placement)
    // Allow movement from any major city center to connected perimeter nodes at no cost
    const fromPoint = allPoints.find(p => p.row === from.row && p.col === from.col);
    if (fromPoint?.terrain === TerrainType.MajorCity && fromPoint.city?.connectedPoints) {
      const isToConnectedPerimeter = fromPoint.city.connectedPoints.some(
        cp => cp.row === to.row && cp.col === to.col
      );
      if (isToConnectedPerimeter) {
        return {
          totalCost: 0,
          isValid: true,
          segments: [{
            from,
            to,
            type: 'city_internal',
            cost: 0
          }]
        };
      }
    }

    // If no track data, only allow movement if it's from/to a major city
    if (!playerTrackState || playerTrackState.segments.length === 0) {
      // Check if this is a valid major city movement case
      const fromPoint = allPoints.find(p => p.row === from.row && p.col === from.col);
      const toPoint = allPoints.find(p => p.row === to.row && p.col === to.col);
      
      // Allow direct movement only if starting from major city center or between connected city nodes
      if (fromPoint?.terrain === TerrainType.MajorCity && fromPoint.city?.connectedPoints) {
        const isToConnectedPerimeter = fromPoint.city.connectedPoints.some(
          cp => cp.row === to.row && cp.col === to.col
        );
        if (isToConnectedPerimeter) {
          const directDistance = this.calculateDirectDistance(from, to);
          return {
            totalCost: directDistance,
            isValid: true,
            segments: [{
              from,
              to,
              type: 'city_internal',
              cost: directDistance
            }]
          };
        }
      }
      
      return {
        totalCost: -1,
        isValid: false,
        segments: [],
        errorMessage: "No track data available and not a valid major city movement"
      };
    }

    // Find path using track network
    const path = this.findPath(from, to, playerTrackState);
    if (!path || path.length === 0) {
      return {
        totalCost: -1,
        isValid: false,
        segments: [],
        errorMessage: "No valid path found"
      };
    }

    // Check if we're starting from an unconnected perimeter node within a city
    // This is true when we have a direct path (length 2) within same city that was created
    // by the special handling in findPath method (starting from unconnected node)
    const graph = new Map<string, Set<string>>();
    if (playerTrackState) {
      for (const segment of playerTrackState.segments) {
        const fromKey = this.getNodeKey(segment.from);
        const toKey = this.getNodeKey(segment.to);
        
        if (!graph.has(fromKey)) graph.set(fromKey, new Set());
        if (!graph.has(toKey)) graph.set(toKey, new Set());
        
        graph.get(fromKey)!.add(toKey);
        graph.get(toKey)!.add(fromKey);
      }
    }
    
    const startingNodeKey = this.getNodeKey(path[0]);
    const startingFromUnconnectedCityNode = path.length === 2 && 
      this.isNodeInMajorCity(path[0]) && 
      this.isNodeInMajorCity(path[1]) && 
      this.areNodesInSameCity(path[0], path[1]) &&
      !graph.has(startingNodeKey); // Key difference: starting node not in track graph

    // Analyze path segments and calculate costs
    const segments = this.analyzePathSegments(path, startingFromUnconnectedCityNode);
    const totalCost = segments.reduce((sum, segment) => sum + segment.cost, 0);

    return {
      totalCost,
      isValid: true,
      segments
    };
  }

  /**
   * Calculate direct "crow flies" distance
   */
  private calculateDirectDistance(from: Point, to: Point): number {
    const dx = Math.abs(to.col - from.col);
    const dy = Math.abs(to.row - from.row);
    return Math.max(dx, dy);
  }

  /**
   * Find shortest path using BFS on player's track network
   */
  private findPath(from: Point, to: Point, playerTrackState: PlayerTrackState): Point[] | null {
    // Build graph from track segments
    const graph = new Map<string, Set<string>>();
    
    for (const segment of playerTrackState.segments) {
      const fromKey = this.getNodeKey(segment.from);
      const toKey = this.getNodeKey(segment.to);
      
      if (!graph.has(fromKey)) graph.set(fromKey, new Set());
      if (!graph.has(toKey)) graph.set(toKey, new Set());
      
      graph.get(fromKey)!.add(toKey);
      graph.get(toKey)!.add(fromKey);
    }

    const fromKey = this.getNodeKey(from);
    const toKey = this.getNodeKey(to);

    // Special handling for starting from major city - allow starting from any city
    // if the target is reachable from any perimeter node of the same city
    if (!graph.has(fromKey)) {
      const fromCity = this.getCityForNode(from);
      if (fromCity) {
        // Check if destination is also in the same city (internal city movement)
        const toCity = this.getCityForNode(to);
        if (toCity === fromCity) {
          // Internal city movement - return direct path
          return [from, to];
        }
        
        const perimeterNodes = this.cityPerimeterNodes.get(fromCity);
        if (perimeterNodes) {
          // Try to find path from any perimeter node
          for (const perimeterKey of perimeterNodes) {
            if (graph.has(perimeterKey)) {
              const pathFromPerimeter = this.bfsPath(perimeterKey, toKey, graph);
              if (pathFromPerimeter) {
                // Insert the original starting point at the beginning
                const [perimeterRow, perimeterCol] = perimeterKey.split(',').map(Number);
                return [from, { row: perimeterRow, col: perimeterCol, x: 0, y: 0 }, ...pathFromPerimeter.slice(1)];
              }
            }
          }
        }
      }
      return null;
    }

    if (!graph.has(toKey)) {
      return null;
    }

    return this.bfsPath(fromKey, toKey, graph);
  }

  /**
   * BFS pathfinding implementation
   */
  private bfsPath(fromKey: string, toKey: string, graph: Map<string, Set<string>>): Point[] | null {
    const queue: Array<{key: string, path: string[]}> = [{key: fromKey, path: [fromKey]}];
    const visited = new Set<string>();
    visited.add(fromKey);

    while (queue.length > 0) {
      const current = queue.shift()!;
      
      if (current.key === toKey) {
        // Convert path back to Points
        return current.path.map(key => {
          const [row, col] = key.split(',').map(Number);
          return { row, col, x: 0, y: 0 };
        });
      }

      const neighbors = graph.get(current.key) || new Set();
      for (const neighborKey of neighbors) {
        if (!visited.has(neighborKey)) {
          visited.add(neighborKey);
          queue.push({
            key: neighborKey,
            path: [...current.path, neighborKey]
          });
        }
      }
    }

    return null;
  }

  /**
   * Analyze path segments and apply city movement rules
   */
  private analyzePathSegments(path: Point[], startingFromUnconnectedCityNode: boolean = false): MovementSegment[] {
    if (path.length < 2) return [];

    const segments: MovementSegment[] = [];

    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i];
      const to = path[i + 1];
      
      const fromInCity = this.isNodeInMajorCity(from);
      const toInCity = this.isNodeInMajorCity(to);
      const sameCity = this.areNodesInSameCity(from, to);

      let segmentType: MovementSegment['type'];
      let cost: number;

      if (!fromInCity && !toInCity) {
        // Normal external movement
        segmentType = 'normal';
        cost = 1;
      } else if (!fromInCity && toInCity) {
        // Entry into city
        segmentType = 'city_entry';
        cost = 1;
      } else if (fromInCity && !toInCity) {
        // Exit from city
        segmentType = 'city_exit';
        cost = 1;
      } else if (fromInCity && toInCity && sameCity) {
        // Internal city movement - special handling for starting from unconnected node
        segmentType = 'city_internal';
        
        // If this is the first segment and we're starting from unconnected city node
        if (i === 0 && startingFromUnconnectedCityNode) {
          cost = 0; // Free movement within city when starting from unconnected perimeter
        } else {
          cost = 1; // Normal city internal movement cost
        }
      } else {
        // Between different cities (shouldn't happen in normal gameplay)
        segmentType = 'normal';
        cost = 1;
      }

      segments.push({
        from,
        to,
        type: segmentType,
        cost
      });
    }

    return segments;
  }
}