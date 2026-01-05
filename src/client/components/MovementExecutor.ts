import "phaser";
import {
  GameState,
  GridPoint,
  Player,
  TerrainType,
  TrackSegment,
  TRACK_USAGE_FEE,
} from "../../shared/types/GameTypes";
import { PlayerStateService } from "../services/PlayerStateService";
import { TrainMovementManager } from "./TrainMovementManager";
import { TrackDrawingManager } from "./TrackDrawingManager";
import { TurnActionManager } from "./TurnActionManager";
import { UIManager } from "./UIManager";
import { computeTrackUsageForMove } from "../../shared/services/trackUsageFees";

/**
 * Result of a movement execution attempt.
 */
export interface MovementResult {
  success: boolean;
  message?: string;
  endMovement: boolean;
}

/**
 * Callback type for updating train position visually.
 */
export type TrainPositionUpdater = (
  playerId: string,
  x: number,
  y: number,
  row: number,
  col: number,
  opts?: { persist?: boolean }
) => Promise<void>;

/**
 * Callback for exiting movement mode.
 */
export type ExitMovementModeCallback = () => void;

/**
 * MovementExecutor handles movement execution, fee handling, and state management.
 *
 * Responsibilities:
 * - Validate movement via TrainMovementManager
 * - Show fee confirmation modal
 * - Persist movement via server
 * - Restore state on abort/rejection
 * - Track movement history
 * - Record on undo stack
 */
