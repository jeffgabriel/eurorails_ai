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
  private layoutInfo = this.calculateLayout();

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
    if (this.trainCard) {
      this.trainCard.updateLoads();
    }
  }

  // updateSceneData(
  //   gameState: GameState,
  //   isDrawingMode: boolean,
  //   currentTrackCost: number
  // ) {
  //   this.gameState = gameState;
  //   this.isDrawingMode = isDrawingMode;
  //   this.currentTrackCost = currentTrackCost;

  //   //this.destroyUI();

  //   // Recreate UI
  //   this.createUI();
  // }

  private createUI() {
    if (this.rootSizer) {
     // this.rootSizer.destroy();
    }
    this.layoutInfo = this.calculateLayout();
    //overall rexUI.sizer which contains all the UI elements in the player hand scene
    this.rootSizer = (this as any).rexUI.add
      .sizer({
        width: this.scale.width,
        height: this.HAND_HEIGHT_BASE,
        orientation: "x",
        align: "center",
        anchor: { bottom: 'bottom-100' },
        space: { left: 6, right: 6, top: 6, bottom: 6, item: 6 },
      })
      .setPosition(this.scale.width / 2 )
      .setName(`root-sizer`);

    this.rootSizer.addBackground((this as any).rexUI.add.roundRectangle({
      color: 0x333333,
      alpha: 0.8,
    }));
    // Create demand cards section -
    this.createDemandCardSection(this.layoutInfo);

    // Create train section
    this.createTrainSection(this.layoutInfo);

    // Create player info section
    this.createPlayerInfoSection(this.layoutInfo);

    // Create hide button
   this.createHideButton(this.layoutInfo.handHeight);

    this.rootSizer.layout();
    const finalY = this.scale.height - this.layoutInfo.handHeight;
    // Slide in animation - animate container up to visible position
    this.tweens.add({
      targets: this.rootSizer,
      y: finalY,
      duration: 300,
      ease: "Power2",
    });
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
    if (!this.scale)
      return {
        containersSideBySide: false,
        cardsStacked: false,
        cardsContainerWidth: 0,
        cardsContainerX: 0,
        cardsContainerY: 0,
        trainCardX: 0,
        trainCardY: 0,
        playerInfoX: 0,
        playerInfoY: 0,
        cardStartX: 0,
        cardStartY: 0,
        cardSpacing: 0,
        handHeight: 0,
      };
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
      this.CARD_WIDTH * numCards +
      this.CARD_SPACING_HORIZONTAL * (numCards - 1);
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
      const totalSpacing =
        availableCardsWidth - totalCardWidth - this.PADDING * 2;
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

      const infoAreaX =
        cardsContainerX + availableCardsWidth + this.CONTAINER_SPACING;
      const availableInfoWidth = screenWidth - infoAreaX - this.PADDING;
      const requiredInfoWidth =
        trainCardWidth + this.CONTAINER_SPACING + playerInfoWidth;
      const infoStacked = availableInfoWidth < requiredInfoWidth;

      if (infoStacked) {
        trainCardX = infoAreaX;
        trainCardY = 10;
        playerInfoX = infoAreaX;
        playerInfoY = trainCardY + trainCardHeight + this.CONTAINER_SPACING;
        infoHeight =
          trainCardHeight + this.CONTAINER_SPACING + playerInfoHeight;
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
    this.cards.forEach((card) => {
      if (card) card.destroy();
    });
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
      const demandCard = new DemandCard(this, 0, 0, card);
      this.rootSizer.add(demandCard, { proportion: 0, expand: true});
      this.cards.push(demandCard);
    }

    // this.rootSizer.add(this.cards);
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
      this.rootSizer.add(this.trainCard.getContainer());
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

    var playerInfoContainer = (this as any).rexUI.add.container({
      width: layoutInfo.cardsContainerWidth / 3,
      space: { left: 6, right: 6, top: 6, bottom: 6, item: 6 },
    }).setName(`player-info-container`);

    this.createCitySelectionSection(playerInfoContainer);

    this.createNameAndMoneySection(playerInfoContainer);

    this.createBuildCostSection(playerInfoContainer);

    this.createCrayonButton(playerInfoContainer);

    //playerInfoContainer.layout();
    if (this.rootSizer) {
      this.rootSizer.add(playerInfoContainer);
    }
  }

  private createCitySelectionSection(parentContainer: any): void {
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
      // Calculate absolute scene coordinates for CitySelectionManager
      // Use the FINAL container position (where it will be after animation), not current position
      // Container animates to: this.scale.height - layoutInfo.handHeight
      // const finalContainerY = this.scale.height - layoutInfo.handHeight;
      // const absoluteX = infoX + 170; // X offset for city selection relative to player info
      // const absoluteY = finalContainerY + infoY - 90; // Y: final container position + relative offset

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
        this.citySelectionManager.setInteractive(true);
        this.citySelectionManager.setDepth(10000);
        this.citySelectionManager.setScrollFactor(0, 0);
        parentContainer.add(this.citySelectionManager, {
          proportion: 1,
          offsetX: 150,
          offsetY: 250,
        });
      }
    }
  }

  private createNameAndMoneySection(parentContainer: any): void {
    const currentPlayer = this.gameStateService.getCurrentPlayer();
    if (!currentPlayer) {
      return;
    }

    const playerInfoText = `${currentPlayer.name}\nMoney: ECU ${currentPlayer.money}M`;
    // const playerInfoWidth = 300;
    // const infoX = layoutInfo.playerInfoX + playerInfoWidth / 2;
    // const infoY = layoutInfo.playerInfoY;

    // Create player name and money text
    const nameAndMoney = this.add
      .text(0, 0, playerInfoText, {
        color: "#ffffff",
        fontSize: "20px",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0).setName(`name-and-money-text`);
    parentContainer.addLocal(nameAndMoney, {
      proportion: 0,
      expand: true,
      offsetX: 150,
      offsetY: 250,
    });
  }

  private createBuildCostSection(parentContainer: any): void {
    const currentPlayer = this.gameStateService.getCurrentPlayer();
    if (!currentPlayer) {
      return;
    }
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
    // Build cost text
    //const buildCostY = infoY + 45;
    const buildCostText = this.add
      .text(0, 0, `Build Cost: ${this.currentTrackCost}M${costWarning}`, {
        color: costColor,
        fontSize: "20px",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0).setName(`build-cost-text`);

    parentContainer.add(buildCostText, {
      proportion: 1,
    });
  }

  private createCrayonButton(parentContainer: any): void {
    if (this.gameStateService.getCurrentPlayer() === null) {
      return;
    }
    const crayonContainer = (this as any).rexUI.add.container({
      width: 40,
      height: 40,
      space: { left: 6, right: 6, top: 6, bottom: 6, item: 6 },
    }).setName(`crayon-container`);
    // Position crayon
    //  const crayonX = textBounds.right + 40;
    //  const crayonY = infoY + 10;

    const crayonColor =
      colorMap[
        this.gameStateService.getCurrentPlayer()?.color?.toUpperCase() ||
          "black"
      ];
    const crayonTexture = `crayon_${crayonColor}`;

    const isLocalPlayerActive =
      this.gameStateService?.isLocalPlayerActive() ?? false;

    const crayonButton = this.add
      .image(0, 0, crayonTexture)
      .setScale(0.15)
      .setAlpha(isLocalPlayerActive ? 1.0 : 0.4)
      .setInteractive({ useHandCursor: isLocalPlayerActive }).setName(`crayon-button`);

    crayonContainer.addLocal(crayonButton, {
      proportion: 0,
      expand: true,
      offsetX: 150,
      offsetY: 250,
    });

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
    // Drawing mode indicator
    if (this.isDrawingMode) {
      crayonButton.setScale(0.18);
      const highlight = this.add.circle(
        // crayonButton.x,
        // crayonButton.y,
        0,
        0,
        30,
        0xffff00,
        0.3
      );

      crayonContainer.addLocal(highlight, {
        offsetX: 150,
        offsetY: 250,
      });
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
        .setInteractive({ useHandCursor: true }).setName(`undo-button`);
      undoButton.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        if (pointer.event) pointer.event.stopPropagation();
        this.onUndo();
      });
      crayonContainer.addLocal(undoButton, {
        offsetX: 150,
        offsetY: 250,
      });
    }
    this.rootSizer.add(crayonContainer, {
      proportion: 1,
    });
  }

  private createHideButton(handHeight: number): void {
    const buttonX = this.scale.width - 40;
    const buttonY = 20;

    const toggleGraphics = this.add.graphics().setName(`hide-button-graphics`);
    const arrowSize = 15;
    const arrowColor = 0xffffff;

    toggleGraphics.lineStyle(3, arrowColor, 1);
    toggleGraphics.beginPath();
    toggleGraphics.moveTo(buttonX - arrowSize, buttonY - arrowSize / 2);
    toggleGraphics.lineTo(buttonX, buttonY + arrowSize / 2);
    toggleGraphics.lineTo(buttonX + arrowSize, buttonY - arrowSize / 2);
    toggleGraphics.strokePath();

    const hitArea = this.add.rectangle(buttonX, buttonY, 40, 40, 0x000000, 0).setName(`hide-button-hit-area`);
    hitArea.setInteractive({ useHandCursor: true });

    hitArea.on("pointerdown", () => {
      this.slideOutAndClose();
    });

    this.rootSizer.add(toggleGraphics);
    this.rootSizer.add(hitArea);
  }

  private slideOutAndClose(): void {
    if (!this.rootSizer) return;

    // Slide down animation
    const layoutInfo = this.calculateLayout();
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
