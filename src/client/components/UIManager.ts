import "phaser";
import { GameState } from "../../shared/types/GameTypes";
import { GameStateService } from "../services/GameStateService";
import { MapRenderer } from "./MapRenderer";
import { TrainMovementManager } from "./TrainMovementManager";
import { TrainInteractionManager } from "./TrainInteractionManager";
import { LeaderboardManager } from "./ui/LeaderboardManager";
import { PlayerHandDisplay } from "./ui/PlayerHandDisplay";
import { CitySelectionManager } from "./ui/CitySelectionManager";

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
  private isDrawingMode: boolean = false;
  
  // Component managers
  private trainInteractionManager: TrainInteractionManager;
  private leaderboardManager: LeaderboardManager;
  private playerHandDisplay: PlayerHandDisplay;
  private citySelectionManager: CitySelectionManager;

  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    toggleDrawingCallback: () => void,
    nextPlayerCallback: () => void,
    openSettingsCallback: () => void,
    gameStateService: GameStateService,
    mapRenderer: MapRenderer
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.toggleDrawingCallback = toggleDrawingCallback;
    this.nextPlayerCallback = nextPlayerCallback;
    this.openSettingsCallback = openSettingsCallback;
    this.gameStateService = gameStateService;
    this.mapRenderer = mapRenderer;

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
      this.trainContainer
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
    
    // Add settings button directly to UI container
    this.uiContainer.add(this.createSettingsButton());
    
    // Update leaderboard directly on UI container
    this.leaderboardManager.update(this.uiContainer);
  }

  private createSettingsButton(): Phaser.GameObjects.Container {
    const container = this.scene.add.container(0, 0);
    
    const LEADERBOARD_PADDING = 10;
    const settingsButton = this.scene.add
      .rectangle(
        LEADERBOARD_PADDING,
        LEADERBOARD_PADDING,
        40,
        40,
        0x444444,
        0.9
      )
      .setOrigin(0, 0);

    const settingsIcon = this.scene.add
      .text(LEADERBOARD_PADDING + 20, LEADERBOARD_PADDING + 20, "⚙️", {
        fontSize: "24px",
      })
      .setOrigin(0.5);

    settingsButton
      .setInteractive({ useHandCursor: true })
      .on("pointerdown", () => this.openSettingsCallback())
      .on("pointerover", () => settingsButton.setFillStyle(0x555555))
      .on("pointerout", () => settingsButton.setFillStyle(0x444444));
      
    container.add([settingsButton, settingsIcon]);
    return container;
  }

  public setupPlayerHand(
    isDrawingMode: boolean = false,
    currentTrackCost: number = 0
  ): void {
    // Pass the playerHandContainer directly to the update method
    this.playerHandDisplay.update(isDrawingMode, currentTrackCost, this.playerHandContainer);
  }

  public cleanupCityDropdowns(): void {
    this.citySelectionManager.cleanupCityDropdowns();
  }

  public showCitySelectionForPlayer(playerId: string): void {
    this.citySelectionManager.showCitySelectionForPlayer(playerId);
  }
}