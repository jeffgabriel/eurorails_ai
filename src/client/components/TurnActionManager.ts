import { FullGameState, Point, Player, TerrainType } from "../../shared/types/GameTypes";
import { TrackDrawingManager } from "./TrackDrawingManager";
import { LoadService } from "../services/LoadService";
import { PlayerStateService } from "../services/PlayerStateService";
import { LoadType } from "../../shared/types/LoadTypes";
import { TrackSegment } from "../../shared/types/TrackTypes";
import { mapConfig } from "../config/mapConfig";

type TrainPositionUpdater = {
  updateTrainPosition(
    playerId: string,
    x: number,
    y: number,
    row: number,
    col: number
    , opts?: { persist?: boolean }
  ): Promise<void>;
};

export type TurnAction =
  | {
      kind: "trackSegmentBuilt";
      segment: TrackSegment;
      committed: boolean;
    }
  | {
      kind: "trainMoved";
      playerId: string;
      previousPosition: Point;
      previousRemainingMovement: number;
      previousFerryState: Player["trainState"]["ferryState"];
      previousJustCrossedFerry: boolean | undefined;
      ownersPaidPlayerIds?: string[];
      feeTotal?: number;
    }
  | {
      kind: "loadPickup";
      city: string;
      loadType: LoadType;
    }
  | {
      kind: "loadDrop";
      city: string;
      loadType: LoadType;
    }
  | {
      kind: "loadDelivery";
      city: string;
      loadType: LoadType;
      cardIdUsed: number;
      newCardIdDrawn: number;
      payment: number;
    };

type TurnActionManagerDeps = {
  gameState: FullGameState;
  trackDrawingManager: TrackDrawingManager;
  trainInteractionManager?: TrainPositionUpdater;
  playerStateService: PlayerStateService;
  loadService: LoadService;
};

export class TurnActionManager {
  private readonly gameState: FullGameState;
  private readonly trackDrawingManager: TrackDrawingManager;
  private trainPositionUpdater: TrainPositionUpdater | null = null;
  private readonly playerStateService: PlayerStateService;
  private readonly loadService: LoadService;
  private stack: TurnAction[] = [];

  constructor(deps: TurnActionManagerDeps) {
    this.gameState = deps.gameState;
    this.trackDrawingManager = deps.trackDrawingManager;
    this.trainPositionUpdater = deps.trainInteractionManager || null;
    this.playerStateService = deps.playerStateService;
    this.loadService = deps.loadService;
  }

  public setTrainPositionUpdater(updater: TrainPositionUpdater): void {
    this.trainPositionUpdater = updater;
  }

  public canUndo(): boolean {
    return this.stack.length > 0;
  }

  public clear(): void {
    this.stack = [];
  }

  public recordTrackSegmentBuilt(segment: TrackSegment): void {
    this.stack.push({ kind: "trackSegmentBuilt", segment, committed: false });
  }

  public markLastUncommittedTrackSegmentsCommitted(count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    let remaining = Math.floor(count);
    for (let i = this.stack.length - 1; i >= 0 && remaining > 0; i--) {
      const action = this.stack[i];
      if (action.kind !== "trackSegmentBuilt") continue;
      if (action.committed) continue;
      action.committed = true;
      remaining--;
    }
  }

  /**
   * Drop the most recent `count` uncommitted track sections: the server
   * refused them, so there is nothing left to undo.
   */
  public discardLastUncommittedTrackSegments(count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    let remaining = Math.floor(count);
    for (let i = this.stack.length - 1; i >= 0 && remaining > 0; i--) {
      const action = this.stack[i];
      if (action.kind !== "trackSegmentBuilt" || action.committed) continue;
      this.stack.splice(i, 1);
      remaining--;
    }
  }

  public recordTrainMoved(args: {
    playerId: string;
    previousPosition: Point;
    previousRemainingMovement: number;
    previousFerryState: Player["trainState"]["ferryState"];
    previousJustCrossedFerry: boolean | undefined;
    ownersPaidPlayerIds?: string[];
    feeTotal?: number;
  }): void {
    this.stack.push({ kind: "trainMoved", ...args });
  }

