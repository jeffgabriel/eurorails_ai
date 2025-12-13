import "phaser";
import { GameState } from "../../shared/types/GameTypes";
import { TrainCard } from "../components/TrainCard";
import { DemandCard } from "../components/DemandCard";
import { GameStateService } from "../services/GameStateService";
import { CitySelectionManager } from "../components/CitySelectionManager";
import { MapRenderer } from "../components/MapRenderer";
import { TrainInteractionManager } from "../components/TrainInteractionManager";

interface PlayerHandSceneData {
  gameState: GameState;
  toggleDrawingCallback: () => void;
  onUndo: () => void;
  canUndo: () => boolean;
  gameStateService: GameStateService;
  mapRenderer: MapRenderer;
  trainInteractionManager: TrainInteractionManager;
  isDrawingMode: boolean;
  currentTrackCost: number;
  onClose: () => void;
}

const colorMap: { [key: string]: string } = {
  "#FFD700": "yellow",
  "#FF0000": "red",
  "#0000FF": "blue",
  "#000000": "black",
  "#008000": "green",
  "#8B4513": "brown",
};
const MAX_TURN_BUILD_COST = 20;
const COST_COLOR = "#ffffff";

export class PlayerHandScene extends Phaser.Scene {
  private gameState!: GameState;
  private toggleDrawingCallback!: () => void;
  private onUndo!: () => void;
  private canUndo!: () => boolean;
  private gameStateService!: GameStateService;
  private mapRenderer!: MapRenderer;
  private trainInteractionManager!: TrainInteractionManager;
  private isDrawingMode: boolean = false;
  private currentTrackCost: number = 0;
  private onCloseCallback!: () => void;

  // UI elements
  private trainCard: TrainCard | null = null;
  private cards: DemandCard[] = [];
  private citySelectionManager: CitySelectionManager | null = null;
  private background: Phaser.GameObjects.Rectangle | null = null;
  private rootSizer: any | null = null;
  private cardsSizer: any | null = null;
  private infoSizer: any | null = null;
  private controlsSizer: any | null = null;
  private nameAndMoneyText: Phaser.GameObjects.Text | null = null;
  private buildCostText: Phaser.GameObjects.Text | null = null;
  private crayonButtonImage: Phaser.GameObjects.Image | null = null;
  private crayonHighlightCircle: Phaser.GameObjects.Arc | null = null;
  private lastCurrentPlayerIndex: number | null = null;
  private lastIsLocalPlayerActive: boolean | null = null;
  private lastCanUndo: boolean | null = null;

  // Card dimensions
  private readonly CARD_WIDTH = 170;
  private readonly CARD_HEIGHT = 255;
  private readonly CARD_SPACING_HORIZONTAL = 20;

  // Layout constants
  private readonly HAND_HEIGHT_BASE = 280;

  constructor() {
    super({ key: "PlayerHandScene" });
  }

  init(data: PlayerHandSceneData) {
    this.gameState = data.gameState;
    this.toggleDrawingCallback = data.toggleDrawingCallback;
    this.onUndo = data.onUndo;
    this.canUndo = data.canUndo;
    this.gameStateService = data.gameStateService;
    this.mapRenderer = data.mapRenderer;
    this.trainInteractionManager = data.trainInteractionManager;
    this.isDrawingMode = data.isDrawingMode;
    this.currentTrackCost = data.currentTrackCost;
    this.onCloseCallback = data.onClose;
  }

  create() {
    // Create the UI (which adds to rootContainer)
    this.createUI();
    // Set camera to not scroll
    this.cameras.main.setScroll(0, 0);
  }

  public updateTrainCardLoads(): void {
    if (!this.trainCard) return;
    this.trainCard.updateLoads();
    this.rootSizer?.layout?.();
  }


  updateSceneData(
    gameState: GameState,
    isDrawingMode: boolean,
    currentTrackCost: number
  ) {
    this.gameState = gameState;
    this.isDrawingMode = isDrawingMode;
    this.currentTrackCost = currentTrackCost;

    const isLocalPlayerActive =
      this.gameStateService?.isLocalPlayerActive?.() ?? false;
    const canUndoNow = this.canUndo ? this.canUndo() : false;
    const currentPlayerIndex = this.gameState.currentPlayerIndex ?? 0;

    const needsFullRefresh =
      !this.rootSizer ||
      this.lastCurrentPlayerIndex === null ||
      this.lastIsLocalPlayerActive === null ||
      this.lastCanUndo === null ||
      this.lastCurrentPlayerIndex !== currentPlayerIndex ||
      this.lastIsLocalPlayerActive !== isLocalPlayerActive ||
      this.lastCanUndo !== canUndoNow;

    // Turn changes and permission changes affect which controls render (undo button,
    // active-player alpha/interactive state, etc.). Those are easiest to keep correct
    // via a non-animated rebuild.
    if (needsFullRefresh) {
      this.createUI({ animate: false });
      this.lastCurrentPlayerIndex = currentPlayerIndex;
      this.lastIsLocalPlayerActive = isLocalPlayerActive;
      this.lastCanUndo = canUndoNow;
      return;
    }

    // Small updates (cost, draw-mode highlight, money text) can update in-place.
    this.refreshDynamicUI();
  }

