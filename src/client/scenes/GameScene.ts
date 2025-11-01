import "phaser";
import { GameState, Player, TrainType, TRAIN_PROPERTIES } from "../../shared/types/GameTypes";
import { MapRenderer } from "../components/MapRenderer";
import { CameraController } from "../components/CameraController";
import { TrackDrawingManager } from "../components/TrackDrawingManager";
import { UIManager } from "../components/UIManager";
import { GameStateService } from "../services/GameStateService";
import { PlayerStateService } from "../services/PlayerStateService";
import { LoadType } from "../../shared/types/LoadTypes";
import { LoadService } from "../services/LoadService";

// Add type declaration for Phaser.Scene
declare module "phaser" {
  namespace Scene {
    interface Scene {
      shutdown(fromScene?: Scene): void;
    }
  }
}

export class GameScene extends Phaser.Scene {
  // Main containers
  private mapContainer!: Phaser.GameObjects.Container;
  private uiContainer!: Phaser.GameObjects.Container;
  private playerHandContainer!: Phaser.GameObjects.Container;

  // Component managers
  private mapRenderer!: MapRenderer;
  private cameraController!: CameraController;
  private trackManager!: TrackDrawingManager;
  private uiManager!: UIManager;
  private gameStateService!: GameStateService;
  private playerStateService!: PlayerStateService;
  private loadService: LoadService;
  private turnChangeListener?: (currentPlayerIndex: number) => void;

  // Game state
  public gameState: GameState; // Keep public for compatibility with SettingsScene

  constructor() {
    super({ key: "GameScene" });
    console.log('🚀 GameScene: constructor() called');
    // Initialize with empty game state
    this.gameState = {
      id: "", // Will be set by SetupScene
      players: [],
      currentPlayerIndex: 0,
      status: "setup",
      maxPlayers: 6,
    };
    this.loadService = LoadService.getInstance();
  }

  init(data: { gameState?: GameState }) {
    console.log('🚀 GameScene: init() called with data:', data);
    
    // If we get a gameState, always use it
    if (data.gameState) {
      this.gameState = {
        ...data.gameState,
        // Ensure we preserve the camera state if it exists
        cameraState: data.gameState.cameraState || this.gameState.cameraState,
      };

      // If we have camera state, apply it immediately
      if (this.gameState.cameraState) {
        this.cameras.main.setZoom(this.gameState.cameraState.zoom);
        this.cameras.main.scrollX = this.gameState.cameraState.scrollX;
        this.cameras.main.scrollY = this.gameState.cameraState.scrollY;
      }
      
      return;
    }

    // If we don't have a game state or players, go to setup
    if (!this.gameState.id || this.gameState.players.length === 0) {
      this.scene.start("SetupScene");
      return;
    }
  }

  preload() {
    this.load.svg("ferry-port", "/assets/ferry-port.svg", { scale: 0.05 });
    this.load.image("demand-template", "/assets/demand.png");

    // Preload crayon images for each player color
    const colors = ["red", "blue", "green", "yellow", "black", "brown"];
    colors.forEach((color) => {
      this.load.image(`crayon_${color}`, `/assets/crayon_${color}.png`);
      // Load both regular and fast/heavy train images
      this.load.image(`train_${color}`, `/assets/train_${color}.png`);
      this.load.image(`train_12_${color}`, `/assets/train_12_${color}.png`);
    });

    // Load train card images for each train type
    const trainTypes = [
      "freight",
      "fastfreight",
      "heavyfreight",
      "superfreight",
    ];
    trainTypes.forEach((type) => {
      this.load.image(`train_card_${type}`, `/assets/${type}.png`);
    });

    // Load SVG files for loads
    Object.values(LoadType).forEach((loadType) => {
      //loading with scale to preserve the quality of the svg.
      this.load.svg(
        `load-${loadType.toLowerCase()}`,
        `/assets/loads/${loadType}.svg`,
        { scale: 0.03 }
      );
      //load again but scaled larger for tokens as we cannot use the dynamic scaling of the svg.
      this.load.svg(
        `loadtoken-${loadType.toLowerCase()}`,
        `/assets/loads/${loadType}.svg`,
        { scale: 0.1 }
      );
    });
  }

