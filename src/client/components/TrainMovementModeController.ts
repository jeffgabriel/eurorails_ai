import "phaser";
import { GameState } from "../../shared/types/GameTypes";
import { PlayerStateService } from "../services/PlayerStateService";
import { TrainMovementManager } from "./TrainMovementManager";
import { TrainSpriteManager } from "./TrainSpriteManager";

/**
 * TrainMovementModeController manages movement mode state and transitions.
 *
 * Responsibilities:
 * - Track whether the player is in movement mode
 * - Track whether the player is in drawing mode
 * - Manage mode transitions (enter/exit)
 * - Coordinate with sprite manager for visual feedback
 * - Load track data when entering movement mode
 */
export class TrainMovementModeController {
  private scene: Phaser.Scene;
  private gameState: GameState;
  private trainMovementManager: TrainMovementManager;
  private trainSpriteManager: TrainSpriteManager;
  private playerStateService: PlayerStateService;

  private _isTrainMovementMode: boolean = false;
  private _isDrawingMode: boolean = false;

  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    trainMovementManager: TrainMovementManager,
    trainSpriteManager: TrainSpriteManager,
    playerStateService: PlayerStateService
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.trainMovementManager = trainMovementManager;
    this.trainSpriteManager = trainSpriteManager;
    this.playerStateService = playerStateService;
  }

  /**
   * Check if currently in movement mode.
   */
  public isInMovementMode(): boolean {
    return this._isTrainMovementMode;
  }

  /**
   * Check if currently in drawing mode.
   */
  public isInDrawingMode(): boolean {
    return this._isDrawingMode;
  }

  /**
   * Enter train movement mode.
   * - Loads latest track data
   * - Sets cursor to pointer
   * - Applies visual feedback to current player's train
   */
  public async enterMovementMode(): Promise<void> {
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];

    // Check if train just arrived at ferry - if so, prevent movement
    if (currentPlayer?.trainState?.ferryState?.status === "just_arrived") {
      return;
    }

    // Load latest track data before enabling movement mode
    if (this.trainMovementManager?.loadTrackData) {
      await this.trainMovementManager.loadTrackData();
    }

    this._isTrainMovementMode = true;

    // Set cursor to indicate movement mode
    this.scene.input.setDefaultCursor("pointer");

    // Add visual indicator that train is selected
    if (currentPlayer) {
      this.trainSpriteManager.setSpriteAlpha(currentPlayer.id, 0.7);
    }
  }

  /**
   * Exit train movement mode.
   * - Resets cursor
   * - Restores train sprite opacity
   * - Restores train sprite to its actual position (in case of drag to invalid location)
   */
  public exitMovementMode(): void {
    this._isTrainMovementMode = false;

    // Reset cursor style
    this.scene.input.setDefaultCursor("default");

    // Reset opacity for all train sprites
    this.trainSpriteManager.resetAllSpriteAlpha();

    // Restore the current player's train sprite to its actual game state position
    // This handles the case where the user dragged to an invalid location
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    if (currentPlayer?.trainState?.position) {
      const pos = currentPlayer.trainState.position;
      const sprite = this.trainSpriteManager.getSprite(currentPlayer.id);
      if (sprite) {
        sprite.setPosition(pos.x, pos.y);
      }
    }
  }

  /**
   * Reset movement mode if currently active.
   * Safe to call even if not in movement mode.
   */
  public resetMovementMode(): void {
    if (this._isTrainMovementMode) {
      this.exitMovementMode();
    }
  }

  /**
   * Set drawing mode state.
   * When entering drawing mode, exits movement mode if active.
   */
  public setDrawingMode(isDrawing: boolean): void {
    this._isDrawingMode = isDrawing;

    // When entering drawing mode, exit train movement mode if active
    if (isDrawing && this._isTrainMovementMode) {
      this.exitMovementMode();
    }
  }
}
