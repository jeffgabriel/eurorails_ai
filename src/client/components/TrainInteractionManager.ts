import "phaser";
import { GameState, GridPoint, Player, TerrainType, TrackSegment, CityData } from "../../shared/types/GameTypes";
import { GameStateService } from "../services/GameStateService";
import { MapRenderer } from "./MapRenderer";
import { TrainMovementManager } from "./TrainMovementManager";
import { LoadService } from "../services/LoadService";
import { PlayerHandDisplay } from "./PlayerHandDisplay";
import { UIManager } from "./UIManager";
import { TrackDrawingManager } from "./TrackDrawingManager";
import { majorCityGroups } from '../config/mapConfig';

export class TrainInteractionManager {
  private scene: Phaser.Scene;
  private gameState: GameState;
  private trainMovementManager: TrainMovementManager;
  private mapRenderer: MapRenderer;
  private gameStateService: GameStateService;
  private trainContainer: Phaser.GameObjects.Container;
  private isTrainMovementMode: boolean = false;
  private justEnteredMovementMode: boolean = false;
  private isDrawingMode: boolean = false;
  private playerHandDisplay: PlayerHandDisplay | null = null;
  private handContainer: Phaser.GameObjects.Container | null = null;
  private uiManager: UIManager | null = null;
  private trackDrawingManager: TrackDrawingManager;
  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    trainMovementManager: TrainMovementManager,
    mapRenderer: MapRenderer,
    gameStateService: GameStateService,
    trainContainer: Phaser.GameObjects.Container,
    trackDrawingManager: TrackDrawingManager
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.trainMovementManager = trainMovementManager;
    this.mapRenderer = mapRenderer;
    this.gameStateService = gameStateService;
    this.trainContainer = trainContainer;
    this.trackDrawingManager = trackDrawingManager;
    // Initialize trainSprites map in gameState if not exists
    if (!this.gameState.trainSprites) {
      this.gameState.trainSprites = new Map();
    }
    
