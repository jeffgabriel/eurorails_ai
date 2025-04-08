import "phaser";
import { GameState, Player, TerrainType, TrackSegment } from "../../shared/types/GameTypes";
import { GameStateService } from "../services/GameStateService";
import { MapRenderer } from "./MapRenderer";
import { TrainMovementManager } from "./TrainMovementManager";
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
  private isTrainMovementMode: boolean = false;
  private isDrawingMode: boolean = false;
  private trainMovementManager: TrainMovementManager;

  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    toggleDrawingCallback: () => void,
    nextPlayerCallback: () => void,
    openSettingsCallback: () => void,
    gameStateService: GameStateService,
    mapRenderer: MapRenderer
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.toggleDrawingCallback = toggleDrawingCallback;
    this.nextPlayerCallback = nextPlayerCallback;
    this.openSettingsCallback = openSettingsCallback;
    this.gameStateService = gameStateService;
    this.mapRenderer = mapRenderer;

    // Create containers
    this.uiContainer = this.scene.add.container(0, 0);
    this.playerHandContainer = this.scene.add.container(0, 0);
    this.trainContainer = this.scene.add.container(0, 0);

    // Initialize trainSprites map in gameState if not exists
    if (!this.gameState.trainSprites) {
      this.gameState.trainSprites = new Map();
    }
    this.trainMovementManager = new TrainMovementManager(this.gameState);
    this.setupTrainInteraction();
  }

  private justEnteredMovementMode: boolean = false;

  private setupTrainInteraction(): void {
    // Listen for pointer down events on the scene
    this.scene.input.on(
      "pointerdown",
      async (pointer: Phaser.Input.Pointer) => {
        // Only handle train placement if we're in train movement mode
        // AND we didn't just enter movement mode on this same click
        if (this.isTrainMovementMode && !this.justEnteredMovementMode) {
          // Stop event propagation to prevent other handlers
          if (pointer.event) {
            pointer.event.stopPropagation();
          }
          // Use await to ensure we handle the entire train placement process
          await this.handleTrainPlacement(pointer);
        }

        // Reset the flag after the click is processed
        this.justEnteredMovementMode = false;
      }
    );
  }

  private async handleTrainPlacement(
    pointer: Phaser.Input.Pointer
  ): Promise<void> {
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];

    console.log('Before movement - Player count:', this.gameState.players.length);
    console.log('Current players:', this.gameState.players.map(p => ({ id: p.id, name: p.name })));

    // Convert pointer position to world coordinates
    const worldPoint = this.scene.cameras.main.getWorldPoint(
      pointer.x,
      pointer.y
    );

    // Find the nearest milepost to the click that belongs to the current player
    const nearestMilepost = this.mapRenderer.findNearestMilepostOnOwnTrack(
      worldPoint.x,
      worldPoint.y,
      currentPlayer.id
    );

    if (nearestMilepost) {
      try {
        //where the train is coming from
        const previousPosition = currentPlayer.trainState.position;
        //check if the selected point is a valid move 
        const canMove =  this.trainMovementManager.canMoveTo(nearestMilepost);
        if (!canMove) {
          // Display the movement problem to the player
          const movementProblemText = this.scene.add.text(
            pointer.x,
            pointer.y,
            "Invalid move. You cannot move to this point.",
            {
              fontSize: "16px",
              color: "#ff0000",
              backgroundColor: "#ffffff",
              padding: { x: 10, y: 5 },
              align: "center",
            }
          );

          // Set a timeout to remove the text after a few seconds
          this.scene.time.addEvent({
            delay: 3000, // 3 seconds
            callback: () => {
              movementProblemText.destroy();
            },
          });
          console.log("Invalid move");
          return;
        }

        // Create a track segment for the movement history
        if (previousPosition) {
          const movementSegment: TrackSegment = {
            from: {
              x: previousPosition.x,
              y: previousPosition.y,
              row: previousPosition.row,
              col: previousPosition.col,
              terrain: TerrainType.Clear // We'll use Clear as default since we don't track terrain for movement
            },
            to: {
              x: nearestMilepost.x,
              y: nearestMilepost.y,
              row: nearestMilepost.row,
              col: nearestMilepost.col,
              terrain: nearestMilepost.terrain
            },
            cost: 0 // Movement cost is handled separately from track building cost
          };

          // Add to movement history
          if (!currentPlayer.trainState.movementHistory) {
            currentPlayer.trainState.movementHistory = [];
          }
          currentPlayer.trainState.movementHistory.push(movementSegment);
        }

        console.log('Before updateTrainPosition - Player count:', this.gameState.players.length);
        console.log('Current players:', this.gameState.players.map(p => ({ id: p.id, name: p.name })));

        // Update train position - await the async operation to complete
        await this.updateTrainPosition(
          currentPlayer.id,
          nearestMilepost.x,
          nearestMilepost.y,
          nearestMilepost.row,
          nearestMilepost.col
        );

        console.log('After updateTrainPosition - Player count:', this.gameState.players.length);
        console.log('Current players:', this.gameState.players.map(p => ({ id: p.id, name: p.name })));

        // Exit train movement mode only after the position update completes
        this.exitTrainMovementMode();
      } catch (error) {
        throw error;
      }
    }
  }

  private exitTrainMovementMode(): void {
    this.isTrainMovementMode = false;
    // Reset cursor style
    this.scene.input.setDefaultCursor("default");

    // Reset opacity for all train sprites
    this.gameState.trainSprites?.forEach((sprite) => {
      sprite.setAlpha(1);
    });
  }

  public enterTrainMovementMode(): void {
    this.isTrainMovementMode = true;
    this.justEnteredMovementMode = true; // Set flag to prevent immediate placement

    // Set cursor to indicate movement mode
    this.scene.input.setDefaultCursor("pointer");

    // Add visual indicator that train is selected
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    const trainSprite = this.gameState.trainSprites?.get(currentPlayer.id);
    if (trainSprite) {
      trainSprite.setAlpha(0.7); // Make train slightly transparent to indicate it's being moved
    }
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

  private updateTrainZOrders(): void {
    // Group trains by location
    const trainsByLocation = new Map<string, string[]>();

    this.gameState.players.forEach((player) => {
      if (player.trainState.position) {
        const locationKey = `${player.trainState.position.row},${player.trainState.position.col}`;
        const trains = trainsByLocation.get(locationKey) || [];
        trains.push(player.id);
        trainsByLocation.set(locationKey, trains);
      }
    });

    // Update z-order for each location with multiple trains
    trainsByLocation.forEach((trainsAtLocation) => {
      // First, bring non-current player trains to top in their original order
      trainsAtLocation.forEach((trainId) => {
        if (
          trainId !==
          this.gameState.players[this.gameState.currentPlayerIndex].id
        ) {
          const sprite = this.gameState.trainSprites?.get(trainId);
          if (sprite) {
            this.trainContainer.bringToTop(sprite);
          }
        }
      });

      // Finally, bring current player's train to the very top
      const currentPlayerSprite = this.gameState.trainSprites?.get(
        this.gameState.players[this.gameState.currentPlayerIndex].id
      );
      if (currentPlayerSprite) {
        this.trainContainer.bringToTop(currentPlayerSprite);
      }
    });
  }

  public setDrawingMode(isDrawing: boolean): void {
    this.isDrawingMode = isDrawing;
  }

  public async updateTrainPosition(
    playerId: string,
    x: number,
    y: number,
    row: number,
    col: number
  ): Promise<void> {
    const player = this.gameState.players.find((p) => p.id === playerId);
    if (!player) return;

    // Initialize trainState if it doesn't exist
    if (!player.trainState) {
      player.trainState = {
        position: null,
        remainingMovement: 0,
        movementHistory: []
      };
    }

    // Store the previous position before updating
    const previousPosition = player.trainState.position;

    // Update player position in database
    await this.gameStateService.updatePlayerPosition(playerId, x, y, row, col);

    // Find all trains at this location
    const trainsAtLocation = this.gameState.players
      .filter((p) => p.trainState?.position?.row === row && p.trainState?.position?.col === col)
      .map((p) => p.id);

    // Calculate offset based on position in stack
    const OFFSET_X = 5; // pixels to offset each train horizontally
    const OFFSET_Y = 5; // pixels to offset each train vertically
    const index = trainsAtLocation.indexOf(playerId);
    const offsetX = index * OFFSET_X;
    const offsetY = index * OFFSET_Y;

    // Helper function to set up train sprite interaction
    const setupTrainInteraction = (sprite: Phaser.GameObjects.Image) => {
      sprite
        .setInteractive({ useHandCursor: true })
        .on("pointerdown", (pointer: Phaser.Input.Pointer) => {
          console.log("Train clicked:", {
            playerId,
            isCurrentPlayer:
              playerId ===
              this.gameState.players[this.gameState.currentPlayerIndex].id,
            hasTrack: this.mapRenderer.playerHasTrack(playerId),
            isDrawingMode: this.isDrawingMode,
            isTrainMovementMode: this.isTrainMovementMode,
          });

          // Debug track data
          console.log("=== Debugging track data on train click ===");
          this.mapRenderer.debugTrackData();
          console.log("=====================================");

          // Only allow interaction if:
          // 1. This is the current player's train
          // 2. Not in drawing mode
          // 3. Player has track
          // 4. Not already in train movement mode
          const isCurrentPlayer =
            playerId ===
            this.gameState.players[this.gameState.currentPlayerIndex].id;
          const hasTrack = this.mapRenderer.playerHasTrack(playerId);

          if (
            isCurrentPlayer &&
            hasTrack &&
            !this.isDrawingMode &&
            !this.isTrainMovementMode
          ) {
            console.log("Entering train movement mode");
            // First stop event propagation to prevent it from being handled by the scene
            if (pointer.event) {
              pointer.event.stopPropagation();
            }
            // Then enter train movement mode
            this.enterTrainMovementMode();
          } else {
            console.log("Train movement mode conditions not met:", {
              isCurrentPlayer,
              hasTrack,
              notDrawingMode: !this.isDrawingMode,
              notTrainMovementMode: !this.isTrainMovementMode,
            });
          }
        });
    };

    // Update or create train sprite
    let trainSprite = this.gameState.trainSprites?.get(playerId);
    if (!trainSprite) {
      const colorMap: { [key: string]: string } = {
        "#FFD700": "yellow",
        "#FF0000": "red",
        "#0000FF": "blue",
        "#000000": "black",
        "#008000": "green",
        "#8B4513": "brown",
      };

      const trainColor = colorMap[player.color.toUpperCase()] || "black";
      const trainTexture =
        player.trainType === "Freight"
          ? `train_${trainColor}`
          : `train_12_${trainColor}`;

      trainSprite = this.scene.add.image(
        x + offsetX,
        y + offsetY,
        trainTexture
      );
      trainSprite.setScale(0.1); // Adjust scale as needed
      this.trainContainer.add(trainSprite);
      this.gameState.trainSprites?.set(playerId, trainSprite);
    } else {
      trainSprite.setPosition(x + offsetX, y + offsetY);
      // Remove any existing listeners to prevent duplicates
      trainSprite.removeAllListeners();
    }

    // Set up interaction for both new and existing sprites
    setupTrainInteraction(trainSprite);

    // Update z-ordering for all trains
    this.updateTrainZOrders();
  }

  public async initializePlayerTrain(
    playerId: string,
    startX: number,
    startY: number,
    startRow: number,
    startCol: number
  ): Promise<void> {
    await this.updateTrainPosition(
      playerId,
      startX,
      startY,
      startRow,
      startCol
    );
  }

  public resetTrainMovementMode(): void {
    if (this.isTrainMovementMode) {
      this.exitTrainMovementMode();
    }
  }

  public setupUIOverlay(): void {
    if (
      !this.gameState ||
      !this.gameState.players ||
      this.gameState.players.length === 0
    ) {
      return;
    }

    // Reset train movement mode when UI is refreshed
    this.resetTrainMovementMode();

    // Clear existing UI (but don't remove dropdowns)
    this.uiContainer.removeAll(true);

    // Store existing dropdown if any
    const existingDropdown = document.querySelector(".city-selection-dropdown") as HTMLSelectElement;
    const selectedValue = existingDropdown?.value;

    const LEADERBOARD_WIDTH = 150;
    const LEADERBOARD_PADDING = 10;

    // Add settings button
    const settingsButton = this.scene.add
      .rectangle(
        LEADERBOARD_PADDING,
        LEADERBOARD_PADDING,
        40,
        40,
        0x444444,
        0.9
      )
      .setOrigin(0, 0);

    const settingsIcon = this.scene.add
      .text(LEADERBOARD_PADDING + 20, LEADERBOARD_PADDING + 20, "⚙️", {
        fontSize: "24px",
      })
      .setOrigin(0.5);

    settingsButton
      .setInteractive({ useHandCursor: true })
      .on("pointerdown", () => this.openSettingsCallback())
      .on("pointerover", () => settingsButton.setFillStyle(0x555555))
      .on("pointerout", () => settingsButton.setFillStyle(0x444444));

    // Create semi-transparent background for leaderboard
    const leaderboardHeight = 40 + this.gameState.players.length * 20 + 50; // Added height for next player button
    const leaderboardBg = this.scene.add
      .rectangle(
        this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
        LEADERBOARD_PADDING,
        LEADERBOARD_WIDTH,
        leaderboardHeight,
        0x333333,
        0.9
      )
      .setOrigin(0, 0);

    // Add leaderboard title
    const leaderboardTitle = this.scene.add
      .text(
        this.scene.scale.width -
          LEADERBOARD_WIDTH -
          LEADERBOARD_PADDING +
          LEADERBOARD_WIDTH / 2,
        LEADERBOARD_PADDING + 5,
        "Players",
        {
          color: "#ffffff",
          fontSize: "16px",
          fontStyle: "bold",
        }
      )
      .setOrigin(0.5, 0);

    // Add all player entries
    const playerEntries = this.gameState.players
      .map((player, index) => {
        const isCurrentPlayer = index === this.gameState.currentPlayerIndex;

        // Create background highlight for current player
        let entryBg;
        if (isCurrentPlayer) {
          entryBg = this.scene.add
            .rectangle(
              this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
              LEADERBOARD_PADDING + 30 + index * 20,
              LEADERBOARD_WIDTH,
              20,
              0x666666,
              0.5
            )
            .setOrigin(0, 0);
        }

        // Create player text
        const playerText = this.scene.add
          .text(
            this.scene.scale.width -
              LEADERBOARD_WIDTH -
              LEADERBOARD_PADDING +
              5,
            LEADERBOARD_PADDING + 30 + index * 20,
            `${isCurrentPlayer ? "►" : " "} ${player.name}`,
            {
              color: "#ffffff",
              fontSize: "14px",
              fontStyle: isCurrentPlayer ? "bold" : "normal",
            }
          )
          .setOrigin(0, 0);

        // Create money text (right-aligned)
        const moneyText = this.scene.add
          .text(
            this.scene.scale.width - LEADERBOARD_PADDING - 5,
            LEADERBOARD_PADDING + 30 + index * 20,
            `${player.money}M`,
            {
              color: "#ffffff",
              fontSize: "14px",
              fontStyle: isCurrentPlayer ? "bold" : "normal",
            }
          )
          .setOrigin(1, 0); // Right-align

        // Return all elements for this player
        return entryBg
          ? [entryBg, playerText, moneyText]
          : [playerText, moneyText];
      })
      .flat(); // Flatten the array of arrays

    // Add next player button
    const nextPlayerButton = this.scene.add
      .rectangle(
        this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
        LEADERBOARD_PADDING + 40 + this.gameState.players.length * 20,
        LEADERBOARD_WIDTH,
        40,
        0x00aa00,
        0.9
      )
      .setOrigin(0, 0);

    const nextPlayerText = this.scene.add
      .text(
        this.scene.scale.width - LEADERBOARD_WIDTH / 2 - LEADERBOARD_PADDING,
        LEADERBOARD_PADDING + 60 + this.gameState.players.length * 20,
        "Next Player",
        {
          color: "#ffffff",
          fontSize: "16px",
          fontStyle: "bold",
        }
      )
      .setOrigin(0.5, 0.5);

    // Make the button interactive
    nextPlayerButton
      .setInteractive({ useHandCursor: true })
      .on("pointerdown", () => this.nextPlayerCallback())
      .on("pointerover", () => nextPlayerButton.setFillStyle(0x008800))
      .on("pointerout", () => nextPlayerButton.setFillStyle(0x00aa00));

    // Add all UI elements to container
    this.uiContainer.add([
      leaderboardBg,
      leaderboardTitle,
      ...playerEntries,
      nextPlayerButton,
      nextPlayerText,
      settingsButton,
      settingsIcon,
    ]);

    // Update train z-ordering for new current player
    this.updateTrainZOrders();
  }

  public setupPlayerHand(
    isDrawingMode: boolean = false,
    currentTrackCost: number = 0
  ): void {
    if (
      !this.gameState ||
      !this.gameState.players ||
      this.gameState.players.length === 0
    ) {
      return;
    }

    // Clear existing UI
    this.playerHandContainer.removeAll(true);

    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];

    // Create background for player's hand area
    const handBackground = this.scene.add
      .rectangle(
        0,
        this.scene.scale.height - 200, // Position from bottom of screen
        this.scene.scale.width,
        200,
        0x333333,
        0.8
      )
      .setOrigin(0, 0)
      .setDepth(0); // Set background to lowest depth

    this.playerHandContainer.add(handBackground);

    // Add sections for demand cards (3 slots)
    for (let i = 0; i < 3; i++) {
      console.log(`Creating card slot ${i}`);

      // Debug log for hand data
      console.log('Current player hand:', {
        playerName: currentPlayer.name,
        handLength: currentPlayer.hand?.length || 0,
        cardAtIndex: JSON.stringify(currentPlayer.hand?.[i]),
        allCards: JSON.stringify(currentPlayer.hand)
      });

      // Add card content if there's a card in this slot
      if (currentPlayer.hand?.[i]) {
        const card = currentPlayer.hand[i];
        console.log('Raw card data:', JSON.stringify(card));
        
        try {
          // Validate card data before displaying
          if (!card || !card.destinationCity || !card.resource || typeof card.payment !== 'number') {
            console.error('Invalid card data:', card);
            continue;
          }

          // Simple text display for debugging
          const cardText = 
            `CARD ${i + 1}:\n` +
            `City: ${card.destinationCity}\n` +
            `Resource: ${card.resource}\n` +
            `Payment: ${card.payment}M`;
          
          console.log('About to create text with:', cardText);
          
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

          this.playerHandContainer.add(cardContent);
          console.log(`Added card content for slot ${i}:`, {
            x: cardContent.x,
            y: cardContent.y,
            text: cardContent.text,
            visible: cardContent.visible,
            alpha: cardContent.alpha,
            depth: cardContent.depth,
            cardData: card
          });
        } catch (error) {
          console.error('Error creating card content:', error);
          console.error('Problem card data:', card);
        }
      } else {
        console.log(`No card data for slot ${i}`);
        
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
        
        this.playerHandContainer.add(emptyCardText);
      }
    }

    // Create train card section with higher depth
    const trainSection = this.scene.add
      .rectangle(
        600, // Position after demand cards
        this.scene.scale.height - 180, // Align with demand cards
        180, // Width
        160, // Height
        0x666666
      )
      .setOrigin(0, 0)
      .setDepth(1);

    const trainLabel = this.scene.add
      .text(
        690, // Center above train card
        this.scene.scale.height - 195, // Align with other labels
        `${currentPlayer.trainType}`,
        {
          color: "#ffffff",
          fontSize: "14px",
        }
      )
      .setOrigin(0.5, 0)
      .setDepth(1);

    // Add crayon button
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
      this.playerHandContainer.add(highlight);
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
    // Add elements to container in correct order
    this.playerHandContainer.add([
      trainSection,
      trainLabel,
      playerInfo,
      crayonButton,
    ]); // Then add UI elements
  }

  public cleanupCityDropdowns(): void {
    const existingDropdowns = document.querySelectorAll(
      ".city-selection-dropdown"
    );
    existingDropdowns.forEach((dropdown) => {
      document.body.removeChild(dropdown);
    });
  }

  public showCitySelectionForPlayer(playerId: string): void {
    // Only show selection for current player
    console.log("Showing city selection for player:", playerId);
    
    // Find the player
    const player = this.gameState.players.find((p) => p.id === playerId);
    if (!player) {
      console.log("Player not found");
      return;
    }

    // Check if this is the current player
    const isCurrentPlayer = this.gameState.players[this.gameState.currentPlayerIndex].id === playerId;
    if (!isCurrentPlayer) {
      console.log("Not current player");
      return;
    }

    // Check if player already has a position
    // Handle cases where trainState might be undefined or position might be null/undefined
    if (player.trainState && player.trainState.position) {
      console.log("Player already has position:", player.trainState.position);
      return;
    }
    
    console.log("Player needs to select a starting position - no position found");

    // Remove any existing city selection dropdowns
    this.cleanupCityDropdowns();

    // Find all major cities from the grid
    const majorCities = [
      ...new Map(
        this.mapRenderer.gridPoints
          .flat()
          .filter((point) => point?.city?.type === TerrainType.MajorCity)
          .map((point) => [
            point.city!.name, // use name as key for uniqueness
            {
              name: point.city!.name,
              x: point.x,
              y: point.y,
              row: point.row,
              col: point.col,
            },
          ])
      ).values(),
    ];

    // Create dropdown (using HTML overlay)
    const dropdown = document.createElement("select");
    dropdown.className = "city-selection-dropdown"; // Add class for easy cleanup
    dropdown.style.position = "absolute";
    dropdown.style.left = "820px"; // Align with player info
    dropdown.style.top = `${this.scene.scale.height - 140}px`; // Fixed position aligned with player info
    dropdown.style.width = "180px";
    dropdown.style.padding = "5px";
    dropdown.style.backgroundColor = "#444444";
    dropdown.style.color = "#ffffff";
    dropdown.style.border = "1px solid #666666";
    dropdown.style.zIndex = "1000"; // Ensure it appears above other elements

    // Add prompt option
    const promptOption = document.createElement("option");
    promptOption.value = "";
    promptOption.text = "Choose Starting City...";
    promptOption.disabled = true;
    promptOption.selected = true;
    dropdown.appendChild(promptOption);

    // Add options for each major city
    majorCities.forEach((city) => {
      const option = document.createElement("option");
      option.value = JSON.stringify({
        name: city.name,
        x: city.x,
        y: city.y,
        row: city.row,
        col: city.col,
      });
      option.text = city.name;
      dropdown.appendChild(option);

      // If this city matches player's current position, select it
      if (player.trainState?.position && 
          player.trainState.position.row === city.row && 
          player.trainState.position.col === city.col) {
        option.selected = true;
        promptOption.selected = false;
      }
    });

    // Handle selection
    dropdown.onchange = () => {
      if (!dropdown.value) return; // Don't process if prompt is selected
      const selectedCity = JSON.parse(dropdown.value);
      this.initializePlayerTrain(
        playerId,
        selectedCity.x,
        selectedCity.y,
        selectedCity.row,
        selectedCity.col
      );
      // Note: No longer removing dropdown here - it will be removed when track is built
    };

    console.log("Adding dropdown to document body", {
      top: dropdown.style.top,
      left: dropdown.style.left,
      width: dropdown.style.width
    });
    document.body.appendChild(dropdown);
    console.log("Dropdown added to document body, element count:", document.querySelectorAll('.city-selection-dropdown').length);
  }
}
