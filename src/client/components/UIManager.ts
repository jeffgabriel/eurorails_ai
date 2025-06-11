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
  private citySelectionManager!: CitySelectionManager;
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
    this.initializeComponentManagers();
  }

  private initializeComponentManagers(): void {
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

    // Initialize the leaderboard manager
    this.leaderboardManager = new LeaderboardManager(
      this.scene,
      this.gameState,
      this.nextPlayerCallback
    );

    // Initialize the player hand display
    this.playerHandDisplay = new PlayerHandDisplay(
      this.scene,
      this.gameState,
      this.toggleDrawingCallback
    );

    // Connect PlayerHandDisplay and UIManager to TrainInteractionManager
    this.trainInteractionManager.setPlayerHandDisplay(this.playerHandDisplay);
    this.trainInteractionManager.setHandContainer(this.playerHandContainer);
    this.trainInteractionManager.setUIManager(this);

    // Initialize the city selection manager
    this.citySelectionManager = new CitySelectionManager(
      this.scene,
      this.gameState,
      this.mapRenderer,
      (playerId, x, y, row, col) => this.trainInteractionManager.initializePlayerTrain(playerId, x, y, row, col)
    );

    
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
  }

  public setupPlayerHand(
    isDrawingMode: boolean = false,
    currentTrackCost: number = 0
  ): void {
    // Update the player hand display with the current container
    this.playerHandDisplay.update(isDrawingMode, currentTrackCost, this.playerHandContainer);
  }

  public cleanupCityDropdowns(): void {
    this.citySelectionManager.cleanupCityDropdowns();
  }

  public showCitySelectionForPlayer(playerId: string): void {
    this.citySelectionManager.showCitySelectionForPlayer(playerId);
  }
}