  private getBuildCostDisplay(currentPlayer: any): { text: string; color: string } {
    let costWarning = "";
    let costColor = COST_COLOR;

    if (this.currentTrackCost > currentPlayer.money) {
      costColor = "#ff4444";
      costWarning = " (Insufficient funds!)";
    } else if (this.currentTrackCost > MAX_TURN_BUILD_COST) {
      costColor = "#ff8800";
      costWarning = " (Over turn limit!)";
    } else if (this.currentTrackCost >= MAX_TURN_BUILD_COST * 0.8) {
      costColor = "#ffff00";
    }

    return {
      text: `Build Cost: ${this.currentTrackCost}M${costWarning}`,
      color: costColor,
    };
  }

  private refreshDynamicUI(): void {
    const currentPlayer = this.gameStateService.getCurrentPlayer();
    if (!currentPlayer) return;

    // Update name/money if it changed
    if (this.nameAndMoneyText) {
      this.nameAndMoneyText.setText(
        `${currentPlayer.name}\nMoney: ECU ${currentPlayer.money}M`
      );
    }

    // Update build cost text + color
    if (this.buildCostText) {
      const display = this.getBuildCostDisplay(currentPlayer);
      this.buildCostText.setText(display.text);
      this.buildCostText.setColor(display.color);
    }

    // Update crayon drawing mode visuals without recreating the whole UI.
    if (this.crayonButtonImage) {
      this.crayonButtonImage.setScale(this.isDrawingMode ? 0.18 : 0.15);
    }
    if (this.crayonHighlightCircle) {
      this.crayonHighlightCircle.setVisible(this.isDrawingMode);
    }

    // Re-layout once (text size can change)
    this.rootSizer?.layout?.();
  }

  private createUI(options: { animate?: boolean } = {}) {
    const { animate = true } = options;
    if (this.rootSizer) {
      // Ensure we fully reset old layout (RexUI doesn't auto-heal after removals)
      this.destroyUI();
    }
    //overall rexUI.sizer which contains all the UI elements in the player hand scene
    this.rootSizer = (this as any).rexUI.add
      .sizer({
        width: this.scale.width,
        height: this.HAND_HEIGHT_BASE,
        orientation: "x",
        align: "center",
        // Keep root positioning simple and explicit; children are sizer-positioned.
        space: { left: 6, right: 6, top: 6, bottom: 6, item: 6 },
      })
      // Start position: off-screen if animating, otherwise go straight to final.
      .setPosition(this.scale.width / 2, this.scale.height)
      .setName(`root-sizer`);

    // Give the background an explicit size so it always fills the bar.
    this.rootSizer.addBackground(
      (this as any).rexUI.add.roundRectangle({
        width: this.scale.width,
        height: this.HAND_HEIGHT_BASE,
        color: 0x333333,
        alpha: 0.8,
      })
    );
    // Root horizontal layout: [cards region] [train] [player info] [controls]
    this.createDemandCardSection();
    this.createTrainSection();
    this.createPlayerInfoSection();
    this.createControlsSection();

    this.rootSizer.layout();
    // RexUI sizers are positioned by their center; anchor bottom flush.
    const rootHeight =
      (typeof this.rootSizer.height === "number" && this.rootSizer.height > 0)
        ? this.rootSizer.height
        : this.HAND_HEIGHT_BASE;
    const finalY = this.scale.height - rootHeight / 2;

    if (animate) {
      // Slide in animation - animate container up to visible position
      this.tweens.add({
        targets: this.rootSizer,
        y: finalY,
        duration: 300,
        ease: "Power2",
        onComplete: () => {
          this.refreshTrainCardLoadsAfterLayout();
        },
      });
    } else {
      this.rootSizer.setY(finalY);
      this.refreshTrainCardLoadsAfterLayout();
    }
  }

