/**
 * AI Pathfinder Service
 * Route calculation and track building evaluation for AI players
 */

import { Point, TrackSegment, Player, TerrainType } from '../../../shared/types/GameTypes';
import { DemandCard } from '../../../shared/types/DemandCard';
import { Route, BuildOption, AIGameState } from './types';
import { getMajorCityGroups } from '../../../shared/services/majorCityGroups';

/** Build budget per turn (ECU millions) */
const BUILD_BUDGET_PER_TURN = 20;

export class AIPathfinder {
  /**
   * Find the best route from one point to another using A* pathfinding
   * Considers player's existing track network
   * @param from Starting point
   * @param to Destination point
   * @param playerTrack Player's existing track network
   * @returns The optimal route or null if no route exists
   */
  findBestRoute(
    from: Point,
    to: Point,
    playerTrack: TrackSegment[]
  ): Route | null {
    // Check for same point
    if (from.x === to.x && from.y === to.y) {
      return {
        from,
        to,
        segments: [],
        totalCost: 0,
        distance: 0,
      };
    }

    // Build adjacency graph from track segments
    const graph = new Map<string, Map<string, TrackSegment>>();
    const pointMap = new Map<string, Point>();

    const getKey = (p: Point | { x: number; y: number }) => `${p.x},${p.y}`;

    for (const segment of playerTrack) {
      const fromKey = getKey(segment.from);
      const toKey = getKey(segment.to);

      // Store points for later
      pointMap.set(fromKey, segment.from);
      pointMap.set(toKey, segment.to);

      // Add edges (bidirectional)
      if (!graph.has(fromKey)) graph.set(fromKey, new Map());
      if (!graph.has(toKey)) graph.set(toKey, new Map());

      graph.get(fromKey)!.set(toKey, segment);
      graph.get(toKey)!.set(fromKey, segment);
    }

    const startKey = getKey(from);
    const endKey = getKey(to);

    // If start or end not in graph, check for direct connection only
    if (!graph.has(startKey) || !graph.has(endKey)) {
      const directSegment = this.findDirectConnection(from, to, playerTrack);
      if (directSegment) {
        return {
          from,
          to,
          segments: [directSegment],
          totalCost: 0,
          distance: this.calculateDistance(from, to),
        };
      }
      return null;
    }

    // A* pathfinding
    const openSet = new Set<string>([startKey]);
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>([[startKey, 0]]);
    const fScore = new Map<string, number>([[startKey, this.calculateDistance(from, to)]]);

    while (openSet.size > 0) {
      // Find node in openSet with lowest fScore
      let current = '';
      let lowestF = Infinity;
      for (const node of openSet) {
        const f = fScore.get(node) ?? Infinity;
        if (f < lowestF) {
          lowestF = f;
          current = node;
        }
      }

      if (current === endKey) {
        // Reconstruct path
        const segments: TrackSegment[] = [];
        let pathNode = current;
        while (cameFrom.has(pathNode)) {
          const prevNode = cameFrom.get(pathNode)!;
          const segment = graph.get(prevNode)?.get(pathNode);
          if (segment) {
            segments.unshift(segment);
          }
          pathNode = prevNode;
        }

        return {
          from,
          to,
          segments,
          totalCost: 0, // Own track has no cost
          distance: gScore.get(endKey) || this.calculateDistance(from, to),
        };
      }

      openSet.delete(current);
      const neighbors = graph.get(current);
      if (!neighbors) continue;

      for (const [neighborKey, _segment] of neighbors) {
        const currentPoint = pointMap.get(current);
        const neighborPoint = pointMap.get(neighborKey);
        if (!currentPoint || !neighborPoint) continue;

        const tentativeG = (gScore.get(current) ?? Infinity) +
          this.calculateDistance(currentPoint, neighborPoint);

        if (tentativeG < (gScore.get(neighborKey) ?? Infinity)) {
          cameFrom.set(neighborKey, current);
          gScore.set(neighborKey, tentativeG);

          const toPoint = pointMap.get(endKey) || to;
          fScore.set(neighborKey, tentativeG + this.calculateDistance(neighborPoint, toPoint));

          openSet.add(neighborKey);
        }
      }
    }

    // No path found
    return null;
  }

