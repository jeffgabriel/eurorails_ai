import { GameState, Point, Player } from "../../shared/types/GameTypes";
import { TrackDrawingManager } from "./TrackDrawingManager";
import { LoadService } from "../services/LoadService";
import { PlayerStateService } from "../services/PlayerStateService";
import { LoadType } from "../../shared/types/LoadTypes";
import { TrackSegment } from "../../shared/types/TrackTypes";

type TrainPositionUpdater = {
  updateTrainPosition(
    playerId: string,
    x: number,
    y: number,
    row: number,
    col: number
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
  gameState: GameState;
  trackDrawingManager: TrackDrawingManager;
  trainInteractionManager?: TrainPositionUpdater;
  playerStateService: PlayerStateService;
  loadService: LoadService;
};

export class TurnActionManager {
  private readonly gameState: GameState;
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

  public recordTrainMoved(args: {
    playerId: string;
    previousPosition: Point;
    previousRemainingMovement: number;
    previousFerryState: Player["trainState"]["ferryState"];
    previousJustCrossedFerry: boolean | undefined;
  }): void {
    this.stack.push({ kind: "trainMoved", ...args });
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
          await this.trackDrawingManager.undoLastSegment();
          return true;
        }
        if (typeof (this.trackDrawingManager as any).undoLastUncommittedSegment === "function") {
          return (this.trackDrawingManager as any).undoLastUncommittedSegment();
        }
        return false;
      }
      case "trainMoved": {
        if (!this.trainPositionUpdater) return false;
        const player = this.gameState.players.find((p) => p.id === action.playerId);
        if (!player?.trainState?.position) {
          return false;
        }

        // Undo movement history step (best-effort)
        if (Array.isArray(player.trainState.movementHistory) && player.trainState.movementHistory.length > 0) {
          player.trainState.movementHistory.pop();
        }

        // Restore movement + ferry-related transient state (client-only)
        player.trainState.remainingMovement = action.previousRemainingMovement;
        player.trainState.ferryState = action.previousFerryState;
        player.trainState.justCrossedFerry = action.previousJustCrossedFerry;

        const pos = action.previousPosition;
        await this.trainPositionUpdater.updateTrainPosition(
          player.id,
          pos.x,
          pos.y,
          pos.row,
          pos.col
        );
        return true;
      }
      case "loadPickup": {
        const localPlayer = this.playerStateService.getLocalPlayer();
        if (!localPlayer?.trainState?.loads) return false;

        const idx = localPlayer.trainState.loads.lastIndexOf(action.loadType);
        if (idx === -1) return false;

        const updatedLoads = [...localPlayer.trainState.loads];
        updatedLoads.splice(idx, 1);

        const returned = await this.loadService.returnLoad(
          action.loadType,
          this.gameState.id,
          action.city
        );
        if (!returned) return false;

        const ok = await this.playerStateService.updatePlayerLoads(updatedLoads, this.gameState.id);
        return ok;
      }
      case "loadDrop": {
        const localPlayer = this.playerStateService.getLocalPlayer();
        if (!localPlayer?.trainState?.loads) return false;

        const updatedLoads = [...localPlayer.trainState.loads, action.loadType];

        const pickedUp = await this.loadService.pickupLoad(
          action.loadType,
          action.city,
          this.gameState.id
        );
        if (!pickedUp) return false;

        const ok = await this.playerStateService.updatePlayerLoads(updatedLoads, this.gameState.id);
        return ok;
      }
      case "loadDelivery": {
        // Undo delivery must also undo the load-pool adjustment performed client-side during delivery.
        // Do this first so we can compensate if server undo fails.
        const pickedUp = await this.loadService.pickupLoad(
          action.loadType,
          action.city,
          this.gameState.id
        );
        if (!pickedUp) return false;

        const ok = await this.playerStateService.undoLastAction(this.gameState.id);
        if (!ok) {
          // Compensate: put the load back to the pool to avoid chip drift.
          await this.loadService.returnLoad(action.loadType, this.gameState.id, action.city);
          return false;
        }

        return true;
      }
      default: {
        return false;
      }
    }
  }
}


