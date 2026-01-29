import "phaser";
import {
  GameState,
  GridPoint,
  Player,
  TerrainType,
  Point,
} from "../../shared/types/GameTypes";
import { GameStateService } from "../services/GameStateService";
import { PlayerStateService } from "../services/PlayerStateService";
import { MapRenderer } from "./MapRenderer";
import { TrainMovementManager } from "./TrainMovementManager";
import { PlayerHandDisplay } from "./PlayerHandDisplay";
import { UIManager } from "./UIManager";
import { TrackDrawingManager } from "./TrackDrawingManager";
import { TurnActionManager } from "./TurnActionManager";
import { TrainSpriteManager } from "./TrainSpriteManager";
import { TrainMovementModeController } from "./TrainMovementModeController";
import { CityArrivalHandler } from "./CityArrivalHandler";
import { MovementExecutor } from "./MovementExecutor";

export class TrainInteractionManager {
  private scene: Phaser.Scene;
  private gameState: GameState;
  private trainMovementManager: TrainMovementManager;
  private mapRenderer: MapRenderer;
  private gameStateService: GameStateService;
  private playerStateService: PlayerStateService;
  private trainContainer: Phaser.GameObjects.Container;
  private trainSpriteManager: TrainSpriteManager;
  private movementModeController: TrainMovementModeController;
  private cityArrivalHandler: CityArrivalHandler;
  private movementExecutor: MovementExecutor;
  private playerHandDisplay: PlayerHandDisplay | null = null;
  private handContainer: Phaser.GameObjects.Container | null = null;
  private uiManager: UIManager | null = null;
  private trackDrawingManager: TrackDrawingManager;
  private turnActionManager: TurnActionManager | null = null;
  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    trainMovementManager: TrainMovementManager,
    mapRenderer: MapRenderer,
    gameStateService: GameStateService,
    trainContainer: Phaser.GameObjects.Container,
    trackDrawingManager: TrackDrawingManager,
    turnActionManager?: TurnActionManager,
    playerStateService?: PlayerStateService
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.trainMovementManager = trainMovementManager;
    this.mapRenderer = mapRenderer;
    this.gameStateService = gameStateService;
    this.playerStateService = playerStateService ?? new PlayerStateService();
    this.playerStateService.initializeLocalPlayer(this.gameState.players);
    this.trainContainer = trainContainer;
    this.trackDrawingManager = trackDrawingManager;
    this.turnActionManager = turnActionManager || null;

    // Initialize TrainSpriteManager for sprite lifecycle management
    this.trainSpriteManager = new TrainSpriteManager(
      scene,
      gameState,
      trainContainer,
      this.playerStateService
    );

    // Initialize TrainMovementModeController for mode state management
    this.movementModeController = new TrainMovementModeController(
      scene,
      gameState,
      trainMovementManager,
      this.trainSpriteManager,
      this.playerStateService
    );

    // Initialize CityArrivalHandler for city arrival and load dialog management
    this.cityArrivalHandler = new CityArrivalHandler(
      scene,
      gameState,
      this.playerStateService
    );

    // Initialize MovementExecutor for movement execution and fee handling
    this.movementExecutor = new MovementExecutor(
      scene,
      gameState,
      trainMovementManager,
      this.playerStateService,
      trackDrawingManager
    );

    // Set up callbacks for MovementExecutor
    this.movementExecutor.setTrainPositionUpdater(
      (playerId, x, y, row, col, opts) =>
        this.updateTrainPosition(playerId, x, y, row, col, opts)
    );
    this.movementExecutor.setExitMovementModeCallback(() =>
      this.exitTrainMovementMode()
    );

    // Set up callback for train sprite interaction
    this.trainSpriteManager.setInteractionCallback(
      (playerId: string, pointer: Phaser.Input.Pointer) => {
        this.handleTrainSpriteClick(playerId, pointer);
      }
    );

    // Pass turnActionManager to child managers if provided
    if (turnActionManager) {
      this.cityArrivalHandler.setTurnActionManager(turnActionManager);
      this.movementExecutor.setTurnActionManager(turnActionManager);
    }

