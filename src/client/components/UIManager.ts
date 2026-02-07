import "phaser";
import { GameState, GridPoint, Player } from "../../shared/types/GameTypes";
import { GameStateService } from "../services/GameStateService";
import { MapRenderer } from "./MapRenderer";
import { TrainMovementManager } from "./TrainMovementManager";
import { TrainInteractionManager } from "./TrainInteractionManager";
import { LeaderboardManager } from "./LeaderboardManager";
import { PlayerHandDisplay } from "./PlayerHandDisplay";
import { CitySelectionManager } from "./CitySelectionManager";
import { TrackDrawingManager } from "./TrackDrawingManager";
import { UI_FONT_FAMILY } from "../config/uiFont";
import { TurnActionManager } from "./TurnActionManager";
import { PlayerStateService } from "../services/PlayerStateService";
import { LoadService } from "../services/LoadService";

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
  private turnActionManager!: TurnActionManager;
  private playerStateService: PlayerStateService;
  // Component managers
  private trainInteractionManager!: TrainInteractionManager;
  private leaderboardManager!: LeaderboardManager;
  private playerHandDisplay!: PlayerHandDisplay;
  //private citySelectionManager!: CitySelectionManager;
  private isDrawingMode: boolean = false;
  private handToastContainer: Phaser.GameObjects.Container | null = null;

  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    toggleDrawingCallback: () => void,
    nextPlayerCallback: () => void,
    openSettingsCallback: () => void,
    gameStateService: GameStateService,
    mapRenderer: MapRenderer,
    trackDrawingManager: TrackDrawingManager,
    playerStateService?: PlayerStateService
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.toggleDrawingCallback = toggleDrawingCallback;
    this.nextPlayerCallback = nextPlayerCallback;
    this.openSettingsCallback = openSettingsCallback;
    this.gameStateService = gameStateService;
    this.mapRenderer = mapRenderer;
    this.trackDrawingManager = trackDrawingManager;
    // IMPORTANT: Use a shared PlayerStateService instance so local-only state (like hand)
    // stays consistent across UI + dialogs. If not provided, fall back to creating one.
    this.playerStateService = playerStateService ?? new PlayerStateService();
    this.playerStateService.initializeLocalPlayer(this.gameState.players);
    // Create containers
    this.uiContainer = this.scene.add.container(0, 0);
    this.playerHandContainer = this.scene.add.container(0, 0);
    this.trainContainer = this.scene.add.container(0, 0);

    // Initialize component managers
    this.initializeComponentManagers(nextPlayerCallback);
  }

  public updateGameState(gameState: GameState): void {
    this.gameState = gameState;
    this.playerStateService.updateLocalPlayer(this.gameState.players);
    // Update component managers that need fresh gameState
    this.playerHandDisplay.updateGameState(gameState);
    // Turn changes can toggle whether the local player's train is interactive.
    // Ensure train clickability stays in sync without requiring a full refresh.
    this.trainInteractionManager.updateTrainZOrders();
    this.trainInteractionManager.refreshTrainSpriteTextures();
    this.trainInteractionManager.updateTrainInteractivity();
  }

  public clearTurnUndoStack(): void {
    this.turnActionManager?.clear();
  }

  /**
   * Show a bottom-center toast near the player's hand area.
   * Prefers `PlayerHandScene`'s toast styling if that scene is active; otherwise
   * falls back to rendering a similar toast directly on the main scene.
   */
  public showHandToast(message: string): void {
    try {
      const playerHandScene = this.scene.scene.get("PlayerHandScene") as any;
      if (playerHandScene && playerHandScene.scene?.isActive?.() && typeof playerHandScene.showHandToast === "function") {
        playerHandScene.showHandToast(message);
        return;
      }
    } catch (e) {
      // Ignore and fall back
    }

    // Fallback: render on the main scene (so it still appears even when the hand is collapsed)
    try {
      if (this.handToastContainer) {
        this.handToastContainer.destroy(true);
        this.handToastContainer = null;
      }

      const paddingX = 16;
      const paddingY = 10;
      const maxWidth = Math.min(520, this.scene.scale.width - 40);

      const text = this.scene.add.text(0, 0, message, {
        color: "#ffffff",
        fontSize: "16px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        wordWrap: { width: maxWidth - paddingX * 2, useAdvancedWrap: true },
        align: "center",
      }).setOrigin(0.5);

      const bgW = Math.min(maxWidth, text.width + paddingX * 2);
      const bgH = text.height + paddingY * 2;

      // Prefer RexUI rounded rectangle if available; otherwise use a plain rectangle.
      let bg: Phaser.GameObjects.GameObject;
      const rexUI = (this.scene as any).rexUI;
      if (rexUI?.add?.roundRectangle) {
        bg = rexUI.add.roundRectangle({
          width: bgW,
          height: bgH,
          color: 0x111111,
          alpha: 0.92,
          radius: 10,
        });
      } else {
        bg = this.scene.add.rectangle(0, 0, bgW, bgH, 0x111111, 0.92).setOrigin(0.5);
      }

      // Match PlayerHandScene positioning: centered, just above the hand UI area.
      const HAND_HEIGHT_BASE = 280;
      const container = this.scene.add.container(
        this.scene.scale.width / 2,
        this.scene.scale.height - HAND_HEIGHT_BASE - 24
      );
      container.setDepth(2500);
      container.add([bg as any, text]);
      (text as any).setPosition(0, 0);
      (bg as any).setPosition(0, 0);

      this.handToastContainer = container;

      this.scene.tweens.add({
        targets: container,
        alpha: 0,
        duration: 1200,
        delay: 1600,
        ease: "Power2",
        onComplete: () => {
          container.destroy(true);
          if (this.handToastContainer === container) {
            this.handToastContainer = null;
          }
        },
      });
    } catch (e) {
      // Toast is non-critical
    }
  }

  /**
   * Confirm using opponent track for a per-opponent fee.
   * Renders a simple blocking modal on the main scene.
   */
  public async confirmOpponentTrackFee(args: {
    payees: Array<{ name: string; amount: number }>;
    total: number;
  }): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const { payees, total } = args;
      const modalRoot = this.scene.add.container(0, 0).setDepth(3000);

      const backdrop = this.scene.add.rectangle(
        this.scene.scale.width / 2,
        this.scene.scale.height / 2,
        this.scene.scale.width,
        this.scene.scale.height,
        0x000000,
        0.55
      );
      backdrop.setInteractive(); // blocks clicks behind modal
      modalRoot.add(backdrop);

      const panelW = Math.min(520, this.scene.scale.width - 60);
      const panelH = 200;
      const panelX = this.scene.scale.width / 2;
      const panelY = this.scene.scale.height / 2;

      const panelBg = this.scene.add.rectangle(panelX, panelY, panelW, panelH, 0x111111, 0.95);
      const panelBorder = this.scene.add.rectangle(panelX, panelY, panelW + 4, panelH + 4, 0xffffff, 0.12);
      modalRoot.add([panelBorder, panelBg]);

      const title = this.scene.add.text(panelX, panelY - 70, "Use another player’s track for ECU 4M each?", {
        color: "#ffffff",
        fontSize: "16px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        align: "center",
        wordWrap: { width: panelW - 40, useAdvancedWrap: true },
      }).setOrigin(0.5, 0.5);

      const detailLines =
        payees.length > 0
          ? `${payees.map((p) => `${p.name} (${p.amount}M)`).join(", ")}\nTotal: ${total}M`
          : `Total: ${total}M`;
      const detail = this.scene.add.text(panelX, panelY - 20, detailLines, {
        color: "#dddddd",
        fontSize: "14px",
        fontFamily: UI_FONT_FAMILY,
        align: "center",
        wordWrap: { width: panelW - 40, useAdvancedWrap: true },
      }).setOrigin(0.5, 0.5);

      const buttonY = panelY + 55;
      const buttonW = 140;
      const buttonH = 36;
      const gap = 18;

      const makeButton = (x: number, label: string, bgColor: number, onClick: () => void) => {
        const bg = this.scene.add.rectangle(x, buttonY, buttonW, buttonH, bgColor, 1).setOrigin(0.5);
        bg.setStrokeStyle(1, 0xffffff, 0.18);
        const text = this.scene.add.text(x, buttonY, label, {
          color: "#ffffff",
          fontSize: "14px",
          fontStyle: "bold",
          fontFamily: UI_FONT_FAMILY,
        }).setOrigin(0.5);
        bg.setInteractive({ useHandCursor: true }).on("pointerdown", onClick);
        modalRoot.add([bg, text]);
      };

      const cleanup = (result: boolean) => {
        try {
          modalRoot.destroy(true);
        } catch {}
        resolve(result);
      };

      const cancelX = panelX - (buttonW / 2 + gap / 2);
      const acceptX = panelX + (buttonW / 2 + gap / 2);
      makeButton(cancelX, "Cancel", 0x444444, () => cleanup(false));
      makeButton(acceptX, "Accept", 0x1f6feb, () => cleanup(true));

      modalRoot.add([title, detail]);
    });
  }

  private initializeComponentManagers(nextPlayerCallback: () => void): void {
    // Per-turn undo stack (in-memory only)
    this.turnActionManager = new TurnActionManager({
      gameState: this.gameState,
      trackDrawingManager: this.trackDrawingManager,
      playerStateService: this.playerStateService,
      loadService: LoadService.getInstance(),
    });

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
      this.trackDrawingManager,
      this.turnActionManager,
      this.playerStateService
    );
    this.turnActionManager.setTrainPositionUpdater(this.trainInteractionManager);

    const UIManagedNextPlayerCallback = async () => {
      this.resetTrainMovementMode();
      this.cleanupCityDropdowns();
      await nextPlayerCallback();
      this.clearTurnUndoStack();
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
        // Only the local player should see the city selection prompt for their own train placement.
        if (this.playerStateService.getLocalPlayerId() === newPlayer.id) {
          this.showCitySelectionForPlayer(newPlayer.id);
        }
      }
    };

    // Initialize the leaderboard manager
    this.leaderboardManager = new LeaderboardManager(
      this.scene,
      this.gameState,
      UIManagedNextPlayerCallback,
      this.gameStateService,
      () => (this.scene as any).toggleChat?.()
    );

    // Initialize the player hand display
    this.playerHandDisplay = new PlayerHandDisplay(
      this.scene,
      this.gameState,
      this.toggleDrawingCallback,
      () => {
        this.handleUndo().catch(console.error);
      },
      () => this.turnActionManager.canUndo(),
      this.mapRenderer,
      this.trainInteractionManager,
      this.trackDrawingManager,
      this.gameStateService
    );

    // Record track segments immediately when they are built (uncommitted),
    // then mark them committed after a successful save. This preserves strict action ordering.
    this.trackDrawingManager.setOnTrackSegmentAdded?.((segment) => {
      const isLocalPlayerTurn = this.playerStateService.isCurrentPlayer(
        this.gameState.currentPlayerIndex,
        this.gameState.players
      );
      if (!isLocalPlayerTurn) return;
      this.turnActionManager.recordTrackSegmentBuilt(segment);
      this.refreshPlayerHand().catch(console.error);
    });
    this.trackDrawingManager.setOnTrackSegmentsCommitted?.((segments) => {
      const isLocalPlayerTurn = this.playerStateService.isCurrentPlayer(
        this.gameState.currentPlayerIndex,
        this.gameState.players
      );
      if (!isLocalPlayerTurn) return;
      this.turnActionManager.markLastUncommittedTrackSegmentsCommitted(segments.length);
    });

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

  private async handleUndo(): Promise<void> {
    const undone = await this.turnActionManager.undoLastAction();
    if (!undone) return;
    await this.refreshPlayerHand();
  }

  private async refreshPlayerHand(): Promise<void> {
    const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
    const previousSessionsCost =
      this.trackDrawingManager.getPlayerTrackState(currentPlayer.id)?.turnBuildCost || 0;
    const currentSessionCost = this.trackDrawingManager.getCurrentTurnBuildCost();
    const totalCost = previousSessionsCost + currentSessionCost;
    await this.setupPlayerHand(this.trackDrawingManager.isInDrawingMode, totalCost);
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
    col: number,
    opts?: { persist?: boolean }
  ): Promise<void> {
    await this.trainInteractionManager.updateTrainPosition(
      playerId,
      x,
      y,
      row,
      col,
      opts
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

  /**
   * Trigger city arrival handling for a player at a grid point.
   * Used for ferry-city arrivals (Dublin/Belfast) at turn start.
   */
  public async triggerCityArrival(player: Player, gridPoint: GridPoint): Promise<void> {
    await this.trainInteractionManager.triggerCityArrival(player, gridPoint);
  }

  public setupUIOverlay(): void {
    if (!this.gameState || !this.gameState.players || this.gameState.players.length === 0) {
      return;
    }

    // NOTE: Do NOT reset train movement mode here - setupUIOverlay is called after every
    // socket patch, including after moves. Movement mode should only reset on turn change
    // (handled in UIManagedNextPlayerCallback) or when entering drawing mode.

    // Clear UI container
    this.uiContainer.removeAll(true);

    // Update leaderboard directly on UI container
    this.leaderboardManager.update(this.uiContainer);

    // Add Final Round banner if victory has been triggered
    this.createFinalRoundBanner();

    // Update gameState in playerHandDisplay
    this.playerHandDisplay.updateGameState(this.gameState);
  }

  /**
   * Create a persistent Final Round banner at the top center of the screen
   * Only displayed when victory has been triggered
   */
  private createFinalRoundBanner(): void {
    if (!this.gameState.victoryState?.triggered) {
      return;
    }

    const triggerPlayerIndex = this.gameState.victoryState.triggerPlayerIndex;
    const finalTurnPlayerIndex = this.gameState.victoryState.finalTurnPlayerIndex;
    const currentPlayerIndex = this.gameState.currentPlayerIndex;
    const playerCount = this.gameState.players.length;

    // Calculate turns remaining
    let turnsRemaining = 0;
    if (finalTurnPlayerIndex >= 0) {
      if (currentPlayerIndex === triggerPlayerIndex) {
        // We've cycled back to trigger player - game should have ended
        turnsRemaining = 0;
      } else {
        // Count forward from current player to final turn player (inclusive)
        let idx = currentPlayerIndex;
        while (idx !== finalTurnPlayerIndex) {
          turnsRemaining++;
          idx = (idx + 1) % playerCount;
        }
        turnsRemaining++; // Include the final turn itself
      }
    }

    // Determine the detail message
    let detailMessage: string;
    if (turnsRemaining === 0) {
      detailMessage = "Game ending...";
    } else if (turnsRemaining === 1) {
      detailMessage = "This is the last turn!";
    } else {
      detailMessage = `${turnsRemaining} turns remaining`;
    }

    // Position at top center of the screen
    const centerX = this.scene.scale.width / 2;
    const bannerY = 15;

    // Create banner container
    const bannerContainer = this.scene.add.container(centerX, bannerY);

    // Create text first to measure width
    const titleText = this.scene.add.text(0, 0, "⚠️ FINAL ROUND ⚠️", {
      color: "#ffffff",
      fontSize: "18px",
      fontStyle: "bold",
      fontFamily: UI_FONT_FAMILY,
      align: "center",
    }).setOrigin(0.5, 0);

    const detailText = this.scene.add.text(0, 22, detailMessage, {
      color: "#ffeeaa",
      fontSize: "14px",
      fontFamily: UI_FONT_FAMILY,
      align: "center",
    }).setOrigin(0.5, 0);

    // Calculate banner size based on text
    const maxTextWidth = Math.max(titleText.width, detailText.width);
    const bannerWidth = maxTextWidth + 40;
    const bannerHeight = 50;

    // Border (drawn first, behind everything)
    const border = this.scene.add.rectangle(0, bannerHeight / 2, bannerWidth + 4, bannerHeight + 4, 0xffaa00, 1)
      .setOrigin(0.5, 0.5);

    // Background
    const bg = this.scene.add.rectangle(0, bannerHeight / 2, bannerWidth, bannerHeight, 0xcc3300, 0.95)
      .setOrigin(0.5, 0.5);

    // Add elements to container (order matters for layering)
    bannerContainer.add([border, bg, titleText, detailText]);

    // Adjust text positions within the banner
    titleText.setY(6);
    detailText.setY(28);

    // Add to UI container so it's part of the fixed UI layer
    this.uiContainer.add(bannerContainer);
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