  /**
   * Best-effort: track which opponents have already been paid for track usage this turn
   * (based on local action stack AND server-loaded paidOpponentIds).
   * This ensures "once per turn" fee tracking persists across browser refresh.
   * Server remains authoritative.
   */
  public getPaidOpponentIdsThisTurn(): Set<string> {
    const paid = new Set<string>();

    // Include paidOpponentIds loaded from server (persisted across refresh)
    const currentPlayer = this.gameState.players?.[this.gameState.currentPlayerIndex];
    const serverPaidIds = currentPlayer?.trainState?.paidOpponentIds;
    if (Array.isArray(serverPaidIds)) {
      for (const id of serverPaidIds) {
        if (typeof id === "string" && id.length > 0) paid.add(id);
      }
    }

    // Also include any paid during this session (local stack)
    for (const action of this.stack) {
      if (action.kind !== "trainMoved") continue;
      const ids = (action as any).ownersPaidPlayerIds;
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        if (typeof id === "string" && id.length > 0) paid.add(id);
      }
    }
    return paid;
  }

  public recordLoadPickup(city: string, loadType: LoadType): void {
    this.stack.push({ kind: "loadPickup", city, loadType });
  }

  public recordLoadDrop(city: string, loadType: LoadType): void {
    this.stack.push({ kind: "loadDrop", city, loadType });
  }

  public recordLoadDelivery(args: {
    city: string;
    loadType: LoadType;
    cardIdUsed: number;
    newCardIdDrawn: number;
    payment: number;
  }): void {
    this.stack.push({ kind: "loadDelivery", ...args });
  }

  public async undoLastAction(): Promise<boolean> {
    const isLocalPlayerTurn = this.playerStateService.isCurrentPlayer(
      this.gameState.currentPlayerIndex,
      this.gameState.players
    );
    if (!isLocalPlayerTurn) {
      return false;
    }

    const action = this.stack[this.stack.length - 1];
    if (!action) return false;

    const success = await this.undoAction(action);
    if (!success) return false;

    this.stack.pop();
    return true;
  }

  private async undoAction(action: TurnAction): Promise<boolean> {
    switch (action.kind) {
      case "trackSegmentBuilt": {
        if (action.committed) {
          return this.trackDrawingManager.undoLastSegment();
        }
        if (typeof (this.trackDrawingManager as any).undoLastUncommittedSegment === "function") {
          return (this.trackDrawingManager as any).undoLastUncommittedSegment();
        }
        return false;
      }
      case "trainMoved": {
        if (!this.trainPositionUpdater) return false;
        const playerBefore = this.gameState.players.find((p) => p.id === action.playerId);
        if (!playerBefore?.trainState?.position) {
          return false;
        }

        // Server-authoritative undo for move fees + persisted position.
        // If this fails, do not change local state.
        const okServer = await this.playerStateService.undoLastAction(this.gameState.id);
        if (!okServer) {
          return false;
        }

        // Re-fetch player after server call - socket patch may have replaced the object in the array
        const player = this.gameState.players.find((p) => p.id === action.playerId);
        if (!player?.trainState) {
          return false;
        }

        // Pop from movement history and preserve last traversed edge for reversal detection
        const poppedSegment = Array.isArray(player.trainState.movementHistory) && player.trainState.movementHistory.length > 0
          ? player.trainState.movementHistory.pop()
          : undefined;

        // Preserve last traversed edge for reversal detection unless we're at a city/ferry where reversal is allowed
        const pos = action.previousPosition;
        const restoredGridPoint = mapConfig.points.find(
          (point) => point.row === pos.row && point.col === pos.col
        );
        const isAtCityOrFerry = restoredGridPoint && 
          [TerrainType.MajorCity, TerrainType.MediumCity, TerrainType.SmallCity, TerrainType.FerryPort]
          .includes(restoredGridPoint.terrain);
        
        if (!isAtCityOrFerry && poppedSegment) {
          player.trainState.lastTraversedEdge = poppedSegment;
        } else {
          player.trainState.lastTraversedEdge = undefined;
        }

        // Restore movement + ferry-related transient state (client-only)
        player.trainState.remainingMovement = action.previousRemainingMovement;
        player.trainState.ferryState = action.previousFerryState;
        player.trainState.justCrossedFerry = action.previousJustCrossedFerry;

        await this.trainPositionUpdater.updateTrainPosition(
          player.id,
          pos.x,
          pos.y,
          pos.row,
          pos.col,
          { persist: false }
        );
        return true;
      }
      case "loadPickup":
      case "loadDrop": {
        // Server-authoritative undo: the server restores the train's loads and
        // the city's chips from its own action log. If it fails, change nothing.
        const undone = await this.playerStateService.undoLoadAction(this.gameState.id);
        if (!undone) return false;

        this.loadService.applyServerUpdate(undone);
        return true;
      }
      case "loadDelivery": {
        const ok = await this.playerStateService.undoLastAction(this.gameState.id);
        if (!ok) return false;

        // The delivered chip had gone back to the tray; it is on the train again.
        this.loadService.adjustTrayCount(action.loadType, -1);
        return true;
      }
      default: {
        return false;
      }
    }
  }
}


