import "phaser";
import {
  GameState,
  GridPoint,
  Point,
  TerrainType,
  TrackSegment,
  PlayerTrackState,
} from "../../shared/types/GameTypes";
import { MovementCostCalculator } from "./MovementCostCalculator";
import { mapConfig } from "../config/mapConfig";
import { config } from "../config/apiConfig";

export class TrainMovementManager {
  private gameState: GameState;
  private playerTracks: Map<string, PlayerTrackState> = new Map();
  private movementCalculator: MovementCostCalculator;

  constructor(gameState: GameState) {
    this.gameState = gameState;
    this.movementCalculator = new MovementCostCalculator();
  }

  /**
   * Look up a GridPoint by its row and column coordinates
   * This is used to get the actual terrain type at a position
   */
  private getGridPointAtPosition(row: number, col: number): GridPoint | null {
    return mapConfig.points.find(
      (point) => point.row === row && point.col === col
    ) || null;
  }

  public async loadTrackData(): Promise<void> {
    try {
      const response = await fetch(`${config.apiBaseUrl}/api/tracks/${this.gameState.id}`);
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
    currentPosition: Point,
    proposedDirection: { rowDiff: number; colDiff: number },
    lastDirection: { rowDiff: number; colDiff: number }
  ): boolean {
    // Direction is reversed if the dot product is negative
    const isReversing =
      proposedDirection.rowDiff * lastDirection.rowDiff +
        proposedDirection.colDiff * lastDirection.colDiff <
      0;

    // If trying to reverse, check if we're currently at a city or ferry port
    // Look up the actual GridPoint at the current position to get authoritative terrain
    if (isReversing) {
      const currentGridPoint = this.getGridPointAtPosition(
        currentPosition.row,
        currentPosition.col
      );
      
      if (!currentGridPoint) {
        // If we can't find the GridPoint, fall back to not allowing reversal
        // This is defensive - shouldn't happen in normal gameplay
        console.warn(
          `[TrainMovementManager] Could not find GridPoint at (${currentPosition.row}, ${currentPosition.col})`
        );
        return false;
      }
      
      const currentTerrain = currentGridPoint.terrain;
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
    // Defensive fallback for basic distance when no game state available
    if (!this.gameState.players || this.gameState.players.length === 0 || 
        this.gameState.currentPlayerIndex >= this.gameState.players.length) {
      console.warn("[TrainMovementManager] No players available, using direct distance");
      const dx = Math.abs(to.col - from.col);
      const dy = Math.abs(to.row - from.row);
      return Math.max(dx, dy);
    }

    // Get current player's track data
    const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
    if (!currentPlayer || !currentPlayer.id) {
      console.warn("[TrainMovementManager] Invalid current player, using direct distance");
      const dx = Math.abs(to.col - from.col);
      const dy = Math.abs(to.row - from.row);
      return Math.max(dx, dy);
    }

    const playerTrackState = this.playerTracks.get(currentPlayer.id);
    
    // Use the movement calculator to get the proper cost
    const result = this.movementCalculator.calculateMovementCost(
      from,
      to,
      playerTrackState || null,
      mapConfig.points
    );
    
    console.debug("[TrainMovementManager] Movement cost result:", result);
    
    if (!result.isValid) {
      console.warn(`[TrainMovementManager] Invalid movement: ${result.errorMessage}, using direct distance`);
      const dx = Math.abs(to.col - from.col);
      const dy = Math.abs(to.row - from.row);
      return Math.max(dx, dy);
    }
    
    return result.totalCost;
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
    // Only check reversal if we have movement history (not first move)
    // and the proposed direction would reverse the last direction
    if (lastTrackSegment) {
      // Use the actual current position to look up terrain, not the stored segment
      if (
        !this.canReverseDirection(
          priorPosition,
          proposedDirection,
          lastDirection
        )
      ) {
        // console.log(
        //   "Invalid direction change - can only reverse at cities or ferry ports"
        // );
        return { canMove: false, endMovement: false, message: "Invalid direction change - can only reverse at cities or ferry ports" };
      }
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
