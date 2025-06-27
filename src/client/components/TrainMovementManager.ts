import "phaser";
import {
  GameState,
  GridPoint,
  Point,
  TerrainType,
  TrackSegment,
  PlayerTrackState,
} from "../../shared/types/GameTypes";

export class TrainMovementManager {
  private gameState: GameState;
  private playerTracks: Map<string, PlayerTrackState> = new Map();

  constructor(gameState: GameState) {
    this.gameState = gameState;
  }

  public async loadTrackData(): Promise<void> {
    try {
      const response = await fetch(`/api/tracks/${this.gameState.id}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error("[TrainMovementManager] Track data fetch failed:", errorText);
        throw new Error(errorText);
      }

      const tracks: PlayerTrackState[] = await response.json();
      console.debug("[TrainMovementManager] Loaded track data:", tracks);
      // Initialize playerTracks Map with loaded data
      tracks.forEach(trackState => {
        this.playerTracks.set(trackState.playerId, trackState);
      });
    } catch (error) {
      console.error("[TrainMovementManager] Failed to load track data:", error);
      // Continue without track data - will fall back to direct distance
    }
  }

  public updateTrackData(playerTracks: Map<string, PlayerTrackState>): void {
    this.playerTracks = playerTracks;
  }

  private calculateMoveVector(
    fromPoint: Point,
    toPoint: Point
  ): { rowDiff: number; colDiff: number } {
    return {
      rowDiff: toPoint.row - fromPoint.row,
      colDiff: toPoint.col - fromPoint.col,
    };
  }

  private getForwardDirection(
    currentPoint: Point,
    lastVisitedPoint: Point | null,
    connectedPoints: Point[]
  ): Point | null {
    // If we have a previous point, exclude it from forward options
    const forwardOptions = lastVisitedPoint
      ? connectedPoints.filter((p) => p !== lastVisitedPoint)
      : connectedPoints;

    // If there's only one way to go (or no previous point), that's forward
    if (forwardOptions.length === 1) {
      return forwardOptions[0];
    }

    // At junctions with multiple options, player must choose
    return null;
  }

  private canReverseDirection(
    lastSegment: TrackSegment,
    proposedDirection: { rowDiff: number; colDiff: number },
    lastDirection: { rowDiff: number; colDiff: number }
  ): boolean {
    // Direction is reversed if the dot product is negative
    const isReversing =
      proposedDirection.rowDiff * lastDirection.rowDiff +
        proposedDirection.colDiff * lastDirection.colDiff <
      0;

    // If trying to reverse, check if we're currently at a city or ferry port
    // lastSegment.to is our current position
    if (isReversing) {
      const currentTerrain = lastSegment.to.terrain;
      const canReverse = this.isTerrainCityOrFerry(currentTerrain);
      if (!canReverse) {
        // console.log("Cannot reverse direction - not at a city or ferry port. Current terrain:", currentTerrain);
      }
      return canReverse;
    }

    return true;
  }

  private isTerrainCityOrFerry(terrain: TerrainType): boolean {
    return [
      TerrainType.MajorCity,
      TerrainType.MediumCity,
      TerrainType.SmallCity,
      TerrainType.FerryPort,
    ].includes(terrain);
  }

  private getLastDirection(movementHistory: TrackSegment[]): {
    rowDiff: number;
    colDiff: number;
  } {
    if (movementHistory.length < 1) return { rowDiff: 0, colDiff: 0 };

    const last = movementHistory[movementHistory.length - 1];
    return {
      rowDiff: last.to.row - last.from.row,
      colDiff: last.to.col - last.from.col,
    };
  }

  private calculateDistance(from: Point, to: Point): number {
    // Calculate direct "crow flies" distance once
    const dx = Math.abs(to.col - from.col);
    const dy = Math.abs(to.row - from.row);
    const directDistance = Math.max(dx, dy);

    // Graceful fallback if no game state or players available
    if (!this.gameState.players || this.gameState.players.length === 0 || 
        this.gameState.currentPlayerIndex >= this.gameState.players.length) {
      console.warn("[TrainMovementManager] No players or invalid player index, using direct distance:", directDistance);
      return directDistance;
    }

    // Get current player's track data
    const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
    if (!currentPlayer || !currentPlayer.id) {
      console.warn("[TrainMovementManager] No current player or player id, using direct distance:", directDistance);
      return directDistance;
    }

    const playerTrackState = this.playerTracks.get(currentPlayer.id);
    
    // If no track data available, fall back to direct distance
    if (!playerTrackState || playerTrackState.segments.length === 0) {
      console.warn("[TrainMovementManager] No track data for player", currentPlayer.id, "using direct distance:", directDistance);
      return directDistance;
    }
    
    // Use path-finding to calculate actual track distance
    const pathDistance = this.findShortestPathDistance(from, to, playerTrackState);
    console.debug("[TrainMovementManager] Path distance:", pathDistance);
    // If no path found, fall back to direct distance
    if (pathDistance === -1) {
      console.warn("[TrainMovementManager] No path found between", from, to, "using direct distance:", directDistance);
      return directDistance;
    }
    
    console.debug("[TrainMovementManager] Path distance found:", pathDistance, "from", from, "to", to);
    return pathDistance;
  }

  private findShortestPathDistance(from: Point, to: Point, playerTrackState: PlayerTrackState): number {
    // If starting and ending points are the same, distance is 0
    if (from.row === to.row && from.col === to.col) {
      console.debug("[TrainMovementManager] Start and end points are the same, distance 0");
      return 0;
    }

    // Build a graph from the player's track segments
    const graph = new Map<string, Set<string>>();
    const getPointKey = (p: Point) => `${p.row},${p.col}`;

    // Add all track segments to the graph
    for (const segment of playerTrackState.segments) {
      const fromKey = getPointKey(segment.from);
      const toKey = getPointKey(segment.to);
      
      // Add bidirectional connections
      if (!graph.has(fromKey)) graph.set(fromKey, new Set());
      if (!graph.has(toKey)) graph.set(toKey, new Set());
      
      graph.get(fromKey)!.add(toKey);
      graph.get(toKey)!.add(fromKey);
    }

    console.debug("[TrainMovementManager] Track graph:", Array.from(graph.entries()));

    const fromKey = getPointKey(from);
    const toKey = getPointKey(to);

    // If either point is not in the track network, no path exists
    if (!graph.has(fromKey) || !graph.has(toKey)) {
      console.warn("[TrainMovementManager] Either start or end point not in track graph:", fromKey, toKey);
      return -1;
    }

    // Use BFS to find shortest path
    const queue: Array<{key: string, distance: number, path: string[]}> = [{key: fromKey, distance: 0, path: [fromKey]}];
    const visited = new Set<string>();
    visited.add(fromKey);

    while (queue.length > 0) {
      const current = queue.shift()!;
      // Log each BFS step
      console.debug("[TrainMovementManager] BFS visiting:", current.key, "distance:", current.distance, "path:", current.path);
      
      // If we reached the destination, return the distance
      if (current.key === toKey) {
        console.debug("[TrainMovementManager] BFS found path:", current.path, "distance:", current.distance);
        return current.distance;
      }

      // Explore neighbors
      const neighbors = graph.get(current.key) || new Set();
      for (const neighborKey of neighbors) {
        if (!visited.has(neighborKey)) {
          visited.add(neighborKey);
          queue.push({
            key: neighborKey,
            distance: current.distance + 1,
            path: [...current.path, neighborKey]
          });
        }
      }
    }

    // No path found
    console.warn("[TrainMovementManager] BFS could not find a path from", fromKey, "to", toKey);
    return -1;
  }

  private hasEnoughMovement(currentPlayer: any, proposedPoint: Point): boolean {
    if (!currentPlayer.trainState.position) return true; // First move is always allowed
    
    const distance = this.calculateDistance(
      currentPlayer.trainState.position,
      proposedPoint
    );
    
    let maxMovement = currentPlayer.trainState.remainingMovement;
    // console.log("Checking movement - Distance:", distance, "Max Movement:", maxMovement);

    // Remove ferry port halving here; already handled at turn start
    
    return distance <= maxMovement;
  }

  private deductMovement(currentPlayer: any, distance: number): void {
    currentPlayer.trainState.remainingMovement -= distance;
    // console.log("Deducted movement points:", distance, "Remaining:", currentPlayer.trainState.remainingMovement);
  }

  canMoveTo(point: GridPoint): { canMove: boolean; endMovement: boolean; message?: string } {
    // Get current player
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    if (!currentPlayer || !currentPlayer.trainState) {
      // console.log("Current player or train state is undefined");
      return { canMove: false, endMovement: false, message: "Current player or train state is undefined" };
    }

    // Initialize movement history if needed
    if (!currentPlayer.trainState.movementHistory) {
      currentPlayer.trainState.movementHistory = [];
    }

    // Check ferry state - if just arrived at ferry, no movement allowed
    if (currentPlayer.trainState.ferryState?.status === 'just_arrived') {
      // console.log("Cannot move - just arrived at ferry this turn");
      return { canMove: false, endMovement: false, message: "Cannot move - just arrived at ferry this turn" };
    }

    // If this is the first move, only check if it's a valid starting point
    if (!currentPlayer.trainState.position) {
      const isStartingCity = point.terrain == TerrainType.MajorCity;
      if (!isStartingCity) {
        // console.log(
        //   "Invalid starting point - must start first move from a major city"
        // );
      }
      return { canMove: isStartingCity, endMovement: false, message: "Invalid starting point - must start first move from a major city" };
    }

    // Convert current position to GridPoint
    const priorPosition = currentPlayer.trainState.position;

    // Calculate proposed direction
    const proposedDirection = this.calculateMoveVector(priorPosition, point);

    // Get last direction from movement history
    const lastDirection = this.getLastDirection(
      currentPlayer.trainState.movementHistory
    );

    // Calculate distance for this move
    const distance = this.calculateDistance(
      currentPlayer.trainState.position,
      point
    );
    console.log("Can Move To CalculatedDistance:", distance);
    // Check movement points
    if (!this.hasEnoughMovement(currentPlayer, point)) {
      console.log("Not enough movement points remaining");
      return { canMove: false, endMovement: false, message: "Not enough movement points remaining" };
    }

    // Check if this is a valid track connection
    // TODO: Implement track connectivity check using MapRenderer or TrackManager
    const lastTrackSegment =
      currentPlayer.trainState.movementHistory.length > 0
        ? currentPlayer.trainState.movementHistory[
            currentPlayer.trainState.movementHistory.length - 1
          ]
        : null;
    // console.debug("lastTrackSegment", lastTrackSegment);

    // Check reversal rules
    if (
      lastTrackSegment &&
      !this.canReverseDirection(
        lastTrackSegment,
        proposedDirection,
        lastDirection
      )
    ) {
      // console.log(
      //   "Invalid direction change - can only reverse at cities or ferry ports"
      // );
      return { canMove: false, endMovement: false, message: "Invalid direction change - can only reverse at cities or ferry ports" };
    }

    // If we got here, the move is valid - deduct the movement points
    this.deductMovement(currentPlayer, distance);

    // If arriving at a ferry port, set up ferry state and end movement
    if (point.terrain === TerrainType.FerryPort) {
      currentPlayer.trainState.remainingMovement = 0;
      
      // Set ferry state if ferry connection exists
      if (point.ferryConnection) {
        const [from, to] = point.ferryConnection.connections;
        // Determine which end is the current point and which is the other side
        const isCurrentFrom = from.row === point.row && from.col === point.col;
        currentPlayer.trainState.ferryState = {
          status: 'just_arrived',
          ferryConnection: point.ferryConnection,
          currentSide: isCurrentFrom ? from : to,
          otherSide: isCurrentFrom ? to : from,
        };
      }
      return { canMove: true, endMovement: true, message: "Ferry port reached - ending movement" };
    }

    return { canMove: true, endMovement: false, message: "Move completed successfully" };
  }
}