  async create() {
    console.log('🚀 GameScene: create() called');
    console.log('🚀 GameScene: gameState in create:', this.gameState);
    
    // Clear any existing containers
    this.children.removeAll(true);
    // Initialize services and load initial state
    this.gameStateService = new GameStateService(this.gameState);
    this.playerStateService = new PlayerStateService();
    
    // Identify local player after services are created
    const identified = this.playerStateService.initializeLocalPlayer(this.gameState.players);
    if (!identified) {
      console.warn('Warning: Could not identify local player. Some features may not work correctly.');
      // Could show user a warning or handle spectator mode
    }
    
    // Connect GameStateService with PlayerStateService for local player checks
    this.gameStateService.setPlayerStateService(this.playerStateService);
    
    // Set up turn change listener to refresh UI when turn changes
    this.turnChangeListener = (currentPlayerIndex: number) => {
      console.log(`Turn changed to player index: ${currentPlayerIndex}`);
      this.handleTurnChange(currentPlayerIndex);
    };
    this.gameStateService.onTurnChange(this.turnChangeListener);
    
    await this.loadService.loadInitialState();
    
    // Start polling for turn changes after initial state is loaded (fallback if Socket.IO not available)
    this.gameStateService.startPollingForTurnChanges(2000);

    // Create containers in the right order
    this.mapContainer = this.add.container(0, 0);
    this.uiContainer = this.add.container(0, 0);
    const buttonContainer = this.createSettingsButton();

    this.playerHandContainer = this.add.container(0, 0);

    // Create track manager first since it's a dependency for MapRenderer
    this.trackManager = new TrackDrawingManager(
      this,
      this.mapContainer,
      this.gameState,
      [], // Empty array initially, will be set after grid creation
      this.gameStateService
    );

    // Initialize component managers
    this.mapRenderer = new MapRenderer(
      this,
      this.mapContainer,
      this.gameState,
      this.trackManager
    );

    // Create the map
    this.mapRenderer.createHexagonalGrid();

    // Now update TrackManager with the created grid points
    this.trackManager.updateGridPoints(this.mapRenderer.gridPoints);

    // Create camera controller with map dimensions
    const { width, height } = this.mapRenderer.calculateMapDimensions();
    this.cameraController = new CameraController(
      this,
      width,
      height,
      this.gameState
    );

    // Load existing tracks before creating UI
    await this.trackManager.loadExistingTracks();

    // Create UI manager with callbacks after tracks are loaded
    this.uiManager = new UIManager(
      this,
      this.gameState,
      async () => await this.toggleDrawingMode(), // Await the async toggleDrawingMode
      () => this.nextPlayerTurn(),
      () => this.openSettings(),
      this.gameStateService,
      this.mapRenderer,
      this.trackManager
    );

    // Get container references from UI manager
    const containers = this.uiManager.getContainers();
    this.uiContainer = containers.uiContainer;
    this.playerHandContainer = containers.playerHandContainer;

    // Add train container to map container
    this.mapContainer.add(containers.trainContainer);

    // Register for track cost updates
    this.trackManager.onCostUpdate((cost) => {
      // Always update the UI to show the current track cost during drawing mode
      if (this.trackManager.isInDrawingMode) {
        // The cost passed here is already the total cost including previous sessions
        this.uiManager.setupPlayerHand(true, cost).catch(console.error);
      }
    });

    // Create a separate camera for UI that won't move
    const uiCamera = this.cameras.add(
      0,
      0,
      this.cameras.main.width,
      this.cameras.main.height
    );
    uiCamera.setScroll(0, 0);
    uiCamera.ignore([this.mapContainer]); // UI camera ignores the map

    // Main camera ignores UI elements
    this.cameras.main.ignore([
      this.uiContainer,
      this.playerHandContainer,
      buttonContainer,
    ]);

    // Setup camera
    this.cameraController.setupCamera();

    // Initialize or restore train positions for each player
    this.gameState.players.forEach((player) => {
      if (player.trainState?.position) {
        // Restore existing position
        this.uiManager.updateTrainPosition(
          player.id,
          player.trainState.position.x,
          player.trainState.position.y,
          player.trainState.position.row,
          player.trainState.position.col
        );
      }
    });

    // Setup UI elements
    this.uiManager.setupUIOverlay();
    await this.uiManager.setupPlayerHand(this.trackManager.isInDrawingMode);

    // Show city selection for current player if needed - do this last to prevent cleanup
    console.log('GameScene: Checking for city selection');
    console.log('GameScene: gameState:', this.gameState);
    console.log('GameScene: players:', this.gameState.players);
    console.log('GameScene: currentPlayerIndex:', this.gameState.currentPlayerIndex);
    
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    console.log('GameScene: currentPlayer:', currentPlayer);
    console.log('GameScene: currentPlayer.trainState:', currentPlayer?.trainState);
    console.log('GameScene: currentPlayer.trainState?.position:', currentPlayer?.trainState?.position);
    
    if (!currentPlayer.trainState?.position) {
      console.log('GameScene: No position found, showing city selection');
      this.uiManager.showCitySelectionForPlayer(currentPlayer.id);
    } else {
      console.log('GameScene: Player has position, not showing city selection');
    }

    // Set a low frame rate for the scene
    this.game.loop.targetFps = 30;

    // Add event handler for scene resume
    this.events.on("resume", async () => {
      // Clear and recreate UI elements
      this.uiManager.setupUIOverlay();
      await this.uiManager.setupPlayerHand(this.trackManager.isInDrawingMode);

      // Re-show city selection for current player if needed
      const currentPlayer =
        this.gameState.players[this.gameState.currentPlayerIndex];
      if (!currentPlayer.trainState?.position) {
        this.uiManager.showCitySelectionForPlayer(currentPlayer.id);
      }
    });

    // Add resize handler to update UI when browser window is resized
    this.scale.on('resize', async () => {
      // Wait a bit for the resize to complete
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Recalculate track costs if in drawing mode
      if (this.trackManager.isInDrawingMode) {
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const previousSessionsCost = this.trackManager.getPlayerTrackState(currentPlayer.id)?.turnBuildCost || 0;
        const currentSessionCost = this.trackManager.getCurrentTurnBuildCost();
        const totalCost = previousSessionsCost + currentSessionCost;
        await this.uiManager.setupPlayerHand(true, totalCost);
      } else {
        await this.uiManager.setupPlayerHand(false);
      }
    });
  }

