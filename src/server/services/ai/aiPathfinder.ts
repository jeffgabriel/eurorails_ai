/**
 * AI Pathfinder Service
 * Route calculation and track building evaluation for AI players
 */

import { Point, TrackSegment, Player } from '../../../shared/types/GameTypes';
import { DemandCard } from '../../../shared/types/DemandCard';
import { Route, BuildOption, AIGameState } from './types';

export class AIPathfinder {
  /**
   * Find the best route from one point to another
   * Considers player's existing track and potential to use others' track
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

    // TODO: Implement A* pathfinding in BE-002
    // For now, return a simple direct route if connected

    const directSegment = this.findDirectConnection(from, to, playerTrack);
    if (directSegment) {
      return {
        from,
        to,
        segments: [directSegment],
        totalCost: 0, // No cost to use own track
        distance: this.calculateDistance(from, to),
      };
    }

    // No direct route found
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

    // Get endpoints of player's network
    const endpoints = this.findNetworkEndpoints(playerTrack);

    // TODO: Implement in BE-002
    // - Find potential build targets (cities, connections)
    // - Calculate cost for each option
    // - Assess strategic value (major city connections, chokepoints)

    return options;
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
   */
  calculateBuildCost(from: Point, to: Point, terrain: string): number {
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

    // TODO: Add water crossing costs in BE-002
    // River: +2
    // Lake: +3
    // Ocean inlet: +3

    return baseCost;
  }

  /**
   * Check if building track between two points is valid
   */
  isValidBuild(from: Point, to: Point, existingTrack: TrackSegment[]): boolean {
    // Check if track already exists
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

    // TODO: Add more validation in BE-002
    // - Check city entry limits
    // - Check for blocked paths
    // - Verify connection to player's network

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
