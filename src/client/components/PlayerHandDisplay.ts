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
    const maxCards = 3; // Maximum number of demand cards in hand (changed from 4 to 3)
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
      20, // Position relative to hand area
      currentPlayer
    );

    // Update the loads display
    this.trainCard.updateLoads();

    // Add the train card's container to the target container
    targetContainer.add(this.trainCard.getContainer());
  }

  private createPlayerInfoSection(isDrawingMode: boolean, currentTrackCost: number, targetContainer: Phaser.GameObjects.Container): void {
    const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];

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

    // Add player info with track cost if in drawing mode
    let playerInfoText = `${currentPlayer.name}\nMoney: ECU ${currentPlayer.money}M`;
    // Show the cost even if zero, with more descriptive label
    playerInfoText += `\nBuild Cost: ${currentTrackCost}M`;
    
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

    const playerInfo = this.scene.add
      .text(
        820, // Position after train card
        100, // Position relative to hand area
        playerInfoText,
        {
          color: "#ffffff", // Changed to white for better visibility
          fontSize: "20px",
          fontStyle: "bold",
        }
      )
      .setOrigin(0, 0);
      
    targetContainer.add([playerInfo, crayonButton]);
  }

  public destroy(): void {
    if (this.trainCard) {
      this.trainCard.destroy();
    }
    this.container.destroy();
  }
}