  private createSettingsButton(): Phaser.GameObjects.Container {
    const buttonContainer = this.add.container(1, 1);
    const icon = this.add
      .text(10, 10, "⚙️", { fontSize: "28px", color: "#ffffff" })
      .setPadding(8)
      .setInteractive({ useHandCursor: true })
      .on("pointerdown", () => this.openSettings());
    buttonContainer.add(icon);

    return buttonContainer;
  }

  private async toggleDrawingMode(): Promise<void> {
    const isDrawingMode = await this.trackManager.toggleDrawingMode();

    // Update UIManager's drawing mode state
    this.uiManager.setDrawingMode(isDrawingMode);

    // If exiting drawing mode, update the UI completely to refresh money display
    if (!isDrawingMode) {
      this.uiManager.setupUIOverlay();
    }

    // Get the current cost to display regardless of drawing mode
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    const previousSessionsCost = this.trackManager.getPlayerTrackState(currentPlayer.id)?.turnBuildCost || 0;
    const currentSessionCost = this.trackManager.getCurrentTurnBuildCost();
    const totalCost = previousSessionsCost + currentSessionCost;

    // Always show the current cost until turn changes
    await this.uiManager.setupPlayerHand(isDrawingMode, totalCost);
  }

  private async nextPlayerTurn(): Promise<void> {
    // Get the current player before changing turns
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];

    // Check if there was a build cost from the player's previous activity
    let buildCost = this.trackManager.getPlayerTrackState(currentPlayer.id)?.turnBuildCost || 0;