  private refreshTrainCardLoadsAfterLayout(): void {
    // When the hand is reopened, TrainCard containers may not have stable transforms
    // until after the slide-in/layout pass. Defer one tick to avoid NaN positions.
    this.time.delayedCall(0, () => {
      if (!this.trainCard || !this.rootSizer) return;
      this.trainCard.updateLoads();
      this.rootSizer.layout();
    });
  }

  private createDemandCardSection(): void {
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const currentPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;

    if (!currentPlayer) {
      return;
    }

    // Clear existing cards
    this.cards.forEach((card) => {
      if (card) card.destroy();
    });
    this.cards = [];

    if (currentPlayer.hand.length === 0) {
      console.warn(`Player ${currentPlayer.name} has no cards in hand.`);
    }

    const maxCards = 3;
    const cardsToShow = Math.max(currentPlayer.hand.length, maxCards);

    // Cards region is its own sizer so rootSizer has stable child footprints.
    // (Do NOT add cards directly to rootSizer if you want them grouped.)
    this.cardsSizer = (this as any).rexUI.add
      .sizer({
        orientation: "x",
        space: { item: this.CARD_SPACING_HORIZONTAL },
      })
      .setName("demand-cards-sizer");

    for (let i = 0; i < cardsToShow; i++) {
      const card =
        i < currentPlayer.hand.length ? currentPlayer.hand[i] : undefined;
      const demandCard = new DemandCard(this, 0, 0, card);
      this.cardsSizer.add(demandCard, {
        proportion: 0,
        align: "center",
        padding: 0,
        expand: false,
      });
      this.cards.push(demandCard);
    }

    // Keep cards as a natural-width block so train/info sit immediately after it.
    this.rootSizer.add(this.cardsSizer, {
      proportion: 0,
      align: "center",
      padding: { left: 8, right: 8 },
      expand: false,
    });
  }

  private createTrainSection(): void {
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const currentPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;

    if (!currentPlayer) {
      return;
    }

    if (!currentPlayer.trainType) {
      currentPlayer.trainType = "freight" as any;
    }

    try {
      // Clean up old train card
      if (this.trainCard) {
        this.trainCard.destroy();
        this.trainCard = null;
      }

      // Create train card directly in scene
      this.trainCard = new TrainCard(
        this,
        0,
        0,
        currentPlayer
      );
      // Add the ContainerLite itself; it has an explicit size (TrainCard sets it).
      this.rootSizer.add(this.trainCard.getContainer(), {
        proportion: 0,
        align: "center",
        padding: { left: 6, right: 6 },
        expand: false,
      });
    } catch (error) {
      console.error("Failed to create train card:", error);
    }
  }

  private createPlayerInfoSection(): void {
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const currentPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;

    if (!currentPlayer) {
      return;
    }

    // Player info must be a Sizer (not a ContainerLite) because we want vertical layout.
    this.infoSizer = (this as any).rexUI.add
      .sizer({
        orientation: "y",
        space: { item: 8 },
      })
      .setName("player-info-sizer");

    this.createCitySelectionSection(this.infoSizer);
    this.createNameAndMoneySection(this.infoSizer);
    this.createBuildCostSection(this.infoSizer);

    this.rootSizer.add(this.infoSizer, {
      proportion: 0,
      align: "center",
      padding: { left: 10, right: 10 },
      expand: false,
    });
  }

  private createCitySelectionSection(parentSizer: any): void {
    // Only create CitySelectionManager if player needs to select a city
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const currentPlayer = this.gameStateService.getCurrentPlayer();
    if (!currentPlayer) {
      return;
    }
    const shouldShowCitySelection =
      localPlayerId &&
      currentPlayer.id === localPlayerId &&
      !currentPlayer.trainState?.position;
    if (shouldShowCitySelection) {
      this.citySelectionManager = new CitySelectionManager(
        this,
        this.gameState,
        this.mapRenderer,
        (playerId, x, y, row, col) =>
          this.trainInteractionManager.initializePlayerTrain(
            playerId,
            x,
            y,
            row,
            col
          ),
        () => false // Always return false since we're in expanded view
      );

      // Only proceed if CitySelectionManager was properly created
      if (this.citySelectionManager) {
        this.citySelectionManager.init();
        // Give it a stable footprint so the infoSizer can measure it.
        (this.citySelectionManager as any).setMinSize?.(220, 32);
        (this.citySelectionManager as any).setSize?.(220, 32);

        parentSizer.add(this.citySelectionManager, {
          proportion: 0,
          align: "center",
          padding: 0,
          expand: false,
        });
      }
    }
  }

