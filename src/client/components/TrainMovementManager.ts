import "phaser";
import {
  GameState,
  GridPoint,
  Point,
  TerrainType,
  TrackSegment,
} from "../../shared/types/GameTypes";

export class TrainMovementManager {
  private gameState: GameState;

  constructor(gameState: GameState) {
    this.gameState = gameState;
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
        console.log("Cannot reverse direction - not at a city or ferry port. Current terrain:", currentTerrain);
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
    // For diagonal moves, we want to count it as 1 movement point
    // since it's still just one track segment
    const dx = Math.abs(to.col - from.col);
    const dy = Math.abs(to.row - from.row);
    
    // If either dx or dy is 0, or if they're equal (diagonal),
    // it's a single track segment
    return Math.max(dx, dy);
  }

  private hasEnoughMovement(currentPlayer: any, proposedPoint: Point): boolean {
    if (!currentPlayer.trainState.position) return true; // First move is always allowed
    
    const distance = this.calculateDistance(
      currentPlayer.trainState.position,
      proposedPoint
    );
    
    let maxMovement = currentPlayer.trainState.remainingMovement;
    console.log("Checking movement - Distance:", distance, "Max Movement:", maxMovement);

    // If at a ferry port, movement is halved
    const lastTrackPoint = currentPlayer.trainState.movementHistory.length > 0
      ? currentPlayer.trainState.movementHistory[
          currentPlayer.trainState.movementHistory.length - 1
        ].to
      : null;
    if (lastTrackPoint && lastTrackPoint.terrain === TerrainType.FerryPort) {
      maxMovement = Math.floor(maxMovement / 2);
    }
    
    return distance <= maxMovement;
  }

  private deductMovement(currentPlayer: any, distance: number): void {
    currentPlayer.trainState.remainingMovement -= distance;
    console.log("Deducted movement points:", distance, "Remaining:", currentPlayer.trainState.remainingMovement);
  }

  canMoveTo(point: GridPoint): boolean {
    // Get current player
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    if (!currentPlayer || !currentPlayer.trainState) {
      console.log("Current player or train state is undefined");
      return false;
    }

    // Initialize movement history if needed
    if (!currentPlayer.trainState.movementHistory) {
      currentPlayer.trainState.movementHistory = [];
    }

    // If this is the first move, only check if it's a valid starting point
    if (!currentPlayer.trainState.position) {
      const isStartingCity = point.terrain == TerrainType.MajorCity;
      if (!isStartingCity) {
        console.log(
          "Invalid starting point - must start first move from a major city"
        );
      }
      return isStartingCity; // Can only start at cities
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

    // Check movement points
    if (!this.hasEnoughMovement(currentPlayer, point)) {
      console.log("Not enough movement points remaining");
      return false;
    }

    // Check if this is a valid track connection
    // TODO: Implement track connectivity check using MapRenderer or TrackManager
    const lastTrackSegment =
      currentPlayer.trainState.movementHistory.length > 0
        ? currentPlayer.trainState.movementHistory[
            currentPlayer.trainState.movementHistory.length - 1
          ]
        : null;
    console.debug("lastTrackSegment", lastTrackSegment);

    // Check reversal rules
    if (
      lastTrackSegment &&
      !this.canReverseDirection(
        lastTrackSegment,
        proposedDirection,
        lastDirection
      )
    ) {
      console.log(
        "Invalid direction change - can only reverse at cities or ferry ports"
      );
      return false;
    }

    // If we got here, the move is valid - deduct the movement points
    this.deductMovement(currentPlayer, distance);

    return true;
  }
}
