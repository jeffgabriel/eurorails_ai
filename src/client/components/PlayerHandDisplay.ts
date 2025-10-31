import "phaser";
import { GameState } from "../../shared/types/GameTypes";
import { TrainCard } from "./TrainCard";
import { DemandCard } from './DemandCard';
import { PlayerHand } from '../../shared/types/PlayerHand';
import { GameStateService } from "../services/GameStateService";

export class PlayerHandDisplay {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private gameState: GameState;
  private toggleDrawingCallback: () => void;
  private onUndo: () => void;
  private canUndo: () => boolean;
  private gameStateService: GameStateService | null = null;
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
    toggleDrawingCallback: () => void,
    onUndo: () => void,
    canUndo: () => boolean,
    gameStateService?: GameStateService
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.toggleDrawingCallback = toggleDrawingCallback;
    this.onUndo = onUndo;
    this.canUndo = canUndo;
    this.gameStateService = gameStateService || null;
    this.container = this.scene.add.container(0, 0);
  }
  
  public async update(isDrawingMode: boolean = false, currentTrackCost: number = 0, targetContainer: Phaser.GameObjects.Container): Promise<void> {
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
    await this.createDemandCardSection(handArea);
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

  private async createDemandCardSection(targetContainer: Phaser.GameObjects.Container): Promise<void> {
    // Show only local player's cards
    const localPlayerId = this.gameStateService?.getLocalPlayerId();
    const currentPlayer = localPlayerId 
      ? this.gameState.players.find(p => p.id === localPlayerId)
      : this.gameState.players[this.gameState.currentPlayerIndex];
    
    // If no local player found, don't show cards
    if (!currentPlayer) {
      return;
    }

    // Clear existing cards
    this.cards.forEach(card => card.destroy());
    this.cards = [];

    // If player has no cards (lobby players), try to draw some
    if (currentPlayer.hand.length === 0) {
      console.log(`Player ${currentPlayer.name} has no cards, drawing demand cards...`);
      try {
        // Import DemandDeckService dynamically to avoid circular dependencies
        const { DemandDeckService } = await import('../../shared/services/DemandDeckService');
        const deckService = new DemandDeckService();
        console.log('Loading demand cards from server...');
        await deckService.loadCards();
        console.log('Demand cards loaded successfully');
        
        // Draw 3 cards for the player
        for (let i = 0; i < 3; i++) {
          const card = await deckService.drawCard();
          if (card) {
            currentPlayer.hand.push(card);
            console.log(`Drew card ${i + 1}:`, card);
          } else {
            console.warn(`Failed to draw card ${i + 1}`);
          }
        }
        console.log(`Successfully drew ${currentPlayer.hand.length} cards for player ${currentPlayer.name}`);
      } catch (error) {
        console.error('Failed to draw demand cards for player:', error);
        // Create placeholder cards so the UI doesn't break
        console.log('Creating placeholder cards for UI display');
        for (let i = 0; i < 3; i++) {
          currentPlayer.hand.push({
            id: `placeholder_${i}`,
            demands: [
              { city: 'PLACEHOLDER', resource: 'PLACEHOLDER', payment: 0 }
            ]
          } as any);
        }
      }
    }

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
    // Show local player's train card
    const localPlayerId = this.gameStateService?.getLocalPlayerId();
    const currentPlayer = localPlayerId 
      ? this.gameState.players.find(p => p.id === localPlayerId)
      : this.gameState.players[this.gameState.currentPlayerIndex];

    // Validate current player exists
    if (!currentPlayer) {
      console.error('PlayerHandDisplay.createTrainSection: No local player found');
      return;
    }

    // Ensure player has a trainType
    if (!currentPlayer.trainType) {
      console.warn('PlayerHandDisplay.createTrainSection: Player missing trainType, defaulting to Freight');
      currentPlayer.trainType = 'freight' as any; // Use any to avoid type issues
    }

    try {
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
    } catch (error) {
      console.error('PlayerHandDisplay.createTrainSection: Failed to create train card:', error);
    }
  }

  private createPlayerInfoSection(isDrawingMode: boolean, currentTrackCost: number, targetContainer: Phaser.GameObjects.Container): void {
    // Show local player's info
    const localPlayerId = this.gameStateService?.getLocalPlayerId();
    const currentPlayer = localPlayerId 
      ? this.gameState.players.find(p => p.id === localPlayerId)
      : this.gameState.players[this.gameState.currentPlayerIndex];
    
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
    
    // Calculate responsive positions based on scene width
    // City dropdown positioning (matching CitySelectionManager)
    const dropdownLeft = Math.min(820, this.scene.scale.width - 200);
    const dropdownWidth = 180;
    const dropdownCenterX = dropdownLeft + dropdownWidth / 2;
    
    // Create separate text objects for better color control
    // Position below city dropdown but ensure responsive
    const nameAndMoney = this.scene.add
      .text(
        dropdownCenterX, // Position below city dropdown
        60, // Position below the dropdown (dropdown is ~40px tall at 20px from top)
        playerInfoText,
        {
          color: "#ffffff",
          fontSize: "20px",
          fontStyle: "bold",
        }
      )
      .setOrigin(0.5, 0); // Center horizontally

    // Calculate text bounds to position crayon to the right
    const textBounds = nameAndMoney.getBounds();
    
    // Position crayon to the right of the money text
    const crayonX = textBounds.right + 40; // 40px spacing from text
    const crayonY = 70; // Align vertically with money text area
    
    const crayonColor = colorMap[currentPlayer.color.toUpperCase()] || "black";
    const crayonTexture = `crayon_${crayonColor}`;
    
    // Check if local player is active
    const isLocalPlayerActive = this.gameStateService?.isLocalPlayerActive() ?? false;
    
    const crayonButton = this.scene.add
      .image(
        crayonX,
        crayonY,
        crayonTexture
      )
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

    // Add player info texts to the hand area container first so they render behind
    targetContainer.add(nameAndMoney);
    
    // Add crayon to the hand area container so it moves with the hand
    targetContainer.add(crayonButton);

    // Create build cost as separate text with dynamic color
    const buildCostText = this.scene.add
      .text(
        dropdownCenterX, // Position below city dropdown
        105, // Position below money text
        `Build Cost: ${currentTrackCost}M${costWarning}`,
        {
          color: costColor,
          fontSize: "20px",
          fontStyle: "bold",
        }
      )
      .setOrigin(0.5, 0); // Center horizontally

    // Add build cost text to the hand area container
    targetContainer.add(buildCostText);
    
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

    // --- Undo button below crayon ---
    // Only show undo button if local player is active AND can undo
    // (isLocalPlayerActive already declared above for crayon button)
    if (isLocalPlayerActive && this.canUndo()) {
      const undoButton = this.scene.add
        .text(
          crayonButton.x,
          crayonButton.y + 50, // 50px below crayon
          '⟲ Undo',
          {
            color: '#ffffff',
            fontSize: '18px',
            fontStyle: 'bold',
            backgroundColor: '#444',
            padding: { left: 8, right: 8, top: 4, bottom: 4 },
          }
        )
        .setOrigin(0.5, 0)
        .setInteractive({ useHandCursor: true });
      undoButton.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
        if (pointer.event) pointer.event.stopPropagation();
        this.onUndo();
      });
      targetContainer.add(undoButton);
    }
  }

  public destroy(): void {
    if (this.trainCard) {
      this.trainCard.destroy();
    }
    this.container.destroy();
  }
}