  private createNameAndMoneySection(parentSizer: any): void {
    const currentPlayer = this.gameStateService.getCurrentPlayer();
    if (!currentPlayer) {
      return;
    }

    const playerInfoText = `${currentPlayer.name}\nMoney: ECU ${currentPlayer.money}M`;
    const nameAndMoney = this.add
      .text(0, 0, playerInfoText, {
        color: "#ffffff",
        fontSize: "20px",
        fontStyle: "bold",
        align: "center",
        wordWrap: { width: 280, useAdvancedWrap: true },
      })
      .setName(`name-and-money-text`);
    this.nameAndMoneyText = nameAndMoney;

    parentSizer.add(nameAndMoney, {
      proportion: 0,
      align: "center",
      padding: 0,
      expand: false,
    });
  }

  private createBuildCostSection(parentSizer: any): void {
    const currentPlayer = this.gameStateService.getCurrentPlayer();
    if (!currentPlayer) {
      return;
    }
    const display = this.getBuildCostDisplay(currentPlayer);
    const buildCostText = this.add
      .text(0, 0, display.text, {
        color: display.color,
        fontSize: "20px",
        fontStyle: "bold",
        align: "center",
        wordWrap: { width: 280, useAdvancedWrap: true },
      })
      .setName(`build-cost-text`);
    this.buildCostText = buildCostText;

    parentSizer.add(buildCostText, {
      proportion: 0,
      align: "center",
      padding: 0,
      expand: false,
    });
  }