export class MovementExecutor {
  private scene: Phaser.Scene;
  private gameState: GameState;
  private trainMovementManager: TrainMovementManager;
  private playerStateService: PlayerStateService;
  private trackDrawingManager: TrackDrawingManager;
  private turnActionManager: TurnActionManager | null = null;
  private uiManager: UIManager | null = null;
  private trainPositionUpdater: TrainPositionUpdater | null = null;
  private exitMovementModeCallback: ExitMovementModeCallback | null = null;

  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    trainMovementManager: TrainMovementManager,
    playerStateService: PlayerStateService,
    trackDrawingManager: TrackDrawingManager
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.trainMovementManager = trainMovementManager;
    this.playerStateService = playerStateService;
    this.trackDrawingManager = trackDrawingManager;
  }

  /**
   * Set the UI manager reference (late-bound dependency).
   */
  public setUIManager(uiManager: UIManager): void {
    this.uiManager = uiManager;
  }

  /**
   * Set the turn action manager reference (late-bound dependency).
   */
  public setTurnActionManager(turnActionManager: TurnActionManager): void {
    this.turnActionManager = turnActionManager;
  }

  /**
   * Set the train position updater callback.
   */
  public setTrainPositionUpdater(updater: TrainPositionUpdater): void {
    this.trainPositionUpdater = updater;
  }

  /**
   * Set the exit movement mode callback.
   */
  public setExitMovementModeCallback(callback: ExitMovementModeCallback): void {
    this.exitMovementModeCallback = callback;
  }

  /**
   * Execute a movement for a player to a destination.
   *
   * Critical patterns preserved:
   * 1. Socket patch handling: Always re-fetch player from gameState.players after async calls
   * 2. Movement deduction restore: canMoveTo() deducts immediately; restore on abort/rejection
   * 3. Fee confirmation closure: Capture previous state for restoreAfterAbort()
   * 4. Undo recording order: Record after successful server confirmation
   */
  public async executeMovement(
    currentPlayer: Player,
    destination: GridPoint,
    pointer: Phaser.Input.Pointer
  ): Promise<MovementResult> {
    try {
      const currentPlayerId = currentPlayer?.id;
      if (!currentPlayerId) {
        return { success: false, message: "No player ID", endMovement: false };
      }

      // Capture state before validation for potential restoration
      const previousPosition = currentPlayer.trainState.position;
      const previousRemainingMovement = currentPlayer.trainState.remainingMovement;
      const previousFerryState: Player["trainState"]["ferryState"] =
        currentPlayer.trainState.ferryState
          ? (JSON.parse(
              JSON.stringify(currentPlayer.trainState.ferryState)
            ) as Player["trainState"]["ferryState"])
          : undefined;
      const previousJustCrossedFerry = currentPlayer.trainState.justCrossedFerry;

      // Validate movement (this also deducts movement immediately)
      const moveResult = this.trainMovementManager.canMoveTo(destination);
      if (!moveResult.canMove) {
        this.showInvalidMoveMessage(
          pointer,
          moveResult.message || "Invalid move. You cannot move to this point."
        );
        return { success: false, message: moveResult.message, endMovement: false };
      }

      const remainingMovementAfterValidation = currentPlayer.trainState.remainingMovement;

      // Helper to get refreshed player reference after async operations
      const getRefreshedPlayer = (): Player | undefined =>
        this.gameState.players.find((p) => p.id === currentPlayerId);

      // Restore state if user cancels or server rejects
      const restoreAfterAbort = () => {
        const refreshed = getRefreshedPlayer();
        if (!refreshed?.trainState) return;
        refreshed.trainState.remainingMovement = previousRemainingMovement;
        refreshed.trainState.ferryState = previousFerryState;
        refreshed.trainState.justCrossedFerry = previousJustCrossedFerry;
      };

      // Fee warning modal (UX only). Server remains authoritative.
      if (previousPosition && this.uiManager) {
        const usage = computeTrackUsageForMove({
          allTracks: this.trainMovementManager.getAllTrackStates(),
          from: { row: previousPosition.row, col: previousPosition.col },
          to: { row: destination.row, col: destination.col },
          currentPlayerId: currentPlayer.id,
        });

        if (usage.isValid && usage.ownersUsed.size > 0 && this.turnActionManager) {
          const alreadyPaid = this.turnActionManager.getPaidOpponentIdsThisTurn();
          const newlyPayable = Array.from(usage.ownersUsed).filter(
            (pid) => !alreadyPaid.has(pid)
          );
          if (newlyPayable.length > 0) {
            const payees = newlyPayable.map((pid) => {
              const p = this.gameState.players.find((pp) => pp.id === pid);
              return { name: p?.name || "Opponent", amount: TRACK_USAGE_FEE };
            });
            const total = payees.reduce((sum, p) => sum + p.amount, 0);
            const accepted = await this.uiManager.confirmOpponentTrackFee({
              payees,
              total,
            });
            if (!accepted) {
              restoreAfterAbort();
              return { success: false, message: "User cancelled fee", endMovement: false };
            }
          }
        }
      }

      // Persist movement via server-authoritative fee settlement
      const moveApiResult = await this.playerStateService.moveTrainWithFees(
        {
          x: destination.x,
          y: destination.y,
          row: destination.row,
          col: destination.col,
        },
        this.gameState.id,
        moveResult.distance
      );

      if (!moveApiResult) {
        restoreAfterAbort();
        this.showInvalidMoveMessage(pointer, "Move rejected by server (fees/path).");
        return { success: false, message: "Server rejected move", endMovement: false };
      }

      // Re-fetch player after async call - socket patches may have replaced the object
      const refreshedPlayer = getRefreshedPlayer();
      if (!refreshedPlayer) {
        console.error("[MovementExecutor] Player reference became invalid after move");
        return { success: false, message: "Player reference lost", endMovement: false };
      }

      // Ensure the movement deduction from canMoveTo is applied to the refreshed object
      if (refreshedPlayer.trainState) {
        refreshedPlayer.trainState.remainingMovement = remainingMovementAfterValidation;
      }

      // Create movement history entry (client-only, for direction rules)
      // Use the distance from canMoveTo validation (stored in moveResult.distance)
      if (previousPosition) {
        const movementCost = moveResult.distance ?? 0;
        // Look up the actual terrain at the previous position
        const previousGridPoint = this.trackDrawingManager.getGridPointAtPosition(
          previousPosition.x,
          previousPosition.y
        );
        const previousTerrain = previousGridPoint?.terrain ?? TerrainType.Clear;
        const movementSegment: TrackSegment = {
          from: {
            x: previousPosition.x,
            y: previousPosition.y,
            row: previousPosition.row,
            col: previousPosition.col,
            terrain: previousTerrain,
          },
          to: {
            x: destination.x,
            y: destination.y,
            row: destination.row,
            col: destination.col,
            terrain: destination.terrain,
          },
          cost: movementCost,
        };
        if (!refreshedPlayer.trainState.movementHistory) {
          refreshedPlayer.trainState.movementHistory = [];
        }
        refreshedPlayer.trainState.movementHistory.push(movementSegment);
      }

      // Update train position visually without re-posting (already persisted by move-train)
      if (this.trainPositionUpdater) {
        await this.trainPositionUpdater(
          currentPlayerId,
          destination.x,
          destination.y,
          destination.row,
          destination.col,
          { persist: false }
        );
      }

      // Record on unified undo stack (single click undoes one action)
      if (this.turnActionManager && previousPosition) {
        this.turnActionManager.recordTrainMoved({
          playerId: currentPlayerId,
          previousPosition: { ...previousPosition },
          previousRemainingMovement,
          previousFerryState,
          previousJustCrossedFerry,
          ownersPaidPlayerIds: (moveApiResult.ownersPaid || []).map(
            (p) => p.playerId
          ),
          feeTotal: moveApiResult.feeTotal,
        });

        // Refresh hand UI so Undo button visibility updates immediately
        try {
          const prevSessions =
            this.trackDrawingManager.getPlayerTrackState(currentPlayer.id)
              ?.turnBuildCost || 0;
          const currentSession = this.trackDrawingManager.getCurrentTurnBuildCost();
          const totalCost = prevSessions + currentSession;
          await this.uiManager?.setupPlayerHand(
            this.trackDrawingManager.isInDrawingMode,
            totalCost
          );
        } catch (e) {
          // Non-fatal
        }
      }

      // If arrived at a ferry port, or if movement should end, exit movement mode
      if (moveResult.endMovement && this.exitMovementModeCallback) {
        this.exitMovementModeCallback();
      }

      return {
        success: true,
        endMovement: moveResult.endMovement,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Show an invalid move message near the pointer position.
   */
  public showInvalidMoveMessage(
    pointer: Phaser.Input.Pointer,
    message: string
  ): void {
    const movementProblemText = this.scene.add.text(
      pointer.x,
      pointer.y,
      message,
      {
        fontSize: "16px",
        color: "#ff0000",
        backgroundColor: "#ffffff",
        padding: { x: 10, y: 5 },
        align: "center",
      }
    );

    // Set a timeout to remove the text after a few seconds
    this.scene.time.addEvent({
      delay: 3000, // 3 seconds
      callback: () => {
        movementProblemText.destroy();
      },
    });
  }
}