    // If in drawing mode, finalize track drawing first by toggling it off
    // This will handle saving tracks and cleanup through TrackDrawingManager
    if (this.trackManager.isInDrawingMode) {
      const isDrawingMode = await this.trackManager.toggleDrawingMode();
      // Make sure UIManager's drawing mode state stays in sync
      this.uiManager.setDrawingMode(isDrawingMode);

      // Get the updated build cost after saving track state
      buildCost = this.trackManager.getPlayerTrackState(currentPlayer.id)?.turnBuildCost || 0;
    }

    // Deduct track building cost from player's money if there was any building
    if (buildCost > 0) {
      const newMoney = currentPlayer.money - buildCost;

      try {
        // Update player money in local state and database
        if (this.playerStateService.getLocalPlayerId() === currentPlayer.id) {
          await this.playerStateService.updatePlayerMoney(newMoney, this.gameState.id);
        } else {
          // Non-local player - update in shared state for display purposes
          currentPlayer.money = newMoney;
        }
      } catch (error) {
        console.error("Error updating player money:", error);
      }

      // Clear the build cost after processing it to avoid double-counting
      await this.trackManager.endTurnCleanup(currentPlayer.id);
    }

    // Use the game state service to handle player turn changes
    await this.gameStateService.nextPlayerTurn();

    // Get the new current player after the turn change
    const newCurrentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    newCurrentPlayer.turnNumber = newCurrentPlayer.turnNumber + 1;

    // Handle ferry state transitions and teleportation at turn start
    await this.handleFerryTurnTransition(newCurrentPlayer);

    // Reset movement points for the new player using TRAIN_PROPERTIES
    const trainProps = TRAIN_PROPERTIES[newCurrentPlayer.trainType];
    if (!trainProps) {
      console.error(`Invalid train type: ${newCurrentPlayer.trainType}`);
      return; // Prevent further execution with invalid data
    }
    const maxMovement = trainProps.speed;