  private createControlsSection(): void {
    if (this.gameStateService.getCurrentPlayer() === null) {
      return;
    }
    // Controls region: fill remaining horizontal space in rootSizer so we can
    // keep the crayon stack on the left while pinning the hide arrow to the
    // far top-right of the grey bar.
    const controlsRegionSizer = (this as any).rexUI.add
      .sizer({
        orientation: "x",
        space: { item: 0 },
      })
      .setName("controls-region-sizer");

    const crayonStackSizer = (this as any).rexUI.add
      .sizer({
        orientation: "y",
        space: { item: 10 },
      })
      .setName("crayon-stack-sizer");

    // Crayon color should always reflect the *local player*, not the current-turn player.
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const localPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;
    const crayonColor =
      colorMap[(localPlayer?.color || "#000000").toUpperCase()] || "black";
    const crayonTexture = `crayon_${crayonColor}`;

    const isLocalPlayerActive =
      this.gameStateService?.isLocalPlayerActive() ?? false;

    // Crayon button container (overlay highlight + icon)
    const crayonButtonContainer = (this as any).rexUI.add
      .container({ width: 60, height: 60 })
      .setName("crayon-button-container");
    crayonButtonContainer.setSize(60, 60);

    const crayonButton = this.add
      .image(0, 0, crayonTexture)
      .setScale(this.isDrawingMode ? 0.18 : 0.15)
      .setAlpha(isLocalPlayerActive ? 1.0 : 0.4)
      .setInteractive({ useHandCursor: isLocalPlayerActive }).setName(`crayon-button`);
    this.crayonButtonImage = crayonButton;

    // Always create the highlight once; toggle visibility on state changes.
    const highlight = this.add.circle(0, 0, 30, 0xffff00, 0.3);
    highlight.setVisible(this.isDrawingMode);
    this.crayonHighlightCircle = highlight;
    crayonButtonContainer.addLocal(highlight);
    crayonButtonContainer.addLocal(crayonButton);

    if (isLocalPlayerActive) {
      crayonButton
        .on("pointerover", () => {
          if (!this.isDrawingMode) {
            crayonButton.setScale(0.17);
          }
        })
        .on("pointerout", () => {
          if (!this.isDrawingMode) {
            crayonButton.setScale(0.15);
          }
        })
        .on("pointerdown", (pointer: Phaser.Input.Pointer) => {
          if (pointer.event) {
            pointer.event.stopPropagation();
          }
          this.toggleDrawingCallback();
        });
    } else {
      crayonButton.setInteractive({ useHandCursor: false });
    }

    // Undo button
    if (isLocalPlayerActive && this.canUndo()) {
      const undoButton = this.add
        .text(0, 0, "⟲ Undo", {
          color: "#ffffff",
          fontSize: "18px",
          fontStyle: "bold",
          backgroundColor: "#444",
          padding: { left: 8, right: 8, top: 4, bottom: 4 },
        })
        .setInteractive({ useHandCursor: true }).setName(`undo-button`);
      undoButton.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        if (pointer.event) pointer.event.stopPropagation();
        this.onUndo();
      });
      crayonStackSizer.add(undoButton, {
        proportion: 0,
        align: "center",
        padding: 0,
        expand: false,
      });
    }

    // Hide button (arrow) as a sized container so sizer can position it.
    const hideButtonContainer = (this as any).rexUI.add
      .container({ width: 40, height: 40 })
      .setName("hide-button-container");
    hideButtonContainer.setSize(40, 40);

    const toggleGraphics = this.add.graphics().setName(`hide-button-graphics`);
    const arrowSize = 15;
    const arrowColor = 0xffffff;
    toggleGraphics.lineStyle(3, arrowColor, 1);
    toggleGraphics.beginPath();
    // Draw centered arrow within the container's local space.
    toggleGraphics.moveTo(-arrowSize, -arrowSize / 2);
    toggleGraphics.lineTo(0, arrowSize / 2);
    toggleGraphics.lineTo(arrowSize, -arrowSize / 2);
    toggleGraphics.strokePath();

    const hitArea = this.add
      .rectangle(0, 0, 40, 40, 0x000000, 0)
      .setName(`hide-button-hit-area`);
    hitArea.setInteractive({ useHandCursor: true });
    hitArea.on("pointerdown", () => this.slideOutAndClose());

    hideButtonContainer.addLocal(toggleGraphics);
    hideButtonContainer.addLocal(hitArea);

    // Crayon should be lower with more separation from the arrow.
    crayonStackSizer.add(crayonButtonContainer, {
      proportion: 0,
      align: "center",
      padding: 0,
      expand: false,
    });

    // Flex spacer pushes arrow to the far right edge.
    const flexSpace = this.add.zone(0, 0, 1, 1).setName("controls-flex-space");

    controlsRegionSizer.add(crayonStackSizer, {
      proportion: 0,
      // Keep the crayon safely inside the bar (bottom alignment can push it off-screen)
      align: "center",
      padding: { left: 0, right: 0, bottom: 0 },
      expand: false,
    });
    controlsRegionSizer.add(flexSpace, {
      proportion: 1,
      align: "center",
      padding: 0,
      expand: true,
    });
    controlsRegionSizer.add(hideButtonContainer, {
      proportion: 0,
      align: "top",
      padding: { right: 0, top: 0 },
      expand: false,
    });

    // Add controls region as last child; let it consume remaining width.
    this.rootSizer.add(controlsRegionSizer, {
      proportion: 1,
      align: "center",
      padding: { left: 8, right: 4 },
      expand: true,
    });
  }

  private slideOutAndClose(): void {
    if (!this.rootSizer) return;

    // Slide down animation
    this.tweens.add({
      targets: this.rootSizer,
      y: this.scale.height,
      duration: 300,
      ease: "Power2",
      onComplete: () => {
        this.onCloseCallback();
        this.scene.stop();
      },
    });
  }

  private destroyUI(): void {
    // Destroy train card
    if (this.trainCard) {
      try {
        this.trainCard.destroy();
      } catch (e) {
        console.warn("Error destroying trainCard:", e);
      }
      this.trainCard = null;
    }

    // Destroy cards
    this.cards.forEach((card) => {
      try {
        if (card && typeof card.destroy === "function") {
          card.destroy();
        }
      } catch (e) {
        console.warn("Error destroying card:", e);
      }
    });
    this.cards = [];

    // Destroy city selection manager (not in container, so must be destroyed separately)
    // Make sure it exists and is still in the scene before trying to destroy
    if (this.citySelectionManager) {
      try {
        // Remove from scene's display list first
        if (
          this.citySelectionManager.scene &&
          this.citySelectionManager.scene.children.exists(
            this.citySelectionManager
          )
        ) {
          this.citySelectionManager.scene.children.remove(
            this.citySelectionManager
          );
        }
        if (typeof this.citySelectionManager.destroy === "function") {
          this.citySelectionManager.destroy();
        }
      } catch (e) {
        console.warn("Error destroying citySelectionManager:", e);
      }
      this.citySelectionManager = null;
    }

    // Destroy background (in container, will be removed with container)
    if (this.background) {
      this.background = null; // Will be destroyed when container is destroyed
    }

    // Destroy root container and all its children
    if (this.rootSizer) {
      try {
        //remove and destroy all children
        this.rootSizer.clear(true);
        this.rootSizer.destroy();
      } catch (e) {
        console.warn("Error destroying rootContainer:", e);
      }
      this.rootSizer = null;
    }
  }

  shutdown() {
    this.destroyUI();
  }
}