  /**
   * Evaluate potential track building options
   * @param player The AI player
   * @param gameState Current game state
   * @returns List of build options with strategic values
   */
  evaluateTrackBuildOptions(
    player: Player,
    gameState: AIGameState
  ): BuildOption[] {
    const options: BuildOption[] = [];

    // Get player's current track
    const playerTrack = gameState.allTrack.get(player.id) || [];

    // Get endpoints of player's network (places we can expand from)
    const endpoints = this.findNetworkEndpoints(playerTrack);

    // If no track yet, suggest starting from major cities
    if (playerTrack.length === 0 || endpoints.length === 0) {
      // Recommend building from major cities toward demand card destinations
      const majorCityGroups = getMajorCityGroups();

      for (const cityGroup of majorCityGroups.slice(0, 3)) {
        options.push({
          targetPoint: {
            x: 0,
            y: 0,
            row: cityGroup.center.row,
            col: cityGroup.center.col,
          },
          segments: [],
          cost: 5, // Major city entry cost
          strategicValue: 10, // High value for starting point
          connectsMajorCity: true,
        });
      }

      return options;
    }

    // Get all major city groups for strategic targeting
    const majorCityGroups = getMajorCityGroups();

    // Count current connected major cities
    const connectedCityNames = this.getConnectedMajorCityNames(playerTrack, majorCityGroups);

    // From each endpoint, consider building toward unconnected major cities
    for (const endpoint of endpoints) {
      for (const cityGroup of majorCityGroups) {
        // Skip already connected cities
        if (connectedCityNames.has(cityGroup.cityName)) {
          continue;
        }

        // Calculate rough distance to this city
        const distToCity = Math.abs(endpoint.row - cityGroup.center.row) +
                          Math.abs(endpoint.col - cityGroup.center.col);

        // Estimate build cost (rough: 1 ECU per grid unit for clear terrain)
        const estimatedCost = Math.min(BUILD_BUDGET_PER_TURN, distToCity);

        // Skip if too expensive for one turn
        if (estimatedCost > BUILD_BUDGET_PER_TURN) {
          continue;
        }

        // Strategic value: higher for closer cities, lower if far away
        const baseStrategicValue = Math.max(1, 15 - distToCity * 0.5);

        options.push({
          targetPoint: {
            x: 0,
            y: 0,
            row: cityGroup.center.row,
            col: cityGroup.center.col,
          },
          segments: [], // Would need map data to fill actual segments
          cost: estimatedCost,
          strategicValue: baseStrategicValue,
          connectsMajorCity: true,
        });
      }
    }

    // Sort by strategic value descending
    options.sort((a, b) => b.strategicValue - a.strategicValue);

    // Return top options (limit to avoid excessive computation)
    return options.slice(0, 10);
  }

  /**
   * Get names of major cities connected to the player's track network
   */
  private getConnectedMajorCityNames(
    track: TrackSegment[],
    majorCityGroups: ReturnType<typeof getMajorCityGroups>
  ): Set<string> {
    const connected = new Set<string>();

    // Build set of all track coordinates
    const trackCoords = new Set<string>();
    for (const segment of track) {
      trackCoords.add(`${segment.from.row},${segment.from.col}`);
      trackCoords.add(`${segment.to.row},${segment.to.col}`);
    }

    // Check which major cities have track
    for (const cityGroup of majorCityGroups) {
      const allCityCoords = [
        `${cityGroup.center.row},${cityGroup.center.col}`,
        ...cityGroup.outposts.map(o => `${o.row},${o.col}`)
      ];

      if (allCityCoords.some(coord => trackCoords.has(coord))) {
        connected.add(cityGroup.cityName);
      }
    }

    return connected;
  }

  /**
   * Calculate the ROI (Return on Investment) for a route
   * @param route The route to evaluate
   * @param delivery The demand card being fulfilled
   * @returns ROI as a ratio (value/cost)
   */
  calculateRouteROI(route: Route, delivery: DemandCard): number {
    // Get payout from first demand on the card
    const payout = delivery.demands[0]?.payment || 0;

    if (!route || route.totalCost === 0) {
      // If no cost (using own track), return payout as ROI
      return payout;
    }

    // ROI = (Payout - Cost) / Cost
    const netValue = payout - route.totalCost;
    return netValue / route.totalCost;
  }

  /**
   * Calculate straight-line distance between two points
   */
  calculateDistance(from: Point, to: Point): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Find a direct connection between two points in existing track
   */
  private findDirectConnection(
    from: Point,
    to: Point,
    track: TrackSegment[]
  ): TrackSegment | null {
    return track.find(segment => {
      const matchesForward =
        segment.from.x === from.x && segment.from.y === from.y &&
        segment.to.x === to.x && segment.to.y === to.y;
      const matchesReverse =
        segment.from.x === to.x && segment.from.y === to.y &&
        segment.to.x === from.x && segment.to.y === from.y;
      return matchesForward || matchesReverse;
    }) || null;
  }

