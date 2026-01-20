import "phaser";
import { GameState } from "../../shared/types/GameTypes";
import { GameStateService } from "../services/GameStateService";
import { PlayerStateService } from "../services/PlayerStateService";
import { MapRenderer } from "./MapRenderer";
import { TrainInteractionManager } from "./TrainInteractionManager";
import { UI_FONT_FAMILY } from "../config/uiFont";
import { TrackDrawingManager } from "./TrackDrawingManager";
export class PlayerHandDisplay {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private gameState: GameState;
  private toggleDrawingCallback: () => void;
  private onUndo: () => void;
  private canUndo: () => boolean;
  private gameStateService: GameStateService | null = null;
  private playerStateService: PlayerStateService | null = null;
  private mapRenderer: MapRenderer;
  private trainInteractionManager: TrainInteractionManager;
  private trackDrawingManager: TrackDrawingManager;

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
    playerStateService?: PlayerStateService
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.toggleDrawingCallback = toggleDrawingCallback;
    this.onUndo = onUndo;
    this.canUndo = canUndo;
    this.gameStateService = gameStateService || null;
    this.playerStateService = playerStateService || null;
    this.mapRenderer = mapRenderer;
    this.trainInteractionManager = trainInteractionManager;
    this.trackDrawingManager = trackDrawingManager;
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
    const statusString = `${currentPlayer.name} | Money: ECU ${currentPlayer.money}M`;
    
    const statusText = this.scene.add
      .text(
        20,
        this.STATUS_BAR_HEIGHT / 2,
        statusString,
        {
          color: "#ffffff",
          fontSize: "18px",
          fontStyle: "bold",
          fontFamily: UI_FONT_FAMILY,
        }
      )
      .setOrigin(0, 0.5);

    statusBar.add(statusText);
    
    // Add debt indicator in red if player has debt (more visible)
    if (currentPlayer.debtOwed && currentPlayer.debtOwed > 0) {
      const debtText = this.scene.add
        .text(
          statusText.x + statusText.width + 10, // Position right after status text with a small gap
          this.STATUS_BAR_HEIGHT / 2,
          `| Debt: ECU ${currentPlayer.debtOwed}M`,
          {
            color: "#ef4444", // Red color for debt
            fontSize: "18px",
            fontStyle: "bold",
            fontFamily: UI_FONT_FAMILY,
          }
        )
        .setOrigin(0, 0.5);
      
      statusBar.add(debtText);
    }

    // Add Borrow Money button (only show on player's turn)
    const isPlayerTurn = this.gameState.currentPlayerIndex >= 0 &&
      this.gameState.players[this.gameState.currentPlayerIndex]?.id === currentPlayer.id;
    
    if (isPlayerTurn) {
      const borrowButtonX = this.scene.scale.width - 180;
      const borrowButtonY = this.STATUS_BAR_HEIGHT / 2;
      
      const borrowBg = this.scene.add.rectangle(
        borrowButtonX,
        borrowButtonY,
        140,
        30,
        0x22c55e,
        0.9
      );
      borrowBg.setInteractive({ useHandCursor: true });
      
      const borrowText = this.scene.add.text(
        borrowButtonX,
        borrowButtonY,
        '💰 Borrow Money',
        {
          color: "#ffffff",
          fontSize: "14px",
          fontStyle: "bold",
          fontFamily: UI_FONT_FAMILY,
        }
      ).setOrigin(0.5, 0.5);
      
      borrowBg.on('pointerover', () => borrowBg.setFillStyle(0x16a34a));
      borrowBg.on('pointerout', () => borrowBg.setFillStyle(0x22c55e));
      borrowBg.on('pointerdown', () => this.openBorrowMoneyDialog());
      
      statusBar.add([borrowBg, borrowText]);
    }
    
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

    hitArea.on("pointerdown", async () => {
      await this.toggleCollapse();
    });

    statusBar.add([toggleGraphics, hitArea]);

    // Make entire status bar clickable to expand
    statusBarBg.setInteractive({ useHandCursor: true });
    statusBarBg.on("pointerdown", async () => {
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

  private openBorrowMoneyDialog(): void {
    const localPlayer = this.playerStateService.getLocalPlayer();
    if (!localPlayer) {
      console.error('Cannot open borrow dialog: no local player');
      return;
    }

    // Launch the BorrowMoneyDialogScene
    this.scene.scene.launch('BorrowMoneyDialogScene', {
      player: localPlayer,
      gameState: this.gameState,
      playerStateService: this.playerStateService,
      onClose: () => {
        // Scene will stop itself
      },
      onSuccess: async () => {
        // Refresh the UI to show updated money and debt
        if (this.currentContainer) {
          await this.update(this.lastDrawingMode, this.lastTrackCost, this.currentContainer);
        }
        // Also update the train card to reflect new money
        this.updateTrainCardLoads();
      }
    });
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
