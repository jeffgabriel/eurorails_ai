import "phaser";
import { GameState } from "../../shared/types/GameTypes";
import { TrainCard } from "./TrainCard";
import { DemandCard } from './DemandCard';
import { PlayerHand } from '../../shared/types/PlayerHand';

export class PlayerHandDisplay {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private gameState: GameState;
  private toggleDrawingCallback: () => void;
  public trainCard: TrainCard | null = null;
  private readonly CARD_SPACING = 180;
  private readonly START_X = 110;
  private readonly START_Y = 140;
  private cards: DemandCard[] = [];
  private readonly HAND_HEIGHT = 280;
  private currentContainer: Phaser.GameObjects.Container | null = null;
  
  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    toggleDrawingCallback: () => void
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.toggleDrawingCallback = toggleDrawingCallback;
    this.container = this.scene.add.container(0, 0);
  }
  
  public update(isDrawingMode: boolean = false, currentTrackCost: number = 0, targetContainer: Phaser.GameObjects.Container): void {
    if (!this.gameState || !this.gameState.players || this.gameState.players.length === 0) {
      return;
    }

    // Clean up old train card if it exists
    if (this.trainCard) {
      this.trainCard.destroy();
      this.trainCard = null;
    }

    // Clear target container
    targetContainer.removeAll(true);

    // Create a container for the hand area that will hold all elements
    const handArea = this.scene.add.container(0, this.scene.scale.height - this.HAND_HEIGHT);
    targetContainer.add(handArea);

    // Create the background, cards, and player info sections and add to handArea
    this.createHandBackground(handArea);
    this.createDemandCardSection(handArea);
    this.createTrainSection(handArea);
    this.createPlayerInfoSection(isDrawingMode, currentTrackCost, handArea);

    // Store reference to the current container
    this.currentContainer = targetContainer;
  }

  private createHandBackground(targetContainer: Phaser.GameObjects.Container): void {
    // Create background for player's hand area
    const handBackground = this.scene.add
      .rectangle(
        0,
        0, // Position relative to hand area container
        this.scene.scale.width,
        this.HAND_HEIGHT,
        0x333333,
        0.8
      )
      .setOrigin(0, 0)
      .setDepth(0); // Set background to lowest depth

    targetContainer.add(handBackground);
  }

  private createDemandCardSection(targetContainer: Phaser.GameObjects.Container): void {
    const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];

    // Clear existing cards
    this.cards.forEach(card => card.destroy());
    this.cards = [];

    // Create new cards
    currentPlayer.hand.forEach((card, index) => {
      const x = this.START_X + (index * this.CARD_SPACING);
      const demandCard = new DemandCard(this.scene, x, this.START_Y, card);
      this.cards.push(demandCard);
      targetContainer.add(demandCard);
    });

    // Add empty slots if needed
    const maxCards = 3; // Maximum number of demand cards in hand
    for (let i = currentPlayer.hand.length; i < maxCards; i++) {
      const x = this.START_X + (i * this.CARD_SPACING);
      const emptyCard = new DemandCard(this.scene, x, this.START_Y);
      this.cards.push(emptyCard);
      targetContainer.add(emptyCard);
    }
  }

  private createTrainSection(targetContainer: Phaser.GameObjects.Container): void {
    const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];

    // Create train card using the TrainCard component
    this.trainCard = new TrainCard(
      this.scene,
      600, // Position after demand cards
      13, // Position relative to hand area
      currentPlayer
    );

    // Update the loads display
    this.trainCard.updateLoads();

    // Add the train card's container to the target container
    targetContainer.add(this.trainCard.getContainer());
  }

  private createPlayerInfoSection(isDrawingMode: boolean, currentTrackCost: number, targetContainer: Phaser.GameObjects.Container): void {
    const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
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

    const crayonColor = colorMap[currentPlayer.color.toUpperCase()] || "black";
    const crayonTexture = `crayon_${crayonColor}`;

    // Position crayon relative to player info
    const crayonButton = this.scene.add
      .image(
        820 + 200, // Position 200 pixels right of player info start
        140, // Position relative to hand area
        crayonTexture
      )
      .setScale(0.15)
      .setInteractive({ useHandCursor: true });

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
    
    // Create separate text objects for better color control
    const nameAndMoney = this.scene.add
      .text(
        820,
        100,
        playerInfoText,
        {
          color: "#ffffff",
          fontSize: "20px",
          fontStyle: "bold",
        }
      )
      .setOrigin(0, 0);

    // Create build cost as separate text with dynamic color
    const buildCostText = this.scene.add
      .text(
        820,
        145,
        `Build Cost: ${currentTrackCost}M${costWarning}`,
        {
          color: costColor,
          fontSize: "20px",
          fontStyle: "bold",
        }
      )
      .setOrigin(0, 0);
    
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
      targetContainer.add(highlight);
    } else {
      crayonButton.setScale(0.15);
    }
      
    targetContainer.add([nameAndMoney, buildCostText, crayonButton]);
  }

  public destroy(): void {
    if (this.trainCard) {
      this.trainCard.destroy();
    }
    this.container.destroy();
  }
}