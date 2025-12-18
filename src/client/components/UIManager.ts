import "phaser";
import { GameState } from "../../shared/types/GameTypes";
import { GameStateService } from "../services/GameStateService";
import { MapRenderer } from "./MapRenderer";
import { TrainMovementManager } from "./TrainMovementManager";
import { TrainInteractionManager } from "./TrainInteractionManager";
import { LeaderboardManager } from "./LeaderboardManager";
import { PlayerHandDisplay } from "./PlayerHandDisplay";
import { CitySelectionManager } from "./CitySelectionManager";
import { TrackDrawingManager } from "./TrackDrawingManager";

export class UIManager {
  private scene: Phaser.Scene;
  private gameState: GameState;
  private uiContainer: Phaser.GameObjects.Container;
  private playerHandContainer: Phaser.GameObjects.Container;
  private trainContainer: Phaser.GameObjects.Container;
  private toggleDrawingCallback: () => void;
  private nextPlayerCallback: () => void;
  private openSettingsCallback: () => void;
  private gameStateService: GameStateService;
  private mapRenderer: MapRenderer;
  private trackDrawingManager: TrackDrawingManager;
  // Component managers
  private trainInteractionManager!: TrainInteractionManager;
  private leaderboardManager!: LeaderboardManager;
  private playerHandDisplay!: PlayerHandDisplay;
  //private citySelectionManager!: CitySelectionManager;
  private isDrawingMode: boolean = false;

  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    toggleDrawingCallback: () => void,
    nextPlayerCallback: () => void,
    openSettingsCallback: () => void,
    gameStateService: GameStateService,
    mapRenderer: MapRenderer,
    trackDrawingManager: TrackDrawingManager
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.toggleDrawingCallback = toggleDrawingCallback;
    this.nextPlayerCallback = nextPlayerCallback;
    this.openSettingsCallback = openSettingsCallback;
    this.gameStateService = gameStateService;
    this.mapRenderer = mapRenderer;
    this.trackDrawingManager = trackDrawingManager;
    // Create containers
    this.uiContainer = this.scene.add.container(0, 0);
    this.playerHandContainer = this.scene.add.container(0, 0);
    this.trainContainer = this.scene.add.container(0, 0);

