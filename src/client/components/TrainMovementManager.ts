import "phaser";
import { GameState, GridPoint, Point, TerrainType, TrackSegment } from "../../shared/types/GameTypes";

export class TrainMovementManager {
  private gameState: GameState;
  private movementHistory: TrackSegment[];

  constructor(gameState: GameState) {
    this.gameState = gameState;
    this.movementHistory = [];
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
    currentPoint: GridPoint,
    proposedDirection: { rowDiff: number; colDiff: number },
    lastDirection: { rowDiff: number; colDiff: number }
  ): boolean {
    // Direction is reversed if the dot product is negative
    const isReversing =
      proposedDirection.rowDiff * lastDirection.rowDiff +
        proposedDirection.colDiff * lastDirection.colDiff <
      0;

    // Can only reverse at cities
    if (isReversing) {
      return this.isCity(currentPoint) || this.isFerryPort(currentPoint);
    }

    return true;
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

  get lastDirection(): { rowDiff: number; colDiff: number } {
    if (this.movementHistory.length < 1) return { rowDiff: 0, colDiff: 0 };

    const last = this.movementHistory[this.movementHistory.length - 1];

    return {
      rowDiff: last.to.row - last.from.row,
      colDiff: last.to.col - last.from.col,
    };
  }

  canMoveTo(point: GridPoint): boolean {
    // Calculate proposed direction
    const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
    if(currentPlayer && currentPlayer.trainState.position) {
      const priorPosition = this.toGridPoint(currentPlayer.trainState.position);
      const proposedDirection = this.calculateMoveVector(
        priorPosition,
        point
      );

    // Check if this is a valid track connection
    // if (!this.isConnected(this.currentPosition, point)) return false;

    // Check reversal rules
    return this.canReverseDirection(
      point,
      proposedDirection,
      this.lastDirection
    );
    }
    return false;
  
  }

  private toGridPoint(point: { row: number, col: number, x: number; y: number }): GridPoint {
    return {
      x: point.x,
      y: point.y,
      row: point.row,
      col: point.col,
      terrain: TerrainType.Clear
    };
  }

}
