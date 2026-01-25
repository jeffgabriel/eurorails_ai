import "phaser";
import {
  GameState,
  GridPoint,
  Point,
  TerrainType,
  TrackSegment,
  PlayerTrackState,
} from "../../shared/types/GameTypes";
import { MovementCostCalculator, MovementSegment } from "./MovementCostCalculator";
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

  private isTestEnv(): boolean {
    return (
      typeof process !== "undefined" &&
      typeof process.env !== "undefined" &&
      process.env.NODE_ENV === "test"
    );
  }

  private warn(message: string): void {
    if (this.isTestEnv()) return;
    console.warn(message);
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

  public getAllTrackStates(): PlayerTrackState[] {
    return Array.from(this.playerTracks.values());
  }

  /**
   * Union-of-tracks "selection set" for picking a destination milepost.
   * We treat any endpoint of any track segment as being "on track".
   */
  public getUnionTrackPointKeys(): Set<string> {
    const keys = new Set<string>();
    for (const t of this.playerTracks.values()) {
      for (const seg of t.segments || []) {
        keys.add(`${seg.from.row},${seg.from.col}`);
        keys.add(`${seg.to.row},${seg.to.col}`);
      }
    }
    return keys;
  }

  private getUnionTrackState(): PlayerTrackState | null {
    const all = this.getAllTrackStates();
    if (all.length === 0) return null;
    const currentPlayer =
      this.gameState.players && this.gameState.players.length > 0
        ? this.gameState.players[this.gameState.currentPlayerIndex]
        : null;
    const playerId = currentPlayer?.id || all[0].playerId;
    const gameId = this.gameState.id || all[0].gameId;
    return {
      playerId,
      gameId,
      segments: all.flatMap((t) => t.segments || []),
      totalCost: 0,
      turnBuildCost: 0,
      lastBuildTimestamp: new Date(),
    };
  }

  private isTerrainCityOrFerry(terrain: TerrainType): boolean {
    return [
      TerrainType.MajorCity,
      TerrainType.MediumCity,
      TerrainType.SmallCity,
      TerrainType.FerryPort,
    ].includes(terrain);
  }

  private sameGridPosition(a: Point, b: Point): boolean {
    return a.row === b.row && a.col === b.col;
  }

  /**
   * Best-effort reversal detection when we can't compute path segments.
   *
   * We approximate reversal as "moving opposite to the direction of the last move"
   * using a dot product against the overall last-move vector (from -> to).
   */
  private isReversalByDirectionFallback(
    priorPosition: Point,
    proposedTarget: Point,
    lastMove: TrackSegment
  ): boolean {
    const lastVecRow = lastMove.to.row - lastMove.from.row;
    const lastVecCol = lastMove.to.col - lastMove.from.col;
    const proposedVecRow = proposedTarget.row - priorPosition.row;
    const proposedVecCol = proposedTarget.col - priorPosition.col;

    // If the last move has no direction, don't treat anything as a reversal.
    if (lastVecRow === 0 && lastVecCol === 0) return false;

    const dot = proposedVecRow * lastVecRow + proposedVecCol * lastVecCol;
    return dot < 0;
  }

  private getMovementCostSegments(from: Point, to: Point, playerId: string): MovementSegment[] | null {
    const playerTrackState = this.getUnionTrackState();
    const result = this.movementCalculator.calculateMovementCost(
      from,
      to,
      playerTrackState || null,
      mapConfig.points
    );
    if (!result.isValid) return null;
    return result.segments;
  }

  /**
   * Movement points cost for a move. If track data is missing/invalid, falls back to direct distance.
   */
  private calculateDistance(from: Point, to: Point): number {
    // Defensive fallback for basic distance when no game state available
    if (!this.gameState.players || this.gameState.players.length === 0 ||
        this.gameState.currentPlayerIndex >= this.gameState.players.length) {
      this.warn("[TrainMovementManager] No players available, using direct distance");
      const dx = Math.abs(to.col - from.col);
      const dy = Math.abs(to.row - from.row);
      return Math.max(dx, dy);
    }

    // Get union track data (across all players)
    const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
    if (!currentPlayer || !currentPlayer.id) {
      this.warn("[TrainMovementManager] Invalid current player, using direct distance");
      const dx = Math.abs(to.col - from.col);
      const dy = Math.abs(to.row - from.row);
      return Math.max(dx, dy);
    }

    const playerTrackState = this.getUnionTrackState();

    const result = this.movementCalculator.calculateMovementCost(
      from,
      to,
      playerTrackState || null,
      mapConfig.points
    );

    if (!result.isValid) {
      this.warn(`[TrainMovementManager] Invalid movement: ${result.errorMessage}, using direct distance`);
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

  canMoveTo(point: GridPoint): { canMove: boolean; endMovement: boolean; message?: string; distance?: number } {
    // Get current player
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    if (!currentPlayer || !currentPlayer.trainState) {
      // console.log("Current player or train state is undefined");
      return { canMove: false, endMovement: false, message: "Current player or train state is undefined", distance: 0 };
    }

    // Initialize movement history if needed
    if (!currentPlayer.trainState.movementHistory) {
      currentPlayer.trainState.movementHistory = [];
    }

    // Check ferry state - if just arrived at ferry, no movement allowed
    if (currentPlayer.trainState.ferryState?.status === 'just_arrived') {
      // console.log("Cannot move - just arrived at ferry this turn");
      return { canMove: false, endMovement: false, message: "Cannot move - just arrived at ferry this turn", distance: 0 };
    }

    // If this is the first move, only check if it's a valid starting point
    if (!currentPlayer.trainState.position) {
      const isStartingCity = point.terrain == TerrainType.MajorCity;
      if (!isStartingCity) {
        // console.log(
        //   "Invalid starting point - must start first move from a major city"
        // );
      }
      return { canMove: isStartingCity, endMovement: false, message: "Invalid starting point - must start first move from a major city", distance: 0 };
    }

    // Convert current position to GridPoint
    const priorPosition = currentPlayer.trainState.position;

    // Calculate distance for this move
    const distance = this.calculateDistance(
      currentPlayer.trainState.position,
      point
    );
    // Check movement points
    if (!this.hasEnoughMovement(currentPlayer, point)) {
      console.log("Not enough movement points remaining");
      return { canMove: false, endMovement: false, message: "Not enough movement points remaining", distance };
    }

    // Check if this is a valid track connection
    // TODO: Implement track connectivity check using MapRenderer or TrackManager
    const lastTrackSegment =
      currentPlayer.trainState.movementHistory.length > 0
        ? currentPlayer.trainState.movementHistory[
            currentPlayer.trainState.movementHistory.length - 1
          ]
        : currentPlayer.trainState.lastTraversedEdge || null;
    // console.debug("lastTrackSegment", lastTrackSegment);

    // Check reversal rules:
    // If the first segment of the proposed path traverses the most recently-traversed edge backwards,
    // then this is a reversal and is only allowed at a city or ferry port.
    if (lastTrackSegment) {
      const proposedSegments = this.getMovementCostSegments(priorPosition, point, currentPlayer.id);
      const lastMoveSegments = this.getMovementCostSegments(
        lastTrackSegment.from,
        lastTrackSegment.to,
        currentPlayer.id
      );

      const proposedFirst = proposedSegments && proposedSegments.length > 0 ? proposedSegments[0] : null;
      const lastTraversed = lastMoveSegments && lastMoveSegments.length > 0 ? lastMoveSegments[lastMoveSegments.length - 1] : null;

      // Detect reversal using two methods:
      // 1. Exact edge reversal: traversing the same edge backwards (A->B then B->A)
      // 2. Direction change: moving in opposite direction from same starting point (A->B then A->C where C is opposite direction)
      let isReversal = false;
      
      if (proposedFirst && lastTraversed) {
        // Check for exact edge reversal
        const isExactReversal = this.sameGridPosition(proposedFirst.from, lastTraversed.to) &&
                                this.sameGridPosition(proposedFirst.to, lastTraversed.from);
        
        // Also check for direction change at the same position
        // This handles the case where we're back at the starting position and trying to move in a different direction
        const isDirectionChange = this.sameGridPosition(priorPosition, lastTrackSegment.from) &&
                                   !this.sameGridPosition(point, lastTrackSegment.to) &&
                                   this.isReversalByDirectionFallback(priorPosition, point, lastTrackSegment);
        
        isReversal = isExactReversal || isDirectionChange;
      } else {
        // Fallback: approximate reversal by comparing directions
        isReversal = this.isReversalByDirectionFallback(priorPosition, point, lastTrackSegment);
      }

      if (isReversal) {
        const currentGridPoint = this.getGridPointAtPosition(
          priorPosition.row,
          priorPosition.col
        );

        if (!currentGridPoint) {
          this.warn(
            `[TrainMovementManager] Could not find GridPoint at (${priorPosition.row}, ${priorPosition.col})`
          );
          return { canMove: false, endMovement: false, message: "Invalid direction change - can only reverse at cities or ferry ports", distance };
        }

        const canReverse = this.isTerrainCityOrFerry(currentGridPoint.terrain);
        if (!canReverse) {
          return { canMove: false, endMovement: false, message: "Invalid direction change - can only reverse at cities or ferry ports", distance };
        }
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
      return { canMove: true, endMovement: true, message: "Ferry port reached - ending movement", distance };
    }

    return { canMove: true, endMovement: false, message: "Move completed successfully", distance };
  }
}