    this.setupTrainInteraction();
  }
  
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

  public playerHasTrack(playerId: string): boolean {
    // Get player's track state from TrackDrawingManager
    const playerTrackState =
      this.trackDrawingManager.getPlayerTrackState(playerId);
    if (!playerTrackState || !playerTrackState.segments) {
      return false;
    }
    return playerTrackState.segments.length > 0;
  }

  public findNearestMilepostOnOwnTrack(
    x: number,
    y: number,
    playerId: string
  ): GridPoint | null {
    // First, get the clicked point using TrackDrawingManager's method
    const clickedPoint = this.trackDrawingManager.getGridPointAtPosition(x, y);

    if (!clickedPoint) {
      return null;
    }

    // Get the player's track state
    const playerTrackState =
      this.trackDrawingManager.getPlayerTrackState(playerId);
    if (!playerTrackState || !playerTrackState.segments) {
      return null;
    }

    // Check if the clicked point is part of any of the player's track segments
    const isOnPlayerTrack = playerTrackState.segments.some(
      (segment) =>
        // Check both ends of each segment
        (segment.from.row === clickedPoint.row &&
          segment.from.col === clickedPoint.col) ||
        (segment.to.row === clickedPoint.row &&
          segment.to.col === clickedPoint.col)
    );

    if (isOnPlayerTrack) {
      return clickedPoint;
    }

    // If not, find the nearest point that is part of a player's track segment
    let nearestPoint: GridPoint | null = null;
    let minDistance = Infinity;

    // Create a set of all points that are part of the player's track network
    const trackPoints = new Set<string>();
    playerTrackState.segments.forEach((segment) => {
      trackPoints.add(`${segment.from.row},${segment.from.col}`);
      trackPoints.add(`${segment.to.row},${segment.to.col}`);
    });

    // Search through adjacent points first (within a reasonable radius)
    const searchRadius = 3; // Adjust this value as needed
    const rowStart = Math.max(0, clickedPoint.row - searchRadius);
    const rowEnd = Math.min(
      this.mapRenderer.gridPoints.length - 1,
      clickedPoint.row + searchRadius
    );

    for (let row = rowStart; row <= rowEnd; row++) {
      if (!this.mapRenderer.gridPoints[row]) continue;

      const colStart = Math.max(0, clickedPoint.col - searchRadius);
      const colEnd = Math.min(
        this.mapRenderer.gridPoints[row].length - 1,
        clickedPoint.col + searchRadius
      );

      for (let col = colStart; col <= colEnd; col++) {
        const point = this.mapRenderer.gridPoints[row][col];
        if (!point || point.terrain === TerrainType.Water) continue;

        // Check if this point is part of the player's track network
        if (trackPoints.has(`${point.row},${point.col}`)) {
          // Calculate distance to this point
          const dx = point.x - clickedPoint.x;
          const dy = point.y - clickedPoint.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          // Update nearest point if this is closer
          if (distance < minDistance) {
            minDistance = distance;
            nearestPoint = point;
          }
        }
      }
    }

    if (nearestPoint) {
      return nearestPoint;
    }

    return null;
  }
  
  private async handleTrainPlacement(
    pointer: Phaser.Input.Pointer
  ): Promise<void> {
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];

    // Convert pointer position to world coordinates
    const worldPoint = this.scene.cameras.main.getWorldPoint(
      pointer.x,
      pointer.y
    );

    // Find the nearest milepost to the click that belongs to the current player
    const nearestMilepost = this.findNearestMilepostOnOwnTrack(
      worldPoint.x,
      worldPoint.y,
      currentPlayer.id
    );

    if (nearestMilepost) {
      try {
        //where the train is coming from
        const previousPosition = currentPlayer.trainState.position;
        //check if the selected point is a valid move 
        const moveResult = this.trainMovementManager.canMoveTo(nearestMilepost);
        if (!moveResult.canMove) {
          this.showInvalidMoveMessage(pointer);
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

        // Update train position - await the async operation to complete
        await this.updateTrainPosition(
          currentPlayer.id,
          nearestMilepost.x,
          nearestMilepost.y,
          nearestMilepost.row,
          nearestMilepost.col
        );

        // Check if arrived at any city
        if (nearestMilepost.terrain === TerrainType.MajorCity || 
            nearestMilepost.terrain === TerrainType.MediumCity ||
            nearestMilepost.terrain === TerrainType.SmallCity) {
          this.handleCityArrival(currentPlayer, nearestMilepost);
        }

        // If arrived at a ferry port, or if movement should end, exit movement mode
        if (moveResult.endMovement) {
          this.exitTrainMovementMode();
        }
      } catch (error) {
        throw error;
      }
    }
  }
  
  private showInvalidMoveMessage(pointer: Phaser.Input.Pointer): void {
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
  }
  
  private async handleCityArrival(
    currentPlayer: Player, 
    nearestMilepost: any
  ): Promise<void> {
    // Always use the city property on the grid point
    const cityData = nearestMilepost.city;
    if (!cityData) return;
    // Get the LoadService instance to check available loads
    const loadService = LoadService.getInstance();
    // Check if train has any loads that could potentially be delivered
    const hasLoads = currentPlayer.trainState.loads && currentPlayer.trainState.loads.length > 0;
    // Check if city has any loads available for pickup
    const cityLoads = await loadService.getCityLoadDetails(cityData.name);
    const cityHasLoads = cityLoads && cityLoads.length > 0;
    // Show dialog if either:
    // 1. Train has loads (could be delivered or dropped)
    // 2. City has loads (can be picked up, possibly after dropping current loads)
    if (hasLoads || cityHasLoads) {
      this.showLoadDialog(currentPlayer, cityData);
    }
  }
  
  private showLoadDialog(player: Player, city: any): void {
    if (!this.uiManager) {
      return;
    }

    this.scene.scene.launch('LoadDialogScene', {
      city: city,
      player: player,
      gameState: this.gameState,
      onClose: () => {
        this.scene.scene.stop('LoadDialogScene');
      },
      onUpdateTrainCard: () => {
        // Update the train card display through PlayerHandDisplay
        if (this.playerHandDisplay?.trainCard) {
          this.playerHandDisplay.trainCard.updateLoads();
        }
      },
      onUpdateHandDisplay: () => {
        // Update the entire player hand display using the existing container
        if (this.playerHandDisplay && this.handContainer) {
          this.playerHandDisplay.update(false, 0, this.handContainer);
        }
      },
      uiManager: this.uiManager
    });
  }
  
  public async enterTrainMovementMode(): Promise<void> {
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    const trainSprite = this.gameState.trainSprites?.get(currentPlayer.id);
    
    // Check if train just arrived at ferry - if so, prevent movement
    if (currentPlayer.trainState.ferryState?.status === 'just_arrived') {
      // console.log("Cannot enter movement mode - just arrived at ferry this turn");
      return;
    }
    
    this.isTrainMovementMode = true;
    this.justEnteredMovementMode = true; // Set flag to prevent immediate placement

    // Set cursor to indicate movement mode
    this.scene.input.setDefaultCursor("pointer");

    // Add visual indicator that train is selected
    if (trainSprite) {
      trainSprite.setAlpha(0.7); // Make train slightly transparent to indicate it's being moved
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
  
  public resetTrainMovementMode(): void {
    if (this.isTrainMovementMode) {
      this.exitTrainMovementMode();
    }
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
        movementHistory: [],
        loads: [] // Initialize empty loads array
      };
    }

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

    // Update or create train sprite
    let trainSprite = this.gameState.trainSprites?.get(playerId);
    if (!trainSprite) {
      trainSprite = this.createTrainSprite(player, x + offsetX, y + offsetY);
      this.gameState.trainSprites?.set(playerId, trainSprite);
      
      // Set up interaction for new sprites
      this.setupTrainSpriteInteraction(trainSprite, playerId);
    } else {
      // Just update position for existing sprites
      trainSprite.setPosition(x + offsetX, y + offsetY);
      
      // Make sure it's still interactive
      if (!trainSprite.input) {
        trainSprite.setInteractive({ useHandCursor: true });
        this.setupTrainSpriteInteraction(trainSprite, playerId);
      }
    }

    // Update z-ordering for all trains
    this.updateTrainZOrders();
  }
  
  private createTrainSprite(
    player: Player, 
    x: number, 
    y: number
  ): Phaser.GameObjects.Image {
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

    const trainSprite = this.scene.add.image(x, y, trainTexture);
    trainSprite.setScale(0.1); // Adjust scale as needed
    this.trainContainer.add(trainSprite);
    
    return trainSprite;
  }
  
  private setupTrainSpriteInteraction(
    sprite: Phaser.GameObjects.Image, 
    playerId: string
  ): void {
    // Make sprite interactive with hand cursor
    sprite.setInteractive({ useHandCursor: true });
    
    // Remove any existing listeners to prevent duplicates
    sprite.removeAllListeners('pointerdown');
    
    // Add the pointer down listener
    sprite.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      // Only allow interaction if:
      // 1. This is the current player's train
      // 2. Not in drawing mode
      // 3. Player has track
      // 4. Not already in train movement mode
      const isCurrentPlayer =
        playerId ===
        this.gameState.players[this.gameState.currentPlayerIndex].id;
      const hasTrack = this.playerHasTrack(playerId);

      if (
        isCurrentPlayer &&
        hasTrack &&
        !this.isDrawingMode &&
        !this.isTrainMovementMode
      ) {
        // First stop event propagation to prevent it from being handled by the scene
        if (pointer.event) {
          pointer.event.stopPropagation();
        }
        // Then enter train movement mode
        this.enterTrainMovementMode();
      }
    });
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
  
  public setDrawingMode(isDrawing: boolean): void {
    this.isDrawingMode = isDrawing;
    
    // When entering drawing mode, exit train movement mode if active
    if (isDrawing && this.isTrainMovementMode) {
      this.exitTrainMovementMode();
    }
  }

  public setPlayerHandDisplay(playerHandDisplay: PlayerHandDisplay): void {
    this.playerHandDisplay = playerHandDisplay;
  }

  public setHandContainer(container: Phaser.GameObjects.Container): void {
    this.handContainer = container;
  }

  public setUIManager(uiManager: UIManager): void {
    this.uiManager = uiManager;
  }
}