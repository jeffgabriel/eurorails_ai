import "phaser";
import { GameState, GridPoint, Point, TerrainType, TrackSegment } from "../../shared/types/GameTypes";

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
    currentPoint: TrackSegment,
    proposedDirection: { rowDiff: number; colDiff: number },
    lastDirection: { rowDiff: number; colDiff: number }
  ): boolean {
    // Direction is reversed if the dot product is negative
    const isReversing =
      proposedDirection.rowDiff * lastDirection.rowDiff +
        proposedDirection.colDiff * lastDirection.colDiff <
      0;

    // Can only reverse at cities or ferry ports
    if (isReversing) {
      //last track segment's 'to' is the starting point for movement in this turn.
      return this.isTerrainCityOrFerry(currentPoint.to.terrain);
    }

    return true;
  }

  private isTerrainCityOrFerry(terrain: TerrainType): boolean {
    return [
      TerrainType.MajorCity,
      TerrainType.MediumCity,
      TerrainType.SmallCity,
      TerrainType.FerryPort
    ].includes(terrain);
  }

  private isCity(point: GridPoint): boolean {
    return [
      TerrainType.MajorCity,
      TerrainType.MediumCity,
      TerrainType.SmallCity,
    ].includes(point.terrain);
  }

  private isFerryPort(point: GridPoint): boolean {
    return point.terrain === TerrainType.FerryPort;
  }

  private getLastDirection(movementHistory: TrackSegment[]): { rowDiff: number; colDiff: number } {
    if (movementHistory.length < 1) return { rowDiff: 0, colDiff: 0 };

    const last = movementHistory[movementHistory.length - 1];
    return {
      rowDiff: last.to.row - last.from.row,
      colDiff: last.to.col - last.from.col,
    };
  }

  private calculateDistance(from: Point, to: Point): number {
    // For now, using Manhattan distance as a simple approximation
    // Could be enhanced with actual track distance calculation
    return Math.abs(to.row - from.row) + Math.abs(to.col - from.col);
  }

  private hasEnoughMovement(currentPlayer: any, proposedPoint: Point): boolean {
    if (!currentPlayer.trainState.position) return true; // First move is always allowed

    const distance = this.calculateDistance(currentPlayer.trainState.position, proposedPoint);
    const maxMovement = currentPlayer.trainType === "Fast Freight" || currentPlayer.trainType === "Superfreight" 
      ? 12  // Fast trains
      : 9;  // Regular trains

    // If at a ferry port, movement is halved
    const isAtFerry = this.isFerryPort(this.toGridPoint(currentPlayer.trainState.position));
    const effectiveMaxMovement = isAtFerry ? Math.floor(maxMovement / 2) : maxMovement;

    // Check if we have enough remaining movement
    const remainingMovement = currentPlayer.trainState.remainingMovement ?? effectiveMaxMovement;
    return distance <= remainingMovement;
  }

  canMoveTo(point: GridPoint): boolean {
    // Get current player
    const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
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
        console.log("Invalid starting point - must start first move from a major city");
      }
      return isStartingCity; // Can only start at cities
    }

    // Convert current position to GridPoint
    const priorPosition = this.toGridPoint(currentPlayer.trainState.position);

    // Calculate proposed direction
    const proposedDirection = this.calculateMoveVector(priorPosition, point);

    // Get last direction from movement history
    const lastDirection = this.getLastDirection(currentPlayer.trainState.movementHistory);

    // Check movement points
    if (!this.hasEnoughMovement(currentPlayer, point)) {
      console.log("Not enough movement points remaining");
      return false;
    }

    // Check if this is a valid track connection
    // TODO: Implement track connectivity check using MapRenderer or TrackManager
    const lastTrackSegment = currentPlayer.trainState.movementHistory[currentPlayer.trainState.movementHistory.length - 1];
    console.debug("lastTrackSegment", lastTrackSegment);
    // Check reversal rules
    if (!this.canReverseDirection(lastTrackSegment, proposedDirection, lastDirection)) {
      console.log("Invalid direction change - can only reverse at cities or ferry ports");
      return false;
    }

    return true;
  }

  private toGridPoint(point: { row: number, col: number, x: number; y: number }): GridPoint {
    return {
      x: point.x,
      y: point.y,
      row: point.row,
      col: point.col,
      terrain: TerrainType.Clear // Default terrain, should be updated with actual terrain if needed
    };
  }
}