  /**
   * Find all endpoints (nodes with only one connection) in the network
   */
  private findNetworkEndpoints(track: TrackSegment[]): Point[] {
    const connectionCount = new Map<string, number>();
    const pointMap = new Map<string, Point>();

    for (const segment of track) {
      const fromKey = `${segment.from.x},${segment.from.y}`;
      const toKey = `${segment.to.x},${segment.to.y}`;

      connectionCount.set(fromKey, (connectionCount.get(fromKey) || 0) + 1);
      connectionCount.set(toKey, (connectionCount.get(toKey) || 0) + 1);

      pointMap.set(fromKey, segment.from);
      pointMap.set(toKey, segment.to);
    }

    const endpoints: Point[] = [];
    for (const [key, count] of connectionCount) {
      if (count === 1) {
        const point = pointMap.get(key);
        if (point) {
          endpoints.push(point);
        }
      }
    }

    return endpoints;
  }

  /**
   * Calculate track building cost between two points
   * Considers terrain type and water crossings
   * @param from Starting point
   * @param to Destination point (terrain determines cost)
   * @param terrain Terrain type of destination point
   * @param waterCrossing Optional water crossing type ('river' | 'lake' | 'ocean_inlet')
   */
  calculateBuildCost(
    from: Point,
    to: Point,
    terrain: string,
    waterCrossing?: 'river' | 'lake' | 'ocean_inlet'
  ): number {
    // Base costs from game rules
    const terrainCosts: Record<string, number> = {
      clear: 1,
      mountain: 2,
      alpine: 5,
      small_city: 3,
      medium_city: 3,
      major_city: 5,
    };

    const baseCost = terrainCosts[terrain] || 1;

    // Water crossing costs (added to terrain cost)
    let waterCost = 0;
    if (waterCrossing) {
      const waterCosts: Record<string, number> = {
        river: 2,
        lake: 3,
        ocean_inlet: 3,
      };
      waterCost = waterCosts[waterCrossing] || 0;
    }

    return baseCost + waterCost;
  }

  /**
   * Check if building track between two points is valid
   * @param from Starting point
   * @param to Destination point
   * @param existingTrack All existing track (from all players)
   * @param playerTrack Player's own track (to verify connection)
   * @param toTerrain Terrain type of destination (for city limit checking)
   */
  isValidBuild(
    from: Point,
    to: Point,
    existingTrack: TrackSegment[],
    playerTrack?: TrackSegment[],
    toTerrain?: TerrainType
  ): boolean {
    // Check if track already exists (between any two players)
    const exists = existingTrack.some(segment => {
      const matchesForward =
        segment.from.x === from.x && segment.from.y === from.y &&
        segment.to.x === to.x && segment.to.y === to.y;
      const matchesReverse =
        segment.from.x === to.x && segment.from.y === to.y &&
        segment.to.x === from.x && segment.to.y === from.y;
      return matchesForward || matchesReverse;
    });

    if (exists) {
      return false;
    }

    // Check city entry limits if terrain type provided
    if (toTerrain !== undefined) {
      const cityLimits: Record<number, number> = {
        [TerrainType.SmallCity]: 2,    // Only 2 players can build into small cities
        [TerrainType.MediumCity]: 3,   // Only 3 players can build into medium cities
        // Major cities have no limit (all players can enter)
      };

      const limit = cityLimits[toTerrain];
      if (limit !== undefined) {
        // Count how many different players have track entering this point
        const toKey = `${to.row},${to.col}`;
        const playersAtLocation = new Set<string>();

        // This is a simplified check - in production, track segments would
        // have player IDs to properly count
        const tracksToPoint = existingTrack.filter(segment =>
          `${segment.to.row},${segment.to.col}` === toKey ||
          `${segment.from.row},${segment.from.col}` === toKey
        );

        // If at limit, can't build (simplified check)
        if (tracksToPoint.length >= limit * 3) { // 3 segments per player max
          return false;
        }
      }
    }

    // Verify connection to player's network (if provided)
    if (playerTrack && playerTrack.length > 0) {
      const playerCoords = new Set<string>();
      for (const segment of playerTrack) {
        playerCoords.add(`${segment.from.row},${segment.from.col}`);
        playerCoords.add(`${segment.to.row},${segment.to.col}`);
      }

      const fromKey = `${from.row},${from.col}`;
      const toKey = `${to.row},${to.col}`;

      // Either 'from' or 'to' must connect to existing network
      // (unless starting from a major city)
      if (!playerCoords.has(fromKey) && !playerCoords.has(toKey)) {
        // Check if from/to is a major city (allowed starting points)
        const majorCityGroups = getMajorCityGroups();
        const isMajorCity = majorCityGroups.some(city => {
          const allCoords = [
            `${city.center.row},${city.center.col}`,
            ...city.outposts.map(o => `${o.row},${o.col}`)
          ];
          return allCoords.includes(fromKey) || allCoords.includes(toKey);
        });

        if (!isMajorCity) {
          return false; // Must connect to existing network or start from major city
        }
      }
    }

    return true;
  }
}

// Singleton instance
let instance: AIPathfinder | null = null;

export function getAIPathfinder(): AIPathfinder {
  if (!instance) {
    instance = new AIPathfinder();
  }
  return instance;
}
