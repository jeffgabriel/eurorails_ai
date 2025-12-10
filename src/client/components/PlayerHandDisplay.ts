import "phaser";
import { GameState } from "../../shared/types/GameTypes";
import { TrainCard } from "./TrainCard";
import { DemandCard } from "./DemandCard";
import { PlayerHand } from "../../shared/types/PlayerHand";
import { GameStateService } from "../services/GameStateService";
import { CitySelectionManager } from "./CitySelectionManager";
import { MapRenderer } from "./MapRenderer";
import { TrainInteractionManager } from "./TrainInteractionManager";

export class PlayerHandDisplay {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private gameState: GameState;
  private toggleDrawingCallback: () => void;
  private onUndo: () => void;
  private canUndo: () => boolean;
  private gameStateService: GameStateService | null = null;
  public trainCard: TrainCard | null = null;
  private cards: DemandCard[] = [];

  // Card dimensions
  private readonly CARD_WIDTH = 170;
  private readonly CARD_HEIGHT = 255;
  private readonly CARD_SPACING_HORIZONTAL = 20; // Space between cards in horizontal layout
  private readonly CARD_SPACING_VERTICAL = 20; // Space between cards when stacked

  // Building block dimensions
  private readonly CARDS_CONTAINER_MAX_WIDTH = 170 * 3 + 20 * 2 + 20 * 2; // 3 cards + 2 spacings + padding = 570
  private readonly CARDS_CONTAINER_MIN_WIDTH = 170; // One card width
  private readonly INFO_PANEL_MAX_WIDTH = 400; // Maximum width for info panel (train card + player info)
  private readonly INFO_PANEL_MIN_WIDTH = 200; // Minimum width for info panel

  // Layout constants
  private readonly HAND_HEIGHT_BASE = 280; // Base height for horizontal layout
  private readonly STATUS_BAR_HEIGHT = 50; // Height when collapsed
  private readonly PADDING = 20; // Padding around containers
  private readonly CONTAINER_SPACING = 20; // Space between cards container and info panel
  private readonly LEFT_BUFFER = 75; // Extra padding on the left to prevent edge clipping
  private readonly VERTICAL_PADDING = 30; // Vertical padding when cards are in a row (horizontal layout)

  // State management
  private isCollapsed: boolean = false;
  private handAreaContainer: Phaser.GameObjects.Container | null = null;
  private currentContainer: Phaser.GameObjects.Container | null = null;
  private lastDrawingMode: boolean = false;
  private lastTrackCost: number = 0;
  private mapRenderer: MapRenderer;
  private trainInteractionManager: TrainInteractionManager;
  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    toggleDrawingCallback: () => void,
    onUndo: () => void,
    canUndo: () => boolean,
    mapRenderer: MapRenderer,
    trainInteractionManager: TrainInteractionManager,
    gameStateService?: GameStateService
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.toggleDrawingCallback = toggleDrawingCallback;
    this.onUndo = onUndo;
    this.canUndo = canUndo;
    this.gameStateService = gameStateService || null;
    this.mapRenderer = mapRenderer;
    this.trainInteractionManager = trainInteractionManager;
    this.container = this.scene.add.container(0, 0);
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

    // Store current state for toggle functionality
    this.lastDrawingMode = isDrawingMode;
    this.lastTrackCost = currentTrackCost;

    // Clean up old train card if it exists
    if (this.trainCard) {
      this.trainCard.destroy();
      this.trainCard = null;
    }

    // Clear target container
    targetContainer.removeAll(true);

    // Calculate layout mode and dimensions
    const layoutInfo = this.calculateLayout();
    const handHeight = this.isCollapsed
      ? this.STATUS_BAR_HEIGHT
      : layoutInfo.handHeight;

    // Create a container for the hand area that will hold all elements
    const handArea = this.scene.add.container(
      0,
      this.scene.scale.height - handHeight
    );
    this.handAreaContainer = handArea;
    targetContainer.add(handArea);

