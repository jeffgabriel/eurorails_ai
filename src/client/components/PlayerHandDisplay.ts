import "phaser";
import { GameState } from "../../shared/types/GameTypes";
import { TrainCard } from "./TrainCard";

export class PlayerHandDisplay {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private gameState: GameState;
  private toggleDrawingCallback: () => void;
  public trainCard: TrainCard | null = null;
  
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

    // Create the background, cards, and player info sections and add directly to target container
    this.createHandBackground(targetContainer);
    this.createDemandCardSection(targetContainer);
    this.createTrainSection(targetContainer);
    this.createPlayerInfoSection(isDrawingMode, currentTrackCost, targetContainer);
  }

  private createHandBackground(targetContainer: Phaser.GameObjects.Container): void {
    // Create background for player's hand area
    const handBackground = this.scene.add
      .rectangle(
        0,
        this.scene.scale.height - 280, // Increased from -250 to -280 for more height
        this.scene.scale.width,
        280, // Increased from 250 to 280
        0x333333,
        0.8
      )
      .setOrigin(0, 0)
      .setDepth(0); // Set background to lowest depth

    targetContainer.add(handBackground);
  }

  private createDemandCardSection(targetContainer: Phaser.GameObjects.Container): void {
    const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];

    // Add sections for demand cards (3 slots)
    for (let i = 0; i < 3; i++) {
      // Add card content if there's a card in this slot
      if (currentPlayer.hand?.[i]) {
        const card = currentPlayer.hand[i];
        
        // Validate card data before displaying
        if (!card || !card.destinationCity || !card.resource || typeof card.payment !== 'number') {
          continue;
        }

        // Simple text display
        const cardText = 
          `CARD ${i + 1}:\n` +
          `City: ${card.destinationCity}\n` +
          `Resource: ${card.resource}\n` +
          `Payment: ${card.payment}M`;
        
        const CARD_WIDTH = 160;
        const CARD_SPACING = 20;
        const CARD_START_X = 30;
        
        const cardContent = this.scene.add.text(
          CARD_START_X + i * (CARD_WIDTH + CARD_SPACING), // Space cards evenly
          this.scene.scale.height - 150, // Position from bottom
          cardText,
          {
            color: "#000000", // Black text
            fontSize: "16px",
            backgroundColor: "#F5F5DC", // Cream color
            padding: { x: 15, y: 15 },
            fixedWidth: CARD_WIDTH,
            align: 'left',
            wordWrap: { width: CARD_WIDTH - 30 } // Account for padding
          }
        ).setDepth(1); // Set cards to higher depth than background

        targetContainer.add(cardContent);
      } else {
        // Display empty card slot
        const CARD_WIDTH = 160;
        const CARD_SPACING = 20;
        const CARD_START_X = 30;
        
        const emptyCardText = this.scene.add.text(
          CARD_START_X + i * (CARD_WIDTH + CARD_SPACING),
          this.scene.scale.height - 150,
          'Empty\nCard\nSlot',
          {
            color: "#666666", // Gray text
            fontSize: "16px",
            backgroundColor: "#EEEEEE", // Light gray background
            padding: { x: 15, y: 15 },
            fixedWidth: CARD_WIDTH,
            align: 'center',
            wordWrap: { width: CARD_WIDTH - 30 }
          }
        ).setDepth(1);
        
        targetContainer.add(emptyCardText);
      }
    }
  }

  private createTrainSection(targetContainer: Phaser.GameObjects.Container): void {
    const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];

    // Create train card using the TrainCard component
    this.trainCard = new TrainCard(
      this.scene,
      600, // Position after demand cards
      this.scene.scale.height - 270, // Moved up further from -250
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
        this.scene.scale.height - 140, // Vertically center between player info lines
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
        this.scene.scale.height - 180, // Align with cards
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