    this.setupTrainInteraction();
  }

  private setupTrainInteraction(): void {
    // Listen for pointer down events on the scene
    this.scene.input.on(
      "pointerdown",
      async (pointer: Phaser.Input.Pointer) => {
        // Only handle train placement if we're in train movement mode
        // AND we didn't just enter movement mode on this same click
        if (
          this.movementModeController.isInMovementMode() &&
          !this.movementModeController.wasJustEntered()
        ) {
          // Stop event propagation to prevent other handlers
          if (pointer.event) {
            pointer.event.stopPropagation();
          }
        }
        // Use await to ensure we handle the entire train placement process
        await this.handleTrainPlacement(pointer);
        // Reset the flag after the click is processed
        this.movementModeController.clearJustEnteredFlag();
      }
    );
  }

  /**
   * Handle click on a train sprite. Contains validation logic for when
   * a train can be interacted with (turn number, drawing mode, track exists).
   */
  private handleTrainSpriteClick(
    playerId: string,
    _pointer: Phaser.Input.Pointer
  ): void {
    const activePlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];

    // Per rules: players get 2 full track-drawing turns before any movement.
    // Since movement comes first in a turn, movement is only allowed starting on turn 3.
    if ((activePlayer?.turnNumber ?? 1) < 3) {
      this.uiManager?.showHandToast?.(
        "You must build track for 2 turns before moving."
      );
      return;
    }

    if (this.movementModeController.isInDrawingMode()) {
      this.uiManager?.showHandToast?.("Exit track drawing mode before moving.");
      return;
    }

    // Movement-before-drawing rule:
    // If the player has drawn/built any track this turn, they cannot move again until next turn.
    if (this.trackDrawingManager.hasDrawnThisTurn()) {
      this.uiManager?.showHandToast?.(
        "You cannot move again this turn after you start drawing track."
      );
      return;
    }

    const hasTrack = this.playerHasTrack(playerId);
    if (!hasTrack) {
      this.uiManager?.showHandToast?.(
        "Build at least 1 track segment before moving."
      );
      return;
    }

    // Toggle movement mode
    this.movementModeController.toggleMovementMode();
  }

  public playerHasTrack(playerId: string): boolean {
    // Get player's track state from TrackDrawingManager
    const playerTrackState =
      this.trackDrawingManager.getPlayerTrackState(playerId);
    if (!playerTrackState || !playerTrackState.segments) {
      return false;
    }
    return playerTrackState.segments.length > 0;
  }

  public findNearestMilepostOnOwnTrack(
    x: number,
    y: number,
    playerId: string
  ): GridPoint | null {
    // First, get the clicked point using TrackDrawingManager's method
    const clickedPoint = this.trackDrawingManager.getGridPointAtPosition(x, y);

    if (!clickedPoint) {
      return null;
    }

    // Union-of-tracks selection: allow selecting a destination on any player's track.
    const trackPoints = this.trainMovementManager.getUnionTrackPointKeys();
    if (trackPoints.size === 0) {
      // Fallback to own track points if the movement manager has not loaded tracks yet.
      const playerTrackState = this.trackDrawingManager.getPlayerTrackState(playerId);
      if (!playerTrackState || !playerTrackState.segments) return null;
      playerTrackState.segments.forEach((segment) => {
        trackPoints.add(`${segment.from.row},${segment.from.col}`);
        trackPoints.add(`${segment.to.row},${segment.to.col}`);
      });
    }

    if (trackPoints.has(`${clickedPoint.row},${clickedPoint.col}`)) {
      return clickedPoint;
    }

    // If not, find the nearest point that is part of a player's track segment
    let nearestPoint: GridPoint | null = null;
    let minDistance = Infinity;

    // Search through adjacent points first (within a reasonable radius)
    const searchRadius = 3; // Adjust this value as needed
    const rowStart = Math.max(0, clickedPoint.row - searchRadius);
    const rowEnd = Math.min(
      this.mapRenderer.gridPoints.length - 1,
      clickedPoint.row + searchRadius
    );

    for (let row = rowStart; row <= rowEnd; row++) {
      if (!this.mapRenderer.gridPoints[row]) continue;

      const colStart = Math.max(0, clickedPoint.col - searchRadius);
      const colEnd = Math.min(
        this.mapRenderer.gridPoints[row].length - 1,
        clickedPoint.col + searchRadius
      );

      for (let col = colStart; col <= colEnd; col++) {
        const point = this.mapRenderer.gridPoints[row][col];
        if (!point || point.terrain === TerrainType.Water) continue;

        // Check if this point is part of the player's track network
        if (trackPoints.has(`${point.row},${point.col}`)) {
          // Calculate distance to this point
          const dx = point.x - clickedPoint.x;
          const dy = point.y - clickedPoint.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          // Update nearest point if this is closer
          if (distance < minDistance) {
            minDistance = distance;
            nearestPoint = point;
          }
        }
      }
    }

    if (nearestPoint) {
      return nearestPoint;
    }

    return null;
  }

  private async handleTrainPlacement(
    pointer: Phaser.Input.Pointer
  ): Promise<void> {
    // Early return guard: only allow movement if it's the local player's turn
    const isLocalPlayerTurn = this.playerStateService.isCurrentPlayer(
      this.gameState.currentPlayerIndex,
      this.gameState.players
    );
    if (!isLocalPlayerTurn) {
      return;
    }

    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    const currentPlayerId = currentPlayer?.id;
    if (!currentPlayerId) return;

    // Convert pointer position to world coordinates
    const worldPoint = this.scene.cameras.main.getWorldPoint(
      pointer.x,
      pointer.y
    );

    // Find the nearest milepost to the click that belongs to the current player
    const nearestMilepost = this.findNearestMilepostOnOwnTrack(
      worldPoint.x,
      worldPoint.y,
      currentPlayerId
    );

    if (nearestMilepost) {
      if (this.movementModeController.isInMovementMode()) {
        // If the player clicks the city they are already on, allow reopening the load dialog
        // without requiring a successful movement (distance 0 moves are typically rejected).
        if (
          this.isCity(nearestMilepost) &&
          this.isSamePoint(nearestMilepost, currentPlayer.trainState.position)
        ) {
          await this.handleCityArrival(currentPlayer, nearestMilepost);
          return;
        }

        // Store position before movement to verify movement actually succeeded
        const positionBeforeMovement = currentPlayer.trainState.position
          ? { ...currentPlayer.trainState.position }
          : null;
        
        await this.handleMovement(currentPlayer, nearestMilepost, pointer);

        // Re-fetch after async movement; socket patches can replace objects in `gameState.players`.
        const refreshedCurrentPlayer = this.gameState.players.find((p) => p.id === currentPlayerId);
        if (!refreshedCurrentPlayer) {
          return;
        }
        
        // Check if arrived at any city - only if movement actually succeeded
        // Verify: (1) destination is a city, (2) train position matches destination, 
        // and (3) position actually changed (movement was successful, preventing dialog 
        // from opening on failed moves)
        const positionAfterMovement = refreshedCurrentPlayer.trainState.position;
        // Movement succeeded if: train now has a position AND either:
        // - train didn't have a position before (first placement), OR
        // - position changed (train moved to a new location)
        const movementSucceeded = positionAfterMovement && 
          (!positionBeforeMovement || 
           !this.isSamePoint(positionBeforeMovement, positionAfterMovement));
        
        if (
          this.isCity(nearestMilepost) &&
          this.isSamePoint(nearestMilepost, positionAfterMovement) &&
          movementSucceeded
        ) {
          await this.handleCityArrival(refreshedCurrentPlayer, nearestMilepost);
        }
      }
    }
  }

  private isCity(gridPoint: GridPoint): boolean {
    return this.cityArrivalHandler.isCity(gridPoint);
  }

  private isSamePoint(point1: Point | null, point2: Point | null): boolean {
    return this.cityArrivalHandler.isSamePoint(point1, point2);
  }

  private async handleMovement(
    currentPlayer: Player,
    nearestMilepost: GridPoint,
    pointer: Phaser.Input.Pointer
  ): Promise<void> {
    await this.movementExecutor.executeMovement(
      currentPlayer,
      nearestMilepost,
      pointer
    );
  }

  private async handleCityArrival(
    currentPlayer: Player,
    nearestMilepost: GridPoint
  ): Promise<void> {
    await this.cityArrivalHandler.handleArrival(currentPlayer, nearestMilepost);
  }

  /**
   * Public method to trigger city arrival handling (e.g., for ferry-city arrivals at turn start).
   * Shows the load dialog if the player arrives at a city with loads available.
   */
  public async triggerCityArrival(player: Player, gridPoint: GridPoint): Promise<void> {
    if (this.cityArrivalHandler.isCity(gridPoint)) {
      await this.cityArrivalHandler.handleArrival(player, gridPoint);
    }
  }

  public async enterTrainMovementMode(): Promise<void> {
    await this.movementModeController.enterMovementMode();
  }

  private exitTrainMovementMode(): void {
    this.movementModeController.exitMovementMode();
  }

  public resetTrainMovementMode(): void {
    this.movementModeController.resetMovementMode();
  }

  public async updateTrainPosition(
    playerId: string,
    x: number,
    y: number,
    row: number,
    col: number,
    opts?: { persist?: boolean }
  ): Promise<void> {
    const playerBefore = this.gameState.players.find((p) => p.id === playerId);
    if (!playerBefore) return;

    // Initialize trainState if it doesn't exist
    if (!playerBefore.trainState) {
      playerBefore.trainState = {
        position: null,
        remainingMovement: 0,
        movementHistory: [],
        loads: [],
      };
    }

    const shouldPersist = opts?.persist !== false;
    if (shouldPersist && this.playerStateService.getLocalPlayerId() === playerId) {
      await this.playerStateService.updatePlayerPosition(x, y, row, col, this.gameState.id);
    }

    // Re-fetch player after potential socket patch / async call.
    const player = this.gameState.players.find((p) => p.id === playerId);
    if (!player) return;
    if (!player.trainState) {
      player.trainState = {
        position: null,
        remainingMovement: 0,
        movementHistory: [],
        loads: [],
      };
    }
    // Always set local position for rendering; server persistence already happened if enabled.
    player.trainState.position = { x, y, row, col };

    // Delegate sprite management to TrainSpriteManager
    this.trainSpriteManager.createOrUpdateSprite(playerId, x, y, row, col);

    // Update z-ordering and interactivity for all trains
    this.trainSpriteManager.updateZOrders();
    this.trainSpriteManager.updateInteractivity();
  }

  public updateTrainZOrders(): void {
    this.trainSpriteManager.updateZOrders();
  }

  /**
   * If a player's trainType changes (upgrade/crossgrade), update the existing pawn sprite texture.
   * This is safe to call on every gameState refresh.
   */
  public refreshTrainSpriteTextures(): void {
    this.trainSpriteManager.refreshTextures();
  }

  /**
   * Update train sprite interactivity based on whose turn it is
   * Only the local player's train should be interactive, and only when it's their turn
   */
  public updateTrainInteractivity(): void {
    this.trainSpriteManager.updateInteractivity();
  }

  public async initializePlayerTrain(
    playerId: string,
    startX: number,
    startY: number,
    startRow: number,
    startCol: number
  ): Promise<void> {
    await this.updateTrainPosition(
      playerId,
      startX,
      startY,
      startRow,
      startCol
    );
  }

  public setDrawingMode(isDrawing: boolean): void {
    this.movementModeController.setDrawingMode(isDrawing);
  }

  public setPlayerHandDisplay(playerHandDisplay: PlayerHandDisplay): void {
    this.playerHandDisplay = playerHandDisplay;
    this.cityArrivalHandler.setPlayerHandDisplay(playerHandDisplay);
  }

  public setHandContainer(container: Phaser.GameObjects.Container): void {
    this.handContainer = container;
    this.cityArrivalHandler.setHandContainer(container);
  }

  public setUIManager(uiManager: UIManager): void {
    this.uiManager = uiManager;
    this.cityArrivalHandler.setUIManager(uiManager);
    this.movementExecutor.setUIManager(uiManager);
  }

  public setTurnActionManager(turnActionManager: TurnActionManager): void {
    this.turnActionManager = turnActionManager;
    this.cityArrivalHandler.setTurnActionManager(turnActionManager);
    this.movementExecutor.setTurnActionManager(turnActionManager);
  }
}