    if (this.isCollapsed) {
      // Show only status bar
      this.createStatusBar(handArea);
    } else {
      // Create the background, cards, and player info sections and add to handArea
      this.createHandBackground(handArea, layoutInfo.handHeight);

      // Create separate containers for train card and player info
      const trainCardContainer = this.scene.add.container(
        layoutInfo.trainCardX,
        layoutInfo.trainCardY
      );
      handArea.add(trainCardContainer);
      (handArea as any).trainCardContainer = trainCardContainer;

      const playerInfoContainer = this.scene.add.container(
        layoutInfo.playerInfoX,
        layoutInfo.playerInfoY
      );
      handArea.add(playerInfoContainer);
      (handArea as any).playerInfoContainer = playerInfoContainer;

      await this.createDemandCardSection(handArea, layoutInfo);
      this.createTrainSection(handArea, layoutInfo);
      this.createPlayerInfoSection(
        isDrawingMode,
        currentTrackCost,
        handArea,
        layoutInfo
      );
      this.createToggleButton(handArea, layoutInfo.handHeight);
    }

    // Store reference to the current container
    this.currentContainer = targetContainer;
  }

  private calculateLayout(): {
    containersSideBySide: boolean; // Whether cards container and info panel are side by side
    cardsStacked: boolean; // Whether cards are stacked vertically within their container
    cardsContainerWidth: number; // Actual width of cards container
    cardsContainerX: number; // X position of cards container
    cardsContainerY: number; // Y position of cards container
    trainCardX: number; // X position of train card container
    trainCardY: number; // Y position of train card container
    playerInfoX: number; // X position of player info container
    playerInfoY: number; // Y position of player info container
    cardStartX: number; // X position of first card within cards container
    cardStartY: number; // Y position of first card within cards container
    cardSpacing: number; // Spacing between cards
    handHeight: number; // Total height of hand area
  } {
    const screenWidth = this.scene.scale.width;
    const numCards = 3;

    // Calculate if containers can fit side by side
    // Account for left buffer, cards, train card, and player info
    const trainCardWidth = 100; // Approximate train card width
    const playerInfoWidth = 300; // Approximate player info width
    const totalRequiredWidth =
      this.LEFT_BUFFER +
      this.CARDS_CONTAINER_MAX_WIDTH +
      this.CONTAINER_SPACING +
      trainCardWidth +
      this.CONTAINER_SPACING +
      playerInfoWidth +
      this.PADDING;
    const containersSideBySide = screenWidth >= totalRequiredWidth;

    // Calculate cards container width (clamped between min and max)
    const availableCardsWidth = containersSideBySide
      ? this.CARDS_CONTAINER_MAX_WIDTH
      : Math.max(
          this.CARDS_CONTAINER_MIN_WIDTH,
          Math.min(
            this.CARDS_CONTAINER_MAX_WIDTH,
            screenWidth - this.LEFT_BUFFER - this.PADDING
          )
        );

    // Determine if cards should stack within their container
    const cardsRequiredWidth =
      this.CARD_WIDTH * numCards +
      this.CARD_SPACING_HORIZONTAL * (numCards - 1);
    const cardsStacked = availableCardsWidth < cardsRequiredWidth;

    // Calculate card positions within cards container
    let cardStartX: number;
    let cardStartY: number;
    let cardSpacing: number;

    if (cardsStacked) {
      // Cards stack vertically within container
      cardStartX = this.PADDING;
      cardStartY = this.PADDING;
      cardSpacing = this.CARD_SPACING_VERTICAL;
    } else {
      // Cards in a row - position them near the bottom of the container
      const totalCardWidth = this.CARD_WIDTH * numCards;
      const totalSpacing =
        availableCardsWidth - totalCardWidth - this.PADDING * 2;
      const spacing = totalSpacing / (numCards - 1);
      cardStartX = this.PADDING;
      // Will calculate cardStartY after we know handHeight - set placeholder for now
      cardStartY = 0; // Will be recalculated based on container height
      cardSpacing = spacing;
    }

    // Calculate container positions
    let cardsContainerX: number;
    let cardsContainerY: number;
    let trainCardX: number;
    let trainCardY: number;
    let playerInfoX: number;
    let playerInfoY: number;
    let infoHeight: number;
    let handHeight: number;

    // Calculate hand height - for horizontal row, make it just tall enough for cards
    const bottomPadding = 20; // Padding at bottom of hand area
    const trainCardHeight = 85; // Approximate train card height

    if (containersSideBySide) {
      // Containers side by side
      cardsContainerX = this.LEFT_BUFFER;
      cardsContainerY = cardsStacked ? 0 : 140; // Move down 140 units for horizontal row

      // Height is max of cards container height and info elements height
      const cardsHeight = cardsStacked
        ? this.CARD_HEIGHT * numCards +
          this.CARD_SPACING_VERTICAL * (numCards - 1) +
          this.PADDING * 2
        : this.CARD_HEIGHT + bottomPadding; // Just tall enough for cards + bottom padding
      const playerInfoHeight = 200; // Approximate player info height

      // Check if train card and player info can fit side by side
      const infoAreaX =
        cardsContainerX + availableCardsWidth + this.CONTAINER_SPACING;
      const availableInfoWidth = screenWidth - infoAreaX - this.PADDING;
      const requiredInfoWidth =
        trainCardWidth + this.CONTAINER_SPACING + playerInfoWidth;
      const infoStacked = availableInfoWidth < requiredInfoWidth;

      if (infoStacked) {
        // Train card and player info stacked vertically
        trainCardX = infoAreaX;
        trainCardY = 10; // Train card with 10 units of top buffer
        playerInfoX = infoAreaX;
        playerInfoY = trainCardY + trainCardHeight + this.CONTAINER_SPACING;
        infoHeight =
          trainCardHeight + this.CONTAINER_SPACING + playerInfoHeight;
      } else {
        // Train card and player info side by side
        trainCardX = infoAreaX;
        trainCardY = 10; // Train card with 10 units of top buffer
        playerInfoX = trainCardX + trainCardWidth + this.CONTAINER_SPACING;
        playerInfoY = cardsContainerY; // Player info matches cards' vertical position
        infoHeight = Math.max(trainCardHeight, playerInfoHeight);
      }

      handHeight = Math.max(cardsHeight, infoHeight);

      // Recalculate cardStartY for horizontal row - position at top of container
      if (!cardsStacked) {
        cardStartY = 0; // Cards at top of cards container
      }
    } else {
      // Containers stacked vertically
      cardsContainerX = this.LEFT_BUFFER;
      cardsContainerY = cardsStacked ? 0 : 140; // Move down 140 units for horizontal row

      const cardsHeight = cardsStacked
        ? this.CARD_HEIGHT * numCards +
          this.CARD_SPACING_VERTICAL * (numCards - 1) +
          this.PADDING * 2
        : this.CARD_HEIGHT + bottomPadding; // Just tall enough for cards + bottom padding

      // Recalculate cardStartY for horizontal row - position at top of container
      if (!cardsStacked) {
        cardStartY = 0; // Cards at top of cards container
      }

      // Train card and player info stacked below cards
      trainCardX = this.LEFT_BUFFER;
      trainCardY = cardsContainerY + cardsHeight + this.CONTAINER_SPACING;
      playerInfoX = this.LEFT_BUFFER;
      playerInfoY = trainCardY + trainCardHeight + this.CONTAINER_SPACING;

      const playerInfoHeight = 200; // Approximate player info height
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

  private createHandBackground(
    targetContainer: Phaser.GameObjects.Container,
    height: number
  ): void {
    // Create background for player's hand area
    const handBackground = this.scene.add
      .rectangle(
        0,
        0, // Position relative to hand area container
        this.scene.scale.width,
        height,
        0x333333,
        0.8
      )
      .setOrigin(0, 0)
      .setDepth(0); // Set background to lowest depth

    targetContainer.add(handBackground);
  }

  private async createDemandCardSection(
    targetContainer: Phaser.GameObjects.Container,
    layoutInfo: ReturnType<typeof this.calculateLayout>
  ): Promise<void> {
    // Guard against race condition when gameStateService is null
    if (!this.gameStateService) {
      console.error(
        "PlayerHandDisplay.createDemandCardSection: gameStateService is null, cannot determine local player"
      );
      return;
    }

    // Show only local player's cards
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const currentPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;

    // If no local player found, don't show cards
    if (!currentPlayer) {
      return;
    }

    // Clear existing cards
    this.cards.forEach((card) => card.destroy());
    this.cards = [];

    // Cards should be loaded from the database
    // Only draw if hand is truly empty AND we're sure the database has been checked
    // The hand should be populated from the game state which comes from the database
    if (currentPlayer.hand.length === 0) {
      console.warn(
        `Player ${currentPlayer.name} has no cards in hand. This should only happen if:`,
        {
          message:
            "1) Player was just created and cards need to be drawn server-side, OR",
          message2: "2) Cards were not loaded from database properly",
          playerId: currentPlayer.id,
          playerName: currentPlayer.name,
          gameId: this.gameState.id,
        }
      );
      // DO NOT draw cards here - cards must be drawn server-side and saved to DB
      // The hand should persist in the database and be loaded via game state
    }

    const maxCards = 3; // Maximum number of demand cards in hand
    const cardsToShow = Math.max(currentPlayer.hand.length, maxCards);

    // Create cards container
    const cardsContainer = this.scene.add.container(
      layoutInfo.cardsContainerX,
      layoutInfo.cardsContainerY
    );
    targetContainer.add(cardsContainer);

    // Create new cards with responsive positioning within cards container
    for (let i = 0; i < cardsToShow; i++) {
      let x: number;
      let y: number;

      if (layoutInfo.cardsStacked) {
        // Cards stack vertically within container
        x = layoutInfo.cardStartX;
        y =
          layoutInfo.cardStartY +
          i * (this.CARD_HEIGHT + layoutInfo.cardSpacing);
      } else {
        // Cards in a row
        x =
          layoutInfo.cardStartX +
          i * (this.CARD_WIDTH + layoutInfo.cardSpacing);
        y = layoutInfo.cardStartY;
      }

      const card =
        i < currentPlayer.hand.length ? currentPlayer.hand[i] : undefined;
      const demandCard = new DemandCard(this.scene, x, y, card);
      this.cards.push(demandCard);
      cardsContainer.add(demandCard);
    }
  }

  private createTrainSection(
    targetContainer: Phaser.GameObjects.Container,
    layoutInfo: ReturnType<typeof this.calculateLayout>
  ): void {
    // Guard against race condition when gameStateService is null
    if (!this.gameStateService) {
      console.warn(
        "PlayerHandDisplay.createTrainSection: gameStateService not available"
      );
      return;
    }

    // Show local player's train card
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const currentPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;

    if (!currentPlayer) {
      console.error(
        "PlayerHandDisplay.createTrainSection: No local player found"
      );
      return;
    }

    // Ensure player has a trainType
    if (!currentPlayer.trainType) {
      console.warn(
        "PlayerHandDisplay.createTrainSection: Player missing trainType, defaulting to Freight"
      );
      currentPlayer.trainType = "freight" as any; // Use any to avoid type issues
    }

    try {
      // Get train card container (created in update method)
      const trainCardContainer = (targetContainer as any).trainCardContainer;
      if (!trainCardContainer) {
        console.error(
          "PlayerHandDisplay.createTrainSection: Train card container not found"
        );
        return;
      }

      // Train card positioned at origin of its container
      const trainX = 0;
      const trainY = 0;

      // Create train card using the TrainCard component
      this.trainCard = new TrainCard(this.scene, trainX, trainY, currentPlayer);

      // Update the loads display
      this.trainCard.updateLoads();

      // Add the train card's container to the train card container
      trainCardContainer.add(this.trainCard.getContainer());
    } catch (error) {
      console.error(
        "PlayerHandDisplay.createTrainSection: Failed to create train card:",
        error
      );
    }
  }

  private createPlayerInfoSection(
    isDrawingMode: boolean,
    currentTrackCost: number,
    targetContainer: Phaser.GameObjects.Container,
    layoutInfo: ReturnType<typeof this.calculateLayout>
  ): void {
    // Guard against race condition when gameStateService is null
    if (!this.gameStateService) {
      return; // Don't show player info if gameStateService is not available
    }

    // Show local player's info
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const currentPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;

    if (!currentPlayer) {
      return; // Don't show player info if no local player
    }

    const MAX_TURN_BUILD_COST = 20; // ECU 20M per turn limit

    // Add crayon button for track drawing
    const colorMap: { [key: string]: string } = {
      "#FFD700": "yellow",
      "#FF0000": "red",
      "#0000FF": "blue",
      "#000000": "black",
      "#008000": "green",
      "#8B4513": "brown",
    };

    // Determine cost display color based on constraints
    let costColor = "#ffffff"; // Default white
    let costWarning = "";

    if (currentTrackCost > currentPlayer.money) {
      costColor = "#ff4444"; // Red for over budget
      costWarning = " (Insufficient funds!)";
    } else if (currentTrackCost > MAX_TURN_BUILD_COST) {
      costColor = "#ff8800"; // Orange for over turn limit
      costWarning = " (Over turn limit!)";
    } else if (currentTrackCost >= MAX_TURN_BUILD_COST * 0.8) {
      costColor = "#ffff00"; // Yellow for approaching limit
    }

    // Build player info text
    let playerInfoText = `${currentPlayer.name}\nMoney: ECU ${currentPlayer.money}M`;

    // Get player info container (created in update method)
    const playerInfoContainer = (targetContainer as any).playerInfoContainer;
    if (!playerInfoContainer) {
      console.error(
        "PlayerHandDisplay.createPlayerInfoSection: Player info container not found"
      );
      return;
    }

    // Calculate player info position within its container
    // Position info text at top of container
    const infoY = 0; // Start at top of player info container

    // Center horizontally within player info container
    const playerInfoWidth = 300; // Width of player info container
    const infoX = playerInfoWidth / 2;

    const citySelectionManager = new CitySelectionManager(
      this.scene,
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
      () => this.isHandCollapsed()
    );
    const matrix = playerInfoContainer.getWorldTransformMatrix();
    citySelectionManager.init();
    citySelectionManager.setPosition(matrix.tx + 170, matrix.ty - 90);
    citySelectionManager.setInteractive(true);
    citySelectionManager.setDepth(10000);
    citySelectionManager.setScrollFactor(0,0);
    citySelectionManager.layout();
    this.scene.cameras.main.ignore([citySelectionManager]);
    
    // Create separate text objects for better color control
    const nameAndMoney = this.scene.add
      .text(infoX, infoY, playerInfoText, {
        color: "#ffffff",
        fontSize: "20px",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0); // Center horizontally

    // Calculate text bounds to position crayon to the right
    const textBounds = nameAndMoney.getBounds();

    // Position crayon to the right of the money text
    const crayonX = textBounds.right + 40;
    const crayonY = infoY + 10;

    const crayonColor = colorMap[currentPlayer.color.toUpperCase()] || "black";
    const crayonTexture = `crayon_${crayonColor}`;

    // Check if local player is active
    const isLocalPlayerActive =
      this.gameStateService?.isLocalPlayerActive() ?? false;

    const crayonButton = this.scene.add
      .image(crayonX, crayonY, crayonTexture)
      .setScale(0.15)
      .setAlpha(isLocalPlayerActive ? 1.0 : 0.4) // Gray out when not active
      .setInteractive({ useHandCursor: isLocalPlayerActive });

    if (isLocalPlayerActive) {
      crayonButton
        .on("pointerover", () => {
          if (!isDrawingMode) {
            crayonButton.setScale(0.17);
          }
        })
        .on("pointerout", () => {
          if (!isDrawingMode) {
            crayonButton.setScale(0.15);
          }
        })
        .on("pointerdown", (pointer: Phaser.Input.Pointer) => {
          if (pointer.event) {
            pointer.event.stopPropagation(); // Prevent click from propagating
          }
          this.toggleDrawingCallback();
        });
    } else {
      // Disabled state - no interaction
      crayonButton.setInteractive({ useHandCursor: false });
    }

    // Add player info texts to the player info container
    //playerInfoContainer.add(citySelectionManager);
    playerInfoContainer.add(nameAndMoney);
    playerInfoContainer.add(crayonButton);

    // Create build cost as separate text with dynamic color
    const buildCostY = infoY + 45;
    const buildCostText = this.scene.add
      .text(
        infoX, // Use same X as name/money
        buildCostY,
        `Build Cost: ${currentTrackCost}M${costWarning}`,
        {
          color: costColor,
          fontSize: "20px",
          fontStyle: "bold",
        }
      )
      .setOrigin(0.5, 0); // Center horizontally

    // Add build cost text to the player info container
    playerInfoContainer.add(buildCostText);

    // Add visual indicator for drawing mode
    if (isDrawingMode) {
      crayonButton.setScale(0.18);
      // Add glowing effect or highlight around the crayon
      const highlight = this.scene.add.circle(
        crayonButton.x,
        crayonButton.y,
        30, // Radius slightly larger than the crayon
        0xffff00, // Yellow glow
        0.3 // Semi-transparent
      );
      playerInfoContainer.add(highlight);
    } else {
      crayonButton.setScale(0.15);
    }

    // --- Undo button below crayon ---
    // Only show undo button if local player is active AND can undo
    // (isLocalPlayerActive already declared above for crayon button)
    if (isLocalPlayerActive && this.canUndo()) {
      const undoButton = this.scene.add
        .text(
          crayonButton.x,
          crayonButton.y + 50, // 50px below crayon
          "⟲ Undo",
          {
            color: "#ffffff",
            fontSize: "18px",
            fontStyle: "bold",
            backgroundColor: "#444",
            padding: { left: 8, right: 8, top: 4, bottom: 4 },
          }
        )
        .setOrigin(0.5, 0)
        .setInteractive({ useHandCursor: true });
      undoButton.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        if (pointer.event) pointer.event.stopPropagation();
        this.onUndo();
      });
      playerInfoContainer.add(undoButton);
    }
  }

  private createToggleButton(
    targetContainer: Phaser.GameObjects.Container,
    handHeight: number
  ): void {
    // Create toggle button in top-right corner
    const buttonX = this.scene.scale.width - 40;
    const buttonY = 20;

    // Create a simple arrow/chevron using graphics
    const toggleGraphics = this.scene.add.graphics();

    // Draw a downward-pointing chevron (when expanded, shows down arrow to collapse)
    const arrowSize = 15;
    const arrowColor = 0xffffff;

    toggleGraphics.lineStyle(3, arrowColor, 1);
    toggleGraphics.beginPath();
    toggleGraphics.moveTo(buttonX - arrowSize, buttonY - arrowSize / 2);
    toggleGraphics.lineTo(buttonX, buttonY + arrowSize / 2);
    toggleGraphics.lineTo(buttonX + arrowSize, buttonY - arrowSize / 2);
    toggleGraphics.strokePath();

    // Make it interactive
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

    targetContainer.add([toggleGraphics, hitArea]);
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

    targetContainer.add(statusBarBg);

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
        }
      )
      .setOrigin(0, 0.5);

    targetContainer.add(statusText);

    // Add mini train icon
    if (currentPlayer.trainType) {
      const trainType = currentPlayer.trainType
        .toLowerCase()
        .replace(/[\s-]+/g, "");
      try {
        const miniTrain = this.scene.add.image(
          this.scene.scale.width - 60,
          this.STATUS_BAR_HEIGHT / 2,
          `train_card_${trainType}`
        );
        miniTrain.setScale(0.08); // Much smaller scale for status bar
        miniTrain.setOrigin(0.5, 0.5);
        targetContainer.add(miniTrain);
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

    targetContainer.add([toggleGraphics, hitArea]);

    // Make entire status bar clickable to expand
    statusBarBg.setInteractive({ useHandCursor: true });
    statusBarBg.on("pointerdown", async () => {
      await this.toggleCollapse();
    });
  }

  private async toggleCollapse(): Promise<void> {
    this.isCollapsed = !this.isCollapsed;

    // If we have a current container, recreate the display with new state
    if (this.currentContainer) {
      await this.update(
        this.lastDrawingMode,
        this.lastTrackCost,
        this.currentContainer
      );
    }
  }

  public setCollapsed(collapsed: boolean): void {
    this.isCollapsed = collapsed;
  }

  public isHandCollapsed(): boolean {
    return this.isCollapsed;
  }

  public destroy(): void {
    if (this.trainCard) {
      this.trainCard.destroy();
    }
    this.container.destroy();
  }
}