    // Set movement based on ferry crossing
    if (newCurrentPlayer.trainState.justCrossedFerry) {
      newCurrentPlayer.trainState.remainingMovement = Math.ceil(maxMovement / 2);
      newCurrentPlayer.trainState.justCrossedFerry = false;
    } else {
      // Normal movement
      newCurrentPlayer.trainState.remainingMovement = maxMovement;
    }
  }

  /**
   * Handle ferry state transitions at the start of a player's turn
   */
  private async handleFerryTurnTransition(player: Player): Promise<void> {
    if (!player.trainState.ferryState) {
      return; // Not at a ferry
    }

    if (player.trainState.ferryState.status === 'just_arrived') {
      // Transition from 'just_arrived' to 'ready_to_cross'
      player.trainState.ferryState.status = 'ready_to_cross';
      
      // Get the other side coordinates from ferry state
      const otherSideFromFerry = player.trainState.ferryState.otherSide;
      
      // Get the actual GridPoint with correct world coordinates from MapRenderer
      const actualOtherSide = this.mapRenderer.gridPoints[otherSideFromFerry.row][otherSideFromFerry.col];
      
      if (!actualOtherSide) {
        console.error(`Could not find grid point at ${otherSideFromFerry.row},${otherSideFromFerry.col}`);
        return;
      }
      
      // Update train position to other side using correct world coordinates
      await this.uiManager.updateTrainPosition(
        player.id,
        actualOtherSide.x,
        actualOtherSide.y,
        actualOtherSide.row,
        actualOtherSide.col
      );
      
      // Set flag to halve movement for this turn
      player.trainState.justCrossedFerry = true;

      // Clear ferry state after successful crossing
      player.trainState.ferryState = undefined;
      
      console.log(`Player ${player.name} crossed ferry to ${actualOtherSide.city?.name || 'other side'}`);
    }
    
    // If status was already 'ready_to_cross', it means the player didn't move last turn
    // so we just clear the ferry state and continue with normal movement
    if (player.trainState.ferryState?.status === 'ready_to_cross') {
      player.trainState.ferryState = undefined;
    }
  }

  private async openSettings() {
    // Add SettingsScene if it doesn't exist
    if (!this.scene.manager.getScene("SettingsScene")) {
      const module = await import("./SettingsScene");
      const SettingsScene = module.SettingsScene;
      this.scene.add("SettingsScene", SettingsScene);
    }
    
    // Pause this scene and start settings scene
    this.scene.pause();
    this.scene.launch("SettingsScene", { gameState: this.gameState });
  }

  /**
   * Handle turn change - refresh UI and update game state
   */
  private async handleTurnChange(currentPlayerIndex: number): Promise<void> {
    // Update game state
    this.gameState.currentPlayerIndex = currentPlayerIndex;
    
    // Get the new current player after the turn change
    const newCurrentPlayer = this.gameState.players[currentPlayerIndex];
    if (newCurrentPlayer) {
      // Increment turn number for the new current player
      newCurrentPlayer.turnNumber = newCurrentPlayer.turnNumber + 1;

      // Handle ferry state transitions and teleportation at turn start FIRST
      // This must happen before movement reset so that justCrossedFerry can be properly set
      await this.handleFerryTurnTransition(newCurrentPlayer);

      // Reset movement points for the new player using TRAIN_PROPERTIES
      // This ensures movement is reset when turn changes come from server (polling/socket)
      const trainProps = TRAIN_PROPERTIES[newCurrentPlayer.trainType];
      if (trainProps) {
        const maxMovement = trainProps.speed;

        // Set movement based on ferry crossing
        // Note: justCrossedFerry is set by handleFerryTurnTransition if applicable
        if (newCurrentPlayer.trainState.justCrossedFerry) {
          newCurrentPlayer.trainState.remainingMovement = Math.ceil(maxMovement / 2);
          newCurrentPlayer.trainState.justCrossedFerry = false;
        } else {
          // Normal movement - reset to full movement for new turn
          newCurrentPlayer.trainState.remainingMovement = maxMovement;
        }
      } else {
        console.error(`Invalid train type: ${newCurrentPlayer.trainType}`);
      }

      // Refresh UI overlay (leaderboard, etc.)
      this.uiManager.setupUIOverlay();
      
      // Refresh player hand display (only show costs for local player)
      const localPlayerId = this.playerStateService.getLocalPlayerId();
      const localPlayer = localPlayerId 
        ? this.gameState.players.find(p => p.id === localPlayerId)
        : null;
      
      let totalCost = 0;
      if (localPlayer && this.trackManager.isInDrawingMode) {
        const previousSessionsCost = this.trackManager.getPlayerTrackState(localPlayer.id)?.turnBuildCost || 0;
        const currentSessionCost = this.trackManager.getCurrentTurnBuildCost();
        totalCost = previousSessionsCost + currentSessionCost;
      }
      
      await this.uiManager.setupPlayerHand(this.trackManager.isInDrawingMode, totalCost);
      
      // Pan camera to new player's train if they have a position
      if (newCurrentPlayer.trainState?.position) {
        const { x, y } = newCurrentPlayer.trainState.position;
        this.cameras.main.pan(x, y, 1000, "Linear", true);
      }
      
      // Check if new player needs to select a city
      if (!newCurrentPlayer.trainState?.position) {
        // Only show city selection if it's the local player
        if (this.playerStateService.getLocalPlayerId() === newCurrentPlayer.id) {
          this.uiManager.showCitySelectionForPlayer(newCurrentPlayer.id);
        }
      }
    }
  }

  // Clean up resources when scene is destroyed
  destroy(fromScene?: boolean): void {
    // Stop polling for turn changes
    if (this.gameStateService) {
      this.gameStateService.stopPollingForTurnChanges();
      // Remove turn change listener to prevent memory leaks
      if (this.turnChangeListener) {
        this.gameStateService.offTurnChange(this.turnChangeListener);
        this.turnChangeListener = undefined;
      }
    }
    
    // Clean up TrackDrawingManager
    if (this.trackManager) {
      this.trackManager.destroy();
    }
  }
}
