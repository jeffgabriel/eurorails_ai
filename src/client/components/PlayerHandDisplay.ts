import "phaser";
import { GameState } from "../../shared/types/GameTypes";
import { GameStateService } from "../services/GameStateService";
import { MapRenderer } from "./MapRenderer";
import { TrainInteractionManager } from "./TrainInteractionManager";
import { UI_FONT_FAMILY } from "../config/uiFont";
import { TrackDrawingManager } from "./TrackDrawingManager";
import { CameraController } from "./CameraController";

export class PlayerHandDisplay {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private gameState: GameState;
  private toggleDrawingCallback: () => void;
  private onUndo: () => void;
  private canUndo: () => boolean;
  private gameStateService: GameStateService | null = null;
  private mapRenderer: MapRenderer;
  private trainInteractionManager: TrainInteractionManager;
  private trackDrawingManager: TrackDrawingManager;
  private cameraController?: CameraController;

  // Layout constants
  private readonly STATUS_BAR_HEIGHT = 50; // Height when collapsed

  // State management
  private isCollapsed: boolean = true; // Start collapsed
  private statusBarContainer: Phaser.GameObjects.Container | null = null;
  private currentContainer: Phaser.GameObjects.Container | null = null;
  private lastDrawingMode: boolean = false;
  private lastTrackCost: number = 0;

  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    toggleDrawingCallback: () => void,
    onUndo: () => void,
    canUndo: () => boolean,
    mapRenderer: MapRenderer,
    trainInteractionManager: TrainInteractionManager,
    trackDrawingManager: TrackDrawingManager,
    gameStateService?: GameStateService,
    cameraController?: CameraController
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.toggleDrawingCallback = toggleDrawingCallback;
    this.onUndo = onUndo;
    this.canUndo = canUndo;
    this.gameStateService = gameStateService || null;
    this.mapRenderer = mapRenderer;
    this.trainInteractionManager = trainInteractionManager;
    this.trackDrawingManager = trackDrawingManager;
    this.cameraController = cameraController;
    this.container = this.scene.add.container(0, 0);
  }

  public updateGameState(gameState: GameState): void {
    this.gameState = gameState;
    // Update scene if it's running
    const playerHandScene = this.scene.scene.get("PlayerHandScene");
    if (playerHandScene && playerHandScene.scene.isActive()) {
      this.updateSceneData(gameState, this.lastDrawingMode, this.lastTrackCost);
    }
  }

  public async update(
    isDrawingMode: boolean = false,
    currentTrackCost: number = 0,
    targetContainer: Phaser.GameObjects.Container
  ): Promise<void> {
    if (
      !this.gameState ||
      !this.gameState.players ||
      this.gameState.players.length === 0
    ) {
      return;
    }

    // Store current state
    this.lastDrawingMode = isDrawingMode;
    this.lastTrackCost = currentTrackCost;
    this.currentContainer = targetContainer;

    // Clear target container
    targetContainer.removeAll(true);

    // Always show status bar when collapsed
    if (this.isCollapsed) {
      this.createStatusBar(targetContainer);
      // Update the scene if it's running (shouldn't be, but just in case)
      const playerHandScene = this.scene.scene.get("PlayerHandScene");
      if (playerHandScene && playerHandScene.scene.isActive()) {
        this.scene.scene.stop("PlayerHandScene");
      }
    } else {
      // Launch the PlayerHandScene
      await this.launchPlayerHandScene(isDrawingMode, currentTrackCost);
    }
  }

  private async launchPlayerHandScene(
    isDrawingMode: boolean,
    currentTrackCost: number
  ): Promise<void> {
    // Check if scene exists, if not add it
    if (!this.scene.scene.manager.getScene("PlayerHandScene")) {
      const module = await import("../scenes/PlayerHandScene");
      const PlayerHandScene = module.PlayerHandScene;
      this.scene.scene.add("PlayerHandScene", PlayerHandScene);
    }

    const playerHandScene = this.scene.scene.get("PlayerHandScene");

    if (playerHandScene) {
      // If scene is already running, update it instead of launching again
      if (playerHandScene.scene.isActive()) {
        (playerHandScene as any).updateSceneData(
          this.gameState,
          isDrawingMode,
          currentTrackCost
        );
      } else {
        // Launch the scene with data
        this.scene.scene.launch("PlayerHandScene", {
          gameState: this.gameState,
          toggleDrawingCallback: this.toggleDrawingCallback,
          onUndo: this.onUndo,
          canUndo: this.canUndo,
          gameStateService: this.gameStateService!,
          mapRenderer: this.mapRenderer,
          trainInteractionManager: this.trainInteractionManager,
          trackDrawingManager: this.trackDrawingManager,
          isDrawingMode: isDrawingMode,
          currentTrackCost: currentTrackCost,
          onClose: () => {
            this.setCollapsed(true);
            // Update status bar
            if (this.currentContainer) {
              this.update(this.lastDrawingMode, this.lastTrackCost, this.currentContainer).catch(console.error);
            }
          },
        });
      }
    }
  }

  public async updateSceneData(
    gameState: GameState,
    isDrawingMode: boolean,
    currentTrackCost: number
  ): Promise<void> {
    this.gameState = gameState;
    this.lastDrawingMode = isDrawingMode;
    this.lastTrackCost = currentTrackCost;

    // Update the scene if it's running
    const playerHandScene = this.scene.scene.get("PlayerHandScene");
    if (playerHandScene && playerHandScene.scene.isActive()) {
      (playerHandScene as any).updateSceneData(
        gameState,
        isDrawingMode,
        currentTrackCost
      );
    }
  }

  private createStatusBar(targetContainer: Phaser.GameObjects.Container): void {
    if (!this.gameStateService) {
      return;
    }

    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const currentPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;

    if (!currentPlayer) {
      return;
    }

    // Create status bar container at bottom of screen
    const statusBarY = this.scene.scale.height - this.STATUS_BAR_HEIGHT;
    const statusBar = this.scene.add.container(0, statusBarY);
    targetContainer.add(statusBar);
    this.statusBarContainer = statusBar;

    // Create status bar background
    const statusBarBg = this.scene.add
      .rectangle(
        0,
        0,
        this.scene.scale.width,
        this.STATUS_BAR_HEIGHT,
        0x333333,
        0.8
      )
      .setOrigin(0, 0);

    statusBar.add(statusBarBg);

    // Add player name and money
    const statusText = this.scene.add
      .text(
        20,
        this.STATUS_BAR_HEIGHT / 2,
        `${currentPlayer.name} | Money: ECU ${currentPlayer.money}M`,
        {
          color: "#ffffff",
          fontSize: "18px",
          fontStyle: "bold",
          fontFamily: UI_FONT_FAMILY,
        }
      )
      .setOrigin(0, 0.5);

    statusBar.add(statusText);

    // Add mini train icon
    if (currentPlayer.trainType) {
      const trainType = currentPlayer.trainType
        .toLowerCase()
        .replace(/[\s_-]+/g, "");
      try {
        const miniTrain = this.scene.add.image(
          this.scene.scale.width - 60,
          this.STATUS_BAR_HEIGHT / 2,
          `train_card_${trainType}`
        );
        miniTrain.setScale(0.08);
        miniTrain.setOrigin(0.5, 0.5);
        statusBar.add(miniTrain);
      } catch (error) {
        console.warn("Could not load train icon for status bar:", error);
      }
    }

    // Add toggle button (up arrow to expand)
    const buttonX = this.scene.scale.width - 40;
    const buttonY = this.STATUS_BAR_HEIGHT / 2;

    const toggleGraphics = this.scene.add.graphics();
    const arrowSize = 15;
    const arrowColor = 0xffffff;

    toggleGraphics.lineStyle(3, arrowColor, 1);
    toggleGraphics.beginPath();
    toggleGraphics.moveTo(buttonX - arrowSize, buttonY + arrowSize / 2);
    toggleGraphics.lineTo(buttonX, buttonY - arrowSize / 2);
    toggleGraphics.lineTo(buttonX + arrowSize, buttonY + arrowSize / 2);
    toggleGraphics.strokePath();

    const hitArea = this.scene.add.rectangle(
      buttonX,
      buttonY,
      40,
      40,
      0x000000,
      0
    );
    hitArea.setInteractive({ useHandCursor: true });

    hitArea.on("pointerdown", async (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) {
        pointer.event.stopPropagation();
      }
      await this.toggleCollapse();
    });

    statusBar.add([toggleGraphics, hitArea]);

    // Make entire status bar clickable to expand
    statusBarBg.setInteractive({ useHandCursor: true });
    statusBarBg.on("pointerdown", async (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) {
        pointer.event.stopPropagation();
      }
      await this.toggleCollapse();
    });
  }

  private async toggleCollapse(): Promise<void> {
    this.isCollapsed = !this.isCollapsed;

    // Update display
    if (this.currentContainer) {
      await this.update(this.lastDrawingMode, this.lastTrackCost, this.currentContainer);
    }
  }

  public setCollapsed(collapsed: boolean): void {
    this.isCollapsed = collapsed;
  }

  public isHandCollapsed(): boolean {
    return this.isCollapsed;
  }

  public updateTrainCardLoads(): void {
    // Update train card in the scene if it's running
    const playerHandScene = this.scene.scene.get("PlayerHandScene");
    if (playerHandScene && playerHandScene.scene.isActive()) {
      (playerHandScene as any).updateTrainCardLoads();
    }
  }

  public destroy(): void {
    // Stop the scene if it's running
    const playerHandScene = this.scene.scene.get("PlayerHandScene");
    if (playerHandScene && playerHandScene.scene.isActive()) {
      this.scene.scene.stop("PlayerHandScene");
    }
    if (this.container) {
      this.container.destroy();
    }
  }
}