    // Initialize component managers
    this.initializeComponentManagers(nextPlayerCallback);
  }

  public updateGameState(gameState: GameState): void {
    this.gameState = gameState;
    // Update component managers that need fresh gameState
    this.playerHandDisplay.updateGameState(gameState);
    // Turn changes can toggle whether the local player's train is interactive.
    // Ensure train clickability stays in sync without requiring a full refresh.
    this.trainInteractionManager.updateTrainZOrders();
    this.trainInteractionManager.refreshTrainSpriteTextures();
    this.trainInteractionManager.updateTrainInteractivity();
  }

  private initializeComponentManagers(nextPlayerCallback: () => void): void {
    // Create the train movement manager
    const trainMovementManager = new TrainMovementManager(this.gameState);
    
    // Initialize the train interaction manager
    this.trainInteractionManager = new TrainInteractionManager(
      this.scene,
      this.gameState,
      trainMovementManager,
      this.mapRenderer,
      this.gameStateService,
      this.trainContainer,
      this.trackDrawingManager
    );

    const UIManagedNextPlayerCallback = async () => {
      this.resetTrainMovementMode();
      this.cleanupCityDropdowns();
      await nextPlayerCallback();
      this.setupUIOverlay();
      this.trainInteractionManager.updateTrainZOrders();
      // Update train interactivity when turn changes
      this.trainInteractionManager.updateTrainInteractivity();
      try {
        await this.setupPlayerHand(this.trackDrawingManager.isInDrawingMode);
      } catch (error) {
        console.error('Error setting up player hand:', error);
      }

      const newPlayer =
        this.gameState.players[this.gameState.currentPlayerIndex];
      if (!newPlayer.trainState?.position) {
        this.showCitySelectionForPlayer(newPlayer.id);
      } else {
        const { x, y } = newPlayer.trainState.position;
        this.scene.cameras.main.pan(x, y, 1000, "Linear", true);
      }
    };

    // Initialize the leaderboard manager
    this.leaderboardManager = new LeaderboardManager(
      this.scene,
      this.gameState,
      UIManagedNextPlayerCallback,
      this.gameStateService
    );

    // Initialize the player hand display
    this.playerHandDisplay = new PlayerHandDisplay(
      this.scene,
      this.gameState,
      this.toggleDrawingCallback,
      () => {
        this.trackDrawingManager.undoLastSegment();
        // Refresh the hand display after undo
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const previousSessionsCost = this.trackDrawingManager.getPlayerTrackState(currentPlayer.id)?.turnBuildCost || 0;
        const currentSessionCost = this.trackDrawingManager.getCurrentTurnBuildCost();
        const totalCost = previousSessionsCost + currentSessionCost;
        this.setupPlayerHand(this.isDrawingMode, totalCost).catch(console.error);
      },
      () => this.trackDrawingManager.segmentsDrawnThisTurn.length > 0,
      this.mapRenderer,
      this.trainInteractionManager,
      this.trackDrawingManager,
      this.gameStateService
    );

    // Connect PlayerHandDisplay and UIManager to TrainInteractionManager
    this.trainInteractionManager.setPlayerHandDisplay(this.playerHandDisplay);
    this.trainInteractionManager.setHandContainer(this.playerHandContainer);
    this.trainInteractionManager.setUIManager(this);

    // // Initialize the city selection manager (after playerHandDisplay is created)
    // this.citySelectionManager = new CitySelectionManager(
    //   this.scene,
    //   this.gameState,
    //   this.mapRenderer,
    //   (playerId, x, y, row, col) => this.trainInteractionManager.initializePlayerTrain(playerId, x, y, row, col),
    //   () => this.playerHandDisplay.isHandCollapsed()
    // );
  }

  public getContainers(): {
    uiContainer: Phaser.GameObjects.Container;
    playerHandContainer: Phaser.GameObjects.Container;
    trainContainer: Phaser.GameObjects.Container;
  } {
    return {
      uiContainer: this.uiContainer,
      playerHandContainer: this.playerHandContainer,
      trainContainer: this.trainContainer,
    };
  }

  public setDrawingMode(isDrawing: boolean): void {
    this.isDrawingMode = isDrawing;
    this.trainInteractionManager.setDrawingMode(isDrawing);
  }

  public async updateTrainPosition(
    playerId: string,
    x: number,
    y: number,
    row: number,
    col: number
  ): Promise<void> {
    await this.trainInteractionManager.updateTrainPosition(
      playerId,
      x,
      y,
      row,
      col
    );
  }

  public async initializePlayerTrain(
    playerId: string,
    startX: number,
    startY: number,
    startRow: number,
    startCol: number
  ): Promise<void> {
    await this.trainInteractionManager.initializePlayerTrain(
      playerId,
      startX,
      startY,
      startRow,
      startCol
    );
  }

  public resetTrainMovementMode(): void {
    this.trainInteractionManager.resetTrainMovementMode();
  }

  public setupUIOverlay(): void {
    if (!this.gameState || !this.gameState.players || this.gameState.players.length === 0) {
      return;
    }

    // Reset train movement mode when UI is refreshed
    this.resetTrainMovementMode();

    // Clear UI container
    this.uiContainer.removeAll(true);
    
    // Update leaderboard directly on UI container
    this.leaderboardManager.update(this.uiContainer);
    
    // Update gameState in playerHandDisplay
    this.playerHandDisplay.updateGameState(this.gameState);
  }

  public async setupPlayerHand(
    isDrawingMode: boolean = false,
    currentTrackCost: number = 0
  ): Promise<void> {
    // Update gameState first
    this.playerHandDisplay.updateGameState(this.gameState);
    // Update the player hand display with the current container
    await this.playerHandDisplay.update(isDrawingMode, currentTrackCost, this.playerHandContainer);
  }

  public cleanupCityDropdowns(): void {
    //this.citySelectionManager.cleanupCityDropdowns();
  }

  public showCitySelectionForPlayer(playerId: string): void {
    //this.citySelectionManager.showCitySelectionForPlayer(playerId);
  }
}