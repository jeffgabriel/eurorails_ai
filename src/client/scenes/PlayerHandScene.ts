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
  private rootContainer: Phaser.GameObjects.Container | null = null;

  // Card dimensions
  private readonly CARD_WIDTH = 170;
  private readonly CARD_HEIGHT = 255;
  private readonly CARD_SPACING_HORIZONTAL = 20;
  private readonly CARD_SPACING_VERTICAL = 20;

  // Layout constants
  private readonly CARDS_CONTAINER_MAX_WIDTH = 170 * 3 + 20 * 2 + 20 * 2; // 570
  private readonly CARDS_CONTAINER_MIN_WIDTH = 170;
  private readonly INFO_PANEL_MAX_WIDTH = 400;
  private readonly INFO_PANEL_MIN_WIDTH = 200;
  private readonly HAND_HEIGHT_BASE = 280;
  private readonly PADDING = 20;
  private readonly CONTAINER_SPACING = 20;
  private readonly LEFT_BUFFER = 75;
  private readonly VERTICAL_PADDING = 30;

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
    // Create root container that will hold all UI elements
    // Start positioned below screen
    const layoutInfo = this.calculateLayout();
    const finalY = this.scale.height - layoutInfo.handHeight;
    this.rootContainer = this.add.container(0, this.scale.height);
    
    // Create the UI (which adds to rootContainer)
    // CitySelectionManager will be positioned at final position since container animates
    this.createUI();
    
    // Slide in animation - animate container up to visible position
    this.tweens.add({
      targets: this.rootContainer,
      y: finalY,
      duration: 300,
      ease: "Power2"
    });
    
    // Set camera to not scroll
    this.cameras.main.setScroll(0, 0);
  }

  public updateTrainCardLoads(): void {
    if (this.trainCard) {
      this.trainCard.updateLoads();
    }
  }

  updateSceneData(
    gameState: GameState,
    isDrawingMode: boolean,
    currentTrackCost: number
  ) {
    this.gameState = gameState;
    this.isDrawingMode = isDrawingMode;
    this.currentTrackCost = currentTrackCost;
    
    // Save current container position before destroying
    const layoutInfo = this.calculateLayout();
    const currentY = this.rootContainer ? this.rootContainer.y : (this.scale.height - layoutInfo.handHeight);
    
    // Destroy UI elements but keep container structure
    if (this.trainCard) {
      this.trainCard.destroy();
      this.trainCard = null;
    }
    this.cards.forEach((card) => { if (card) card.destroy()});
    this.cards = [];
    if (this.citySelectionManager) {
      this.citySelectionManager.destroy();
      this.citySelectionManager = null;
    }
    if (this.rootContainer) {
      this.rootContainer.removeAll(true);
    } else {
      // Create root container if it doesn't exist
      this.rootContainer = this.add.container(0, currentY);
    }
    
    // Ensure container is at correct position
    if (this.rootContainer) {
      this.rootContainer.y = currentY;
    }
    
    // Recreate UI
    this.createUI();
  }

  private createUI() {
    if (!this.rootContainer) {
      // If rootContainer doesn't exist, create UI elements directly (for updateSceneData)
      const layoutInfo = this.calculateLayout();
      this.rootContainer = this.add.container(0, this.scale.height - layoutInfo.handHeight);
    }
    
    // Calculate layout
    const layoutInfo = this.calculateLayout();

    // Create background
    this.background = this.add
      .rectangle(
        0,
        0,
        this.scale.width,
        layoutInfo.handHeight,
        0x333333,
        0.8
      )
      .setOrigin(0, 0);

    this.rootContainer.add(this.background);

    // Create demand cards section
    this.createDemandCardSection(layoutInfo);

    // Create train section
    this.createTrainSection(layoutInfo);

    // Create player info section
    this.createPlayerInfoSection(layoutInfo);

    // Create hide button
    this.createHideButton(layoutInfo.handHeight);
  }

  private calculateLayout(): {
    containersSideBySide: boolean;
    cardsStacked: boolean;
    cardsContainerWidth: number;
    cardsContainerX: number;
    cardsContainerY: number;
    trainCardX: number;
    trainCardY: number;
    playerInfoX: number;
    playerInfoY: number;
    cardStartX: number;
    cardStartY: number;
    cardSpacing: number;
    handHeight: number;
  } {
    const screenWidth = this.scale.width;
    const numCards = 3;

    const trainCardWidth = 100;
    const playerInfoWidth = 300;
    const totalRequiredWidth =
      this.LEFT_BUFFER +
      this.CARDS_CONTAINER_MAX_WIDTH +
      this.CONTAINER_SPACING +
      trainCardWidth +
      this.CONTAINER_SPACING +
      playerInfoWidth +
      this.PADDING;
    const containersSideBySide = screenWidth >= totalRequiredWidth;

    const availableCardsWidth = containersSideBySide
      ? this.CARDS_CONTAINER_MAX_WIDTH
      : Math.max(
          this.CARDS_CONTAINER_MIN_WIDTH,
          Math.min(
            this.CARDS_CONTAINER_MAX_WIDTH,
            screenWidth - this.LEFT_BUFFER - this.PADDING
          )
        );

    const cardsRequiredWidth =
      this.CARD_WIDTH * numCards + this.CARD_SPACING_HORIZONTAL * (numCards - 1);
    const cardsStacked = availableCardsWidth < cardsRequiredWidth;

    let cardStartX: number;
    let cardStartY: number;
    let cardSpacing: number;

    if (cardsStacked) {
      cardStartX = this.PADDING;
      cardStartY = this.PADDING;
      cardSpacing = this.CARD_SPACING_VERTICAL;
    } else {
      const totalCardWidth = this.CARD_WIDTH * numCards;
      const totalSpacing = availableCardsWidth - totalCardWidth - this.PADDING * 2;
      const spacing = totalSpacing / (numCards - 1);
      cardStartX = this.PADDING;
      cardStartY = 0;
      cardSpacing = spacing;
    }

    let cardsContainerX: number;
    let cardsContainerY: number;
    let trainCardX: number;
    let trainCardY: number;
    let playerInfoX: number;
    let playerInfoY: number;
    let infoHeight: number;
    let handHeight: number;

    const bottomPadding = 20;
    const trainCardHeight = 85;

    if (containersSideBySide) {
      cardsContainerX = this.LEFT_BUFFER;
      cardsContainerY = cardsStacked ? 0 : 140;

      const cardsHeight = cardsStacked
        ? this.CARD_HEIGHT * numCards +
          this.CARD_SPACING_VERTICAL * (numCards - 1) +
          this.PADDING * 2
        : this.CARD_HEIGHT + bottomPadding;
      const playerInfoHeight = 200;

      const infoAreaX = cardsContainerX + availableCardsWidth + this.CONTAINER_SPACING;
      const availableInfoWidth = screenWidth - infoAreaX - this.PADDING;
      const requiredInfoWidth =
        trainCardWidth + this.CONTAINER_SPACING + playerInfoWidth;
      const infoStacked = availableInfoWidth < requiredInfoWidth;

      if (infoStacked) {
        trainCardX = infoAreaX;
        trainCardY = 10;
        playerInfoX = infoAreaX;
        playerInfoY = trainCardY + trainCardHeight + this.CONTAINER_SPACING;
        infoHeight = trainCardHeight + this.CONTAINER_SPACING + playerInfoHeight;
      } else {
        trainCardX = infoAreaX;
        trainCardY = 10;
        playerInfoX = trainCardX + trainCardWidth + this.CONTAINER_SPACING;
        playerInfoY = cardsContainerY;
        infoHeight = Math.max(trainCardHeight, playerInfoHeight);
      }

      handHeight = Math.max(cardsHeight, infoHeight);

      if (!cardsStacked) {
        cardStartY = 0;
      }
    } else {
      cardsContainerX = this.LEFT_BUFFER;
      cardsContainerY = cardsStacked ? 0 : 140;

      const cardsHeight = cardsStacked
        ? this.CARD_HEIGHT * numCards +
          this.CARD_SPACING_VERTICAL * (numCards - 1) +
          this.PADDING * 2
        : this.CARD_HEIGHT + bottomPadding;

      if (!cardsStacked) {
        cardStartY = 0;
      }

      trainCardX = this.LEFT_BUFFER;
      trainCardY = cardsContainerY + cardsHeight + this.CONTAINER_SPACING;
      playerInfoX = this.LEFT_BUFFER;
      playerInfoY = trainCardY + trainCardHeight + this.CONTAINER_SPACING;

      const playerInfoHeight = 200;
      infoHeight = trainCardHeight + this.CONTAINER_SPACING + playerInfoHeight;
      handHeight = cardsHeight + this.CONTAINER_SPACING + infoHeight;
    }

    return {
      containersSideBySide,
      cardsStacked,
      cardsContainerWidth: availableCardsWidth,
      cardsContainerX,
      cardsContainerY,
      trainCardX,
      trainCardY,
      playerInfoX,
      playerInfoY,
      cardStartX,
      cardStartY,
      cardSpacing,
      handHeight,
    };
  }

  private async createDemandCardSection(
    layoutInfo: ReturnType<typeof this.calculateLayout>
  ): Promise<void> {
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const currentPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;

    if (!currentPlayer) {
      return;
    }

    // Clear existing cards
    this.cards.forEach((card) => { if (card) card.destroy()});
    this.cards = [];

    if (currentPlayer.hand.length === 0) {
      console.warn(`Player ${currentPlayer.name} has no cards in hand.`);
    }

    const maxCards = 3;
    const cardsToShow = Math.max(currentPlayer.hand.length, maxCards);

    // Create cards directly in scene (not in container)
    for (let i = 0; i < cardsToShow; i++) {
      let x: number;
      let y: number;

      if (layoutInfo.cardsStacked) {
        x = layoutInfo.cardsContainerX + layoutInfo.cardStartX;
        y =
          layoutInfo.cardsContainerY +
          layoutInfo.cardStartY +
          i * (this.CARD_HEIGHT + layoutInfo.cardSpacing);
      } else {
        x =
          layoutInfo.cardsContainerX +
          layoutInfo.cardStartX +
          i * (this.CARD_WIDTH + layoutInfo.cardSpacing);
        y = layoutInfo.cardsContainerY + layoutInfo.cardStartY;
      }

      const card =
        i < currentPlayer.hand.length ? currentPlayer.hand[i] : undefined;
      const demandCard = new DemandCard(this, x, y, card);
      this.cards.push(demandCard);
      if (this.rootContainer) {
        this.rootContainer.add(demandCard);
      }
    }
  }

  private createTrainSection(
    layoutInfo: ReturnType<typeof this.calculateLayout>
  ): void {
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
        layoutInfo.trainCardX,
        layoutInfo.trainCardY,
        currentPlayer
      );
      this.trainCard.updateLoads();
      if (this.rootContainer) {
        this.rootContainer.add(this.trainCard.getContainer());
      }
    } catch (error) {
      console.error("Failed to create train card:", error);
    }
  }

  private createPlayerInfoSection(
    layoutInfo: ReturnType<typeof this.calculateLayout>
  ): void {
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const currentPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;

    if (!currentPlayer) {
      return;
    }

    // Only create CitySelectionManager if player needs to select a city
    const shouldShowCitySelection = localPlayerId && 
      currentPlayer.id === localPlayerId && 
      !currentPlayer.trainState?.position;

    const MAX_TURN_BUILD_COST = 20;

    const colorMap: { [key: string]: string } = {
      "#FFD700": "yellow",
      "#FF0000": "red",
      "#0000FF": "blue",
      "#000000": "black",
      "#008000": "green",
      "#8B4513": "brown",
    };

    let costColor = "#ffffff";
    let costWarning = "";

    if (this.currentTrackCost > currentPlayer.money) {
      costColor = "#ff4444";
      costWarning = " (Insufficient funds!)";
    } else if (this.currentTrackCost > MAX_TURN_BUILD_COST) {
      costColor = "#ff8800";
      costWarning = " (Over turn limit!)";
    } else if (this.currentTrackCost >= MAX_TURN_BUILD_COST * 0.8) {
      costColor = "#ffff00";
    }

    const playerInfoText = `${currentPlayer.name}\nMoney: ECU ${currentPlayer.money}M`;
    const playerInfoWidth = 300;
    const infoX = layoutInfo.playerInfoX + playerInfoWidth / 2;
    const infoY = layoutInfo.playerInfoY;

    if (shouldShowCitySelection) {
      // Calculate absolute scene coordinates for CitySelectionManager
      // Use the FINAL container position (where it will be after animation), not current position
      // Container animates to: this.scale.height - layoutInfo.handHeight
      const finalContainerY = this.scale.height - layoutInfo.handHeight;
      const absoluteX = infoX + 170; // X offset for city selection relative to player info
      const absoluteY = finalContainerY + infoY - 90; // Y: final container position + relative offset

      // Create CitySelectionManager directly in scene (NOT in container)
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
        this.citySelectionManager.setPosition(absoluteX-this.CARD_WIDTH, absoluteY);
        this.citySelectionManager.setInteractive(true);
        this.citySelectionManager.setDepth(10000);
        this.citySelectionManager.setScrollFactor(0, 0);
        this.citySelectionManager.layout();
        this.add.existing(this.citySelectionManager);
      }
    }
    // CitySelectionManager is NOT added to rootContainer - it's positioned directly in scene

    // Create player name and money text
    const nameAndMoney = this.add
      .text(infoX, infoY, playerInfoText, {
        color: "#ffffff",
        fontSize: "20px",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0);
    if (this.rootContainer) {
      this.rootContainer.add(nameAndMoney);
    }

    const textBounds = nameAndMoney.getBounds();

    // Position crayon
    const crayonX = textBounds.right + 40;
    const crayonY = infoY + 10;

    const crayonColor = colorMap[currentPlayer.color.toUpperCase()] || "black";
    const crayonTexture = `crayon_${crayonColor}`;

    const isLocalPlayerActive =
      this.gameStateService?.isLocalPlayerActive() ?? false;

    const crayonButton = this.add
      .image(crayonX, crayonY, crayonTexture)
      .setScale(0.15)
      .setAlpha(isLocalPlayerActive ? 1.0 : 0.4)
      .setInteractive({ useHandCursor: isLocalPlayerActive });
    if (this.rootContainer) {
      this.rootContainer.add(crayonButton);
    }

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

    // Build cost text
    const buildCostY = infoY + 45;
    const buildCostText = this.add
      .text(infoX, buildCostY, `Build Cost: ${this.currentTrackCost}M${costWarning}`, {
        color: costColor,
        fontSize: "20px",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0);
    if (this.rootContainer) {
      this.rootContainer.add(buildCostText);
    }

    // Drawing mode indicator
    if (this.isDrawingMode) {
      crayonButton.setScale(0.18);
      const highlight = this.add.circle(
        crayonButton.x,
        crayonButton.y,
        30,
        0xffff00,
        0.3
      );
      if (this.rootContainer) {
        this.rootContainer.add(highlight);
      }
    } else {
      crayonButton.setScale(0.15);
    }

    // Undo button
    if (isLocalPlayerActive && this.canUndo()) {
      const undoButton = this.add
        .text(crayonButton.x, crayonButton.y + 50, "⟲ Undo", {
          color: "#ffffff",
          fontSize: "18px",
          fontStyle: "bold",
          backgroundColor: "#444",
          padding: { left: 8, right: 8, top: 4, bottom: 4 },
        })
        .setOrigin(0.5, 0)
        .setInteractive({ useHandCursor: true });
      undoButton.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        if (pointer.event) pointer.event.stopPropagation();
        this.onUndo();
      });
      if (this.rootContainer) {
        this.rootContainer.add(undoButton);
      }
    }
  }

  private createHideButton(handHeight: number): void {
    const buttonX = this.scale.width - 40;
    const buttonY = 20;

    const toggleGraphics = this.add.graphics();
    const arrowSize = 15;
    const arrowColor = 0xffffff;

    toggleGraphics.lineStyle(3, arrowColor, 1);
    toggleGraphics.beginPath();
    toggleGraphics.moveTo(buttonX - arrowSize, buttonY - arrowSize / 2);
    toggleGraphics.lineTo(buttonX, buttonY + arrowSize / 2);
    toggleGraphics.lineTo(buttonX + arrowSize, buttonY - arrowSize / 2);
    toggleGraphics.strokePath();

    const hitArea = this.add.rectangle(
      buttonX,
      buttonY,
      40,
      40,
      0x000000,
      0
    );
    hitArea.setInteractive({ useHandCursor: true });

    hitArea.on("pointerdown", () => {
      this.slideOutAndClose();
    });
    
    if (this.rootContainer) {
      this.rootContainer.add([toggleGraphics, hitArea]);
    }
  }

  private slideOutAndClose(): void {
    if (!this.rootContainer) return;
    
    // Slide down animation
    const layoutInfo = this.calculateLayout();
    this.tweens.add({
      targets: this.rootContainer,
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
        if (card && typeof card.destroy === 'function') {
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
        if (this.citySelectionManager.scene && this.citySelectionManager.scene.children.exists(this.citySelectionManager)) {
          this.citySelectionManager.scene.children.remove(this.citySelectionManager);
        }
        if (typeof this.citySelectionManager.destroy === 'function') {
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
    if (this.rootContainer) {
      try {
        // Remove all children first
        this.rootContainer.removeAll(true);
        // Remove from scene
        if (this.rootContainer.scene && this.rootContainer.scene.children.exists(this.rootContainer)) {
          this.rootContainer.scene.children.remove(this.rootContainer);
        }
        // Then destroy
        if (typeof this.rootContainer.destroy === 'function') {
          this.rootContainer?.destroy();
        }
      } catch (e) {
        console.warn("Error destroying rootContainer:", e);
      }
      this.rootContainer = null;
    }
  }

  shutdown() {
    this.destroyUI();
  }
}
