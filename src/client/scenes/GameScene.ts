import "phaser";
import { GameState, Player, TrainType, TRAIN_PROPERTIES, VICTORY_INITIAL_THRESHOLD } from "../../shared/types/GameTypes";
import { MapRenderer } from "../components/MapRenderer";
import { CameraController } from "../components/CameraController";
import { TrackDrawingManager } from "../components/TrackDrawingManager";
import { UIManager } from "../components/UIManager";
import { TurnNotification } from "../components/TurnNotification";
import { GameStateService } from "../services/GameStateService";
import { PlayerStateService } from "../services/PlayerStateService";
import { VictoryService } from "../services/VictoryService";
import { LoadType } from "../../shared/types/LoadTypes";
import { LoadService } from "../services/LoadService";
import { config } from "../config/apiConfig";
import { LoadsReferencePanel } from "../components/LoadsReferencePanel";
import { UI_FONT_FAMILY } from "../config/uiFont";
import { MAP_BACKGROUND_CALIBRATION, MAP_BOARD_CALIBRATION } from "../config/mapConfig";

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
  private boardContainer!: Phaser.GameObjects.Container;
  private uiContainer!: Phaser.GameObjects.Container;
  private playerHandContainer!: Phaser.GameObjects.Container;

  // Component managers
  private mapRenderer!: MapRenderer;
  private cameraController!: CameraController;
  private trackManager!: TrackDrawingManager;
  private uiManager!: UIManager;
  private turnNotification!: TurnNotification;
  private gameStateService!: GameStateService;
  private playerStateService!: PlayerStateService;
  private loadService: LoadService;
  private turnChangeListener?: (currentPlayerIndex: number) => void;
  private stateChangeListener?: () => void;
  private previousActivePlayerId: string | null = null;
  private loadsReferencePanel?: LoadsReferencePanel;
  

  // Game state
  public gameState: GameState; // Keep public for compatibility with SettingsScene

  constructor() {
    super({ key: "GameScene" });
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
    // If we get a gameState, always use it
    if (data.gameState) {
      this.gameState = {
        ...data.gameState,
        // Ensure we preserve the camera state if it exists
        cameraState: data.gameState?.cameraState || this.gameState.cameraState,
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
    this.load.image("world-map", "/assets/map.png");
    // Static "loads at cities" reference pages (slideout UI)
    this.load.image("loads-reference-page-1", "/assets/rules_loads_1.png");
    this.load.image("loads-reference-page-2", "/assets/load_rules_2.png");

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
      this.handleTurnChange(currentPlayerIndex);
    };
    this.gameStateService.onTurnChange(this.turnChangeListener);
    
    await this.loadService.loadInitialState();
    
    // Only start polling for turn changes if Socket.IO is not available/connected
    // This is a fallback mechanism - Socket.IO should be the primary method for real-time updates
    // Check if Socket.IO is available by trying to import and check connection status
    let shouldPoll = true;
    try {
      // Dynamic import to avoid breaking if socket service isn't available
      const { socketService } = await import('../lobby/shared/socket');
      if (!socketService) {
        console.error('❌ Socket.IO service not found - socketService is undefined.');
        console.warn('⚠️ Will use polling fallback.');
        shouldPoll = true;
      } else if (socketService.isConnected()) {
        shouldPoll = false;
      } else {
        // If the socket was already created elsewhere (e.g., lobby), it may simply still be handshaking.
        // Only warn if we truly fail to connect and must fall back to polling.
        const token = localStorage.getItem('eurorails.jwt');
        try {
          if (!socketService.hasSocket()) {
            if (!token) {
              console.warn('⚠️ Socket.IO service found but not connected, and no auth token available.');
              console.warn('   Cannot connect Socket.IO without token. Will use polling fallback.');
              shouldPoll = true;
            } else {
              socketService.connect(token);
            }
          }

          // Wait a bit longer for the initial handshake instead of assuming failure after 500ms.
          const connected = await socketService.waitForConnection(2500);
          if (connected && socketService.isConnected()) {
            shouldPoll = false;
          } else {
            console.warn('⚠️ Socket.IO not connected after waiting. Will use polling fallback.');
            shouldPoll = true;
          }
        } catch (connectError) {
          console.error('❌ Error connecting Socket.IO:', connectError);
          console.warn('⚠️ Will use polling fallback.');
          shouldPoll = true;
        }
      }
    } catch (error) {
      // Socket service not available, use polling as fallback
      console.error('❌ Error importing Socket.IO service:', error);
      console.error('   Error details:', error instanceof Error ? error.message : String(error));
      console.warn('⚠️ Socket.IO service not available, will use polling fallback');
      shouldPoll = true;
    }
    
    // Only start polling if Socket.IO is not connected
    if (shouldPoll) {
      console.warn('🔄 Starting polling fallback for turn changes (5 second interval)');
      console.warn('   This will make API calls every 5 seconds. Consider connecting Socket.IO to reduce server load.');
      // Use a longer interval (5 seconds) since this is just a fallback
      // This reduces server load compared to the previous 2-second interval
      this.gameStateService.startPollingForTurnChanges(5000);
    } else {
      // Register socket listener for turn changes
      try {
        const { socketService } = await import('../lobby/shared/socket');
        if (socketService && socketService.isConnected()) {
          // Join the game room so we receive events
          socketService.join(this.gameState.id);

          this.socketUnsubReconnected?.();
          this.socketUnsubSeqGap?.();
          this.socketUnsubReconnected = socketService.onReconnected(() => {
            this.scheduleSocketResync('reconnect');
          });
          this.socketUnsubSeqGap = socketService.onSeqGap(({ expected, received }) => {
            this.scheduleSocketResync(`seq-gap ${expected}->${received}`);
          });
          
          socketService.onTurnChange((data: any) => {
            // Server sends: { currentPlayerIndex, currentPlayerId, gameId, timestamp }
            // Handle the actual server payload
            const playerIndex = data.currentPlayerIndex;
            if (playerIndex !== undefined && playerIndex !== this.gameState.currentPlayerIndex) {
              this.gameStateService.updateCurrentPlayerIndex(playerIndex);
            }
          });

          // Listen for state patches to sync game state across clients
          socketService.onPatch((data: { patch: any; serverSeq: number }) => {
            const { patch } = data;

            // Update this.gameState with the patch
            if (patch.players && patch.players.length > 0) {
              const localPlayerId = this.playerStateService.getLocalPlayerId();

              // Merge updated players into existing players array
              patch.players.forEach((updatedPlayer: any) => {
                const index = this.gameState.players.findIndex(p => p.id === updatedPlayer.id);
                if (index >= 0) {
                  const existingPlayer = this.gameState.players[index];
                  const isLocalPlayer = localPlayerId === updatedPlayer.id;

                  if (isLocalPlayer) {
                    // For local player: preserve local position and movementHistory
                    // This prevents train from jumping backward when server sends outdated position
                    const preservedPosition = existingPlayer.trainState?.position || null;
                    const preservedHistory = existingPlayer.trainState?.movementHistory || [];
                    const preservedRemainingMovement = existingPlayer.trainState?.remainingMovement;
                    const preservedFerryState = existingPlayer.trainState?.ferryState;
                    const preservedJustCrossedFerry = existingPlayer.trainState?.justCrossedFerry;

                    // For hand: get from playerStateService which is the authoritative local source.
                    // This avoids race conditions where deliverLoad updates the hand concurrently.
                    // Server patches don't include hand data for privacy, so we always preserve local.
                    const currentLocalPlayer = this.playerStateService.getLocalPlayer();
                    const preservedHand = currentLocalPlayer?.hand || existingPlayer.hand;

                    // #region agent log
                    fetch('http://127.0.0.1:7242/ingest/ee63971d-7078-4c66-a767-c90c475dbcfc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'hand-bug-pre',hypothesisId:'H19',location:'GameScene.ts:onPatch',message:'local merge (hand) snapshot',data:{localPlayerId,currentLocalPlayerId:currentLocalPlayer?.id,sameRef:currentLocalPlayer===existingPlayer,existingHandIds:Array.isArray(existingPlayer.hand)?existingPlayer.hand.map((c:any)=>c?.id).filter((v:any)=>typeof v==="number"):[],serviceHandIds:Array.isArray(currentLocalPlayer?.hand)?currentLocalPlayer!.hand.map((c:any)=>c?.id).filter((v:any)=>typeof v==="number"):[],updatedHandLen:Array.isArray(updatedPlayer.hand)?updatedPlayer.hand.length:null,preservedHandLen:Array.isArray(preservedHand)?preservedHand.length:null},timestamp:Date.now()})}).catch(()=>{});
                    // #endregion agent log

                    this.gameState.players[index] = {
                      ...existingPlayer,
                      ...updatedPlayer,
                      // Preserve private hand - server patches don't include it for privacy
                      hand: Array.isArray(updatedPlayer.hand) && updatedPlayer.hand.length > 0
                        ? updatedPlayer.hand
                        : preservedHand,
                      // Preserve local position if it exists (server position might be outdated)
                      trainState: updatedPlayer.trainState ? {
                        ...updatedPlayer.trainState,
                        position: preservedPosition || updatedPlayer.trainState.position,
                        // Preserve movementHistory to maintain direction
                        movementHistory: preservedHistory.length > 0
                          ? preservedHistory
                          : (updatedPlayer.trainState.movementHistory || []),
                        // Server does not manage remainingMovement; preserve local (important for ferry half-rate)
                        remainingMovement: typeof preservedRemainingMovement === 'number'
                          ? preservedRemainingMovement
                          : updatedPlayer.trainState.remainingMovement,
                        // Ferry state is client-managed; preserve local if present
                        ferryState: preservedFerryState ?? updatedPlayer.trainState.ferryState,
                        justCrossedFerry: preservedJustCrossedFerry ?? updatedPlayer.trainState.justCrossedFerry,
                      } : existingPlayer.trainState
                    };
                  } else {
                    // For other players: use server data (authoritative)
                    this.gameState.players[index] = { ...existingPlayer, ...updatedPlayer };
                  }
                } else {
                  // Add new player (shouldn't happen in normal gameplay)
                  this.gameState.players.push(updatedPlayer);
                }
              });
            }

            // Update other patch fields
            if (patch.currentPlayerIndex !== undefined) {
              this.gameState.currentPlayerIndex = patch.currentPlayerIndex;
            }

            if (patch.status !== undefined) {
              this.gameState.status = patch.status;
            }

            // Update services with new state
            this.gameStateService.updateGameState(this.gameState);
            this.playerStateService.updateLocalPlayer(this.gameState.players);

            // Refresh UI
            this.uiManager.setupUIOverlay();
          });

          // Listen for victory triggered event
          socketService.onVictoryTriggered((data) => {
            if (data.gameId !== this.gameState.id) return;

            // Update local victory state
            this.gameState.victoryState = {
              triggered: true,
              triggerPlayerIndex: data.triggerPlayerIndex,
              victoryThreshold: data.victoryThreshold,
              finalTurnPlayerIndex: data.finalTurnPlayerIndex,
            };

            // Refresh UI to show final round indicator
            this.uiManager.setupUIOverlay();
          });

          // Listen for game over event
          socketService.onGameOver((data) => {
            if (data.gameId !== this.gameState.id) return;

            // Update game status
            this.gameState.status = 'completed';

            // Launch winner scene
            this.launchWinnerScene(data.winnerId, data.winnerName);
          });

          // Listen for tie extended event
          socketService.onTieExtended((data) => {
            if (data.gameId !== this.gameState.id) return;

            // Reset victory state with new threshold
            this.gameState.victoryState = {
              triggered: false,
              triggerPlayerIndex: -1,
              victoryThreshold: data.newThreshold,
              finalTurnPlayerIndex: -1,
            };

            // Show notification
            this.turnNotification.show(
              `Tie! Victory threshold increased to ${data.newThreshold}M ECU. Game continues.`,
              5000
            );

            // Refresh UI
            this.uiManager.setupUIOverlay();
          });
        }
      } catch (error) {
        console.error('Failed to register turn change socket listener:', error);
      }
    }

    // Create containers in the right order
    this.mapContainer = this.add.container(0, 0);
    // Board layer holds all gameplay visuals (grid, tracks, trains, etc).
    // We can offset/scale this container to align point-space to the background image.
    const boardCalibration = MAP_BOARD_CALIBRATION;
    this.boardContainer = this.add
      .container(boardCalibration.offsetX, boardCalibration.offsetY)
      .setScale(boardCalibration.scaleX, boardCalibration.scaleY);

    this.uiContainer = this.add.container(0, 0);
    const buttonContainer = this.createSettingsButton();

    this.playerHandContainer = this.add.container(0, 0);

    // Create track manager first since it's a dependency for MapRenderer
    this.trackManager = new TrackDrawingManager(
      this,
      this.boardContainer,
      this.gameState,
      [], // Empty array initially, will be set after grid creation
      this.gameStateService
    );

    // Initialize component managers
    this.mapRenderer = new MapRenderer(
      this,
      this.boardContainer,
      this.gameState,
      this.trackManager
    );

    // World background image (pans/zooms with the main camera)
    // Keep this in the same world coordinate space as all map elements.
    const { width: mapWorldWidth, height: mapWorldHeight } =
      this.mapRenderer.calculateMapDimensions();
    const calibration = MAP_BACKGROUND_CALIBRATION;

    const mapBackground = this.add
      .image(calibration.offsetX, calibration.offsetY, "world-map")
      .setOrigin(0, 0)
      .setAlpha(calibration.alpha);
    mapBackground.setDisplaySize(mapWorldWidth * calibration.scaleX, mapWorldHeight * calibration.scaleY);
    this.mapContainer.addAt(mapBackground, 0);
    this.mapContainer.add(this.boardContainer);

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

    // Set local player ID for per-player camera state
    const localPlayerId = this.playerStateService.getLocalPlayerId();
    this.cameraController.setLocalPlayerId(localPlayerId);

    // Initialize turn notification component
    this.turnNotification = new TurnNotification(this);
    
    // Initialize previous active player ID to current player to avoid showing notification on first load
    const initialCurrentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
    this.previousActivePlayerId = initialCurrentPlayer?.id || null;

    // Load existing tracks before creating UI
    await this.trackManager.loadExistingTracks();

    // Setup track update listener on existing socket connection
    this.setupTrackUpdateListener();

    // Create UI manager with callbacks after tracks are loaded
    this.uiManager = new UIManager(
      this,
      this.gameState,
      async () => await this.toggleDrawingMode(), // Await the async toggleDrawingMode
      () => this.nextPlayerTurn(),
      () => this.openSettings(),
      this.gameStateService,
      this.mapRenderer,
      this.trackManager,
      this.playerStateService
    );

    // Reusable pattern: when local, server-authoritative actions mutate game state
    // without guaranteed socket connectivity (restart, upgrade, etc.), force-refresh overlay.
    this.stateChangeListener = () => {
      try {
        this.uiManager.updateGameState(this.gameState);
        this.uiManager.setupUIOverlay();
      } catch (error) {
        console.error('Error refreshing UI overlay after local state change:', error);
      }
    };
    this.gameStateService.onStateChange(this.stateChangeListener);

    // Get container references from UI manager
    const containers = this.uiManager.getContainers();
    this.uiContainer = containers.uiContainer;
    this.playerHandContainer = containers.playerHandContainer;

    // Add train container to the board layer (so it stays aligned with grid/track)
    this.boardContainer.add(containers.trainContainer);

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

    // Static slideout reference panel (independent of game state)
    this.loadsReferencePanel = new LoadsReferencePanel(this, [
      { key: "loads-reference-page-1", label: "Loads Available" },
      { key: "loads-reference-page-2", label: "Cities and Loads" },
    ]);
    this.loadsReferencePanel.create();

    // Main camera ignores UI elements
    this.cameras.main.ignore([
      this.uiContainer,
      this.playerHandContainer,
      buttonContainer,
      this.loadsReferencePanel.getContainer(),
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
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    if (!currentPlayer.trainState?.position) {
      this.uiManager.showCitySelectionForPlayer(currentPlayer.id);
    } else {
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

      // Re-layout static overlays
      this.loadsReferencePanel?.layout();
    });
  }

  private createSettingsButton(): Phaser.GameObjects.Container {
    const buttonContainer = this.add.container(1, 1);
    const icon = this.add
      .text(10, 10, "⚙️", { fontSize: "28px", color: "#ffffff", fontFamily: UI_FONT_FAMILY })
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
    }

    // Always end-turn cleanup (even if buildCost was 0) so per-turn UI state resets
    // and undo state doesn't leak across turns (e.g., 0-cost ferry builds).
    await this.trackManager.endTurnCleanup(currentPlayer.id);
    this.uiManager.clearTurnUndoStack();

    // Increment per-player turn count at END of the active player's turn.
    // Do NOT increment the next active player; that incorrectly advances players on their first activation.
    try {
      currentPlayer.turnNumber = (currentPlayer.turnNumber ?? 1) + 1;
      if (this.playerStateService.getLocalPlayerId() === currentPlayer.id) {
        await this.playerStateService.updatePlayerTurnNumber(
          currentPlayer.turnNumber,
          this.gameState.id
        );
      }
    } catch (e) {
      // Non-fatal: if persistence fails, the server will retain the old value.
    }

    // Check victory conditions for local player ending their turn
    // Only check if victory hasn't been triggered yet
    if (
      this.playerStateService.getLocalPlayerId() === currentPlayer.id &&
      !this.gameState.victoryState?.triggered
    ) {
      await this.checkAndDeclareVictory(currentPlayer);
    }

    // Check if this is the final turn and we need to resolve victory
    // Only the final turn player's client should trigger resolution
    if (
      this.gameState.victoryState?.triggered &&
      this.playerStateService.getLocalPlayerId() === currentPlayer.id &&
      this.gameState.currentPlayerIndex === this.gameState.victoryState.finalTurnPlayerIndex
    ) {
      const gameOver = await this.resolveVictory();
      if (gameOver) {
        return; // Don't advance turn - game is ending
      }
      // If tie extended, game continues - fall through to advance turn
    }

    // Use the game state service to handle player turn changes
    await this.gameStateService.nextPlayerTurn();

    // Get the new current player after the turn change
    const newCurrentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];

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
    }
    
    // If status was already 'ready_to_cross', it means the player didn't move last turn
    // so we just clear the ferry state and continue with normal movement
    if (player.trainState.ferryState?.status === 'ready_to_cross') {
      player.trainState.ferryState = undefined;
    }
  }

  /**
   * Launch the winner scene to display game results
   */
  private async launchWinnerScene(winnerId: string, winnerName: string): Promise<void> {
    console.log(`Game over! Winner: ${winnerName} (${winnerId})`);

    // Dynamically import and add the WinnerScene
    const { WinnerScene } = await import('./WinnerScene');

    // Add the scene if it doesn't exist yet
    if (!this.scene.get('WinnerScene')) {
      this.scene.add('WinnerScene', WinnerScene, false);
    }

    // Launch the WinnerScene as an overlay
    this.scene.launch('WinnerScene', {
      gameState: this.gameState,
      winnerId,
      winnerName,
    });

    // Bring the WinnerScene to the top
    this.scene.bringToTop('WinnerScene');
  }

  /**
   * Check if player meets victory conditions and declare victory if so
   * Victory requires: 250M+ ECU AND 7+ connected major cities
   */
  private async checkAndDeclareVictory(player: Player): Promise<void> {
    const threshold = this.gameState.victoryState?.victoryThreshold ?? VICTORY_INITIAL_THRESHOLD;

    // Quick check: does player have enough money?
    if (player.money < threshold) {
      return; // Not enough money, skip expensive connectivity check
    }

    // Get player's track segments
    const trackState = this.trackManager.getPlayerTrackState(player.id);
    if (!trackState || trackState.segments.length === 0) {
      return; // No track built
    }

    // Check if 7+ major cities are connected
    const victoryService = VictoryService.getInstance();
    const { eligible, connectedCities } = victoryService.checkVictoryConditions(
      player.money,
      trackState.segments,
      threshold
    );

    if (!eligible) {
      return; // Victory conditions not met
    }

    // Declare victory to the server
    try {
      const { authenticatedFetch } = await import('../services/authenticatedFetch');
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/api/game/${this.gameState.id}/declare-victory`,
        {
          method: 'POST',
          body: JSON.stringify({
            playerId: player.id,
            connectedCities,
          }),
        }
      );

      if (response.ok) {
        const result = await response.json();
        if (result.victoryState) {
          // Update local game state with victory state
          this.gameState.victoryState = result.victoryState;
          // Note: Socket event handler (onVictoryTriggered) will show the notification to all players
        }
      } else {
        const error = await response.json();
        console.warn('Victory declaration rejected:', error.details);
      }
    } catch (error) {
      console.error('Error declaring victory:', error);
    }
  }

  /**
   * Resolve victory at the end of the final round.
   * Called by the final turn player's client to determine winner.
   * Returns true if the game is over, false if it continues (e.g., tie extension).
   */
  private async resolveVictory(): Promise<boolean> {
    try {
      const { authenticatedFetch } = await import('../services/authenticatedFetch');
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/api/game/${this.gameState.id}/resolve-victory`,
        {
          method: 'POST',
        }
      );

      if (response.ok) {
        const result = await response.json();
        // The server will emit game:over or victory:tie-extended via socket
        // Those handlers will update state and show appropriate UI
        if (result.gameOver) {
          console.log('Victory resolved - game over');
          return true;
        } else if (result.tieExtended) {
          console.log('Victory resulted in tie - threshold extended');
          return false; // Game continues with higher threshold
        }
      } else {
        const error = await response.json();
        console.warn('Victory resolution failed:', error.details);
      }
    } catch (error) {
      console.error('Error resolving victory:', error);
    }
    return false; // On error, allow game to continue
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
   * Note: This is called when receiving turn changes from the server (via polling or socket),
   * so updating currentPlayerIndex from the parameter is correct (updating from server data).
   * Turn number increment and movement reset are client-side UI state calculations.
   */
  private async handleTurnChange(currentPlayerIndex: number): Promise<void> {
    // Refresh player data from server to get updated money amounts
    await this.refreshPlayerData();
    
    // Get the new current player after the turn change
    const newCurrentPlayer = this.gameState.players[currentPlayerIndex];
    const newActivePlayerId = newCurrentPlayer?.id || null;
    
    // Check if local player is now active and show notification
    const localPlayerId = this.playerStateService.getLocalPlayerId();
    if (localPlayerId && newActivePlayerId === localPlayerId && this.previousActivePlayerId !== localPlayerId) {
      // Local player just became active - show notification
      this.turnNotification.show("It's your turn!", 4000);
    }
    
    // Update previous active player ID
    this.previousActivePlayerId = newActivePlayerId;
    
    // Update game state from server data (currentPlayerIndex comes from server)
    this.gameState.currentPlayerIndex = currentPlayerIndex;

    // Reset per-turn build rules for the newly active player
    // (crossgrade build-limit and upgrade drawing lock are turn-scoped).
    this.trackManager.resetTurnBuildLimit();
    
    if (newCurrentPlayer) {
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

      // Update gameState in UIManager
      this.uiManager.updateGameState(this.gameState);
      
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
      if (this.stateChangeListener) {
        this.gameStateService.offStateChange(this.stateChangeListener);
        this.stateChangeListener = undefined;
      }
    }

    if (this.socketResyncTimer !== undefined) {
      window.clearTimeout(this.socketResyncTimer);
      this.socketResyncTimer = undefined;
    }
    this.socketUnsubReconnected?.();
    this.socketUnsubReconnected = undefined;
    this.socketUnsubSeqGap?.();
    this.socketUnsubSeqGap = undefined;
    
    // Clean up TurnNotification
    if (this.turnNotification) {
      this.turnNotification.destroy();
    }
    
    // Clean up TrackDrawingManager
    if (this.trackManager) {
      this.trackManager.destroy();
    }

    // Clean up static overlays
    this.loadsReferencePanel?.destroy();
  }

  /**
   * Setup track update listener on existing socket connection
   */
  private async setupTrackUpdateListener(): Promise<void> {
    if (!this.gameState || !this.gameState.id) {
      console.warn('Cannot setup track update listener: gameState.id is missing');
      return;
    }

    try {
      const { socketService } = await import('../lobby/shared/socket');
      if (socketService && socketService.isConnected()) {
        // Join the game room so we receive track update events
        socketService.join(this.gameState.id);
        
        // Use existing socket service to listen for track updates
        socketService.onTrackUpdated(async (data: { gameId: string; playerId: string; timestamp: number }) => {
          if (data.gameId === this.gameState.id && this.trackManager) {
            try {
              await this.trackManager.loadExistingTracks();
              this.trackManager.drawAllTracks();
            } catch (error) {
              console.error('Error reloading tracks after update:', error);
            }
          }
        });
      }
    } catch (error) {
      console.warn('Could not setup track update listener:', error);
    }
  }

  private socketResyncTimer: number | undefined;
  private socketResyncInFlight = false;
  private socketUnsubReconnected: (() => void) | undefined;
  private socketUnsubSeqGap: (() => void) | undefined;

  private scheduleSocketResync(reason: string): void {
    if (!this.gameState || !this.gameState.id) return;
    if (this.socketResyncTimer !== undefined) {
      window.clearTimeout(this.socketResyncTimer);
    }
    this.socketResyncTimer = window.setTimeout(async () => {
      if (this.socketResyncInFlight) return;
      this.socketResyncInFlight = true;
      try {
        console.warn(`[socket] resyncing via HTTP (${reason})`);
        await this.refreshPlayerData();
        if (this.trackManager) {
          await this.trackManager.loadExistingTracks();
          this.trackManager.drawAllTracks();
        }
        if (this.loadService) {
          await this.loadService.loadInitialState();
        }
      } catch (error) {
        console.error('Socket resync failed:', error);
      } finally {
        this.socketResyncInFlight = false;
      }
    }, 250);
  }

  /**
   * Refresh player data from server to get updated money and other state
   */
  private async refreshPlayerData(): Promise<void> {
    if (!this.gameState || !this.gameState.id) {
      return;
    }

    try {
      const token = localStorage.getItem('eurorails.jwt');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(`${config.apiBaseUrl}/api/players/${this.gameState.id}`, {
        headers
      });

      if (!response.ok) {
        console.error('Failed to refresh player data:', response.status);
        return;
      }

      const players = await response.json();
      const localPlayerId = this.playerStateService.getLocalPlayerId();
      const trainsToUpdate: Array<{ playerId: string; x: number; y: number; row: number; col: number }> = [];
      
      // Update player data in gameState, preserving local references
      players.forEach((serverPlayer: Player) => {
        const localPlayer = this.gameState.players.find(p => p.id === serverPlayer.id);
        if (localPlayer) {
          // Update money and other server-managed properties
          localPlayer.money = serverPlayer.money;
          localPlayer.turnNumber = serverPlayer.turnNumber;
          
          // Handle train state based on whether this is the local player
          const isLocalPlayer = localPlayerId === serverPlayer.id;
          
          if (serverPlayer.trainState) {
            if (isLocalPlayer) {
              // For local player: preserve local position and movementHistory if they exist
              // This prevents losing direction information between turns
              if (localPlayer.trainState) {
                // Preserve local movementHistory if it exists and has entries
                // Movement history should persist across turn boundaries to maintain direction of travel
                // Only use server's movementHistory if local doesn't have any
                const shouldPreserveHistory = localPlayer.trainState.movementHistory && 
                                             localPlayer.trainState.movementHistory.length > 0;
                
                localPlayer.trainState = {
                  ...serverPlayer.trainState,
                  position: localPlayer.trainState.position || serverPlayer.trainState.position,
                  // Preserve local movementHistory to maintain direction of travel
                  // This is critical for direction reversal checks across turn boundaries
                  movementHistory: shouldPreserveHistory
                    ? localPlayer.trainState.movementHistory
                    : (serverPlayer.trainState.movementHistory || []),
                  // Server does not manage remainingMovement; preserve local (important for ferry half-rate)
                  remainingMovement: typeof localPlayer.trainState.remainingMovement === 'number'
                    ? localPlayer.trainState.remainingMovement
                    : serverPlayer.trainState.remainingMovement,
                  // Ferry-related flags are client-managed
                  ferryState: localPlayer.trainState.ferryState ?? serverPlayer.trainState.ferryState,
                  justCrossedFerry: localPlayer.trainState.justCrossedFerry ?? serverPlayer.trainState.justCrossedFerry,
                };
              } else {
                localPlayer.trainState = serverPlayer.trainState;
              }
            } else {
              // For other players: ALWAYS use server position (authoritative)
              localPlayer.trainState = serverPlayer.trainState;
              
              // Always update train sprite for other players if position exists
              // This ensures the sprite is created/updated and visible
              if (serverPlayer.trainState.position) {
                const { x, y, row, col } = serverPlayer.trainState.position;
                trainsToUpdate.push({ playerId: serverPlayer.id, x, y, row, col });
              }
            }
          } else if (localPlayer.trainState && !isLocalPlayer && !serverPlayer.trainState) {
            // If server doesn't have trainState but local does for other players, remove it
            // Set to empty trainState instead of null to maintain type safety
            localPlayer.trainState = {
              position: null,
              remainingMovement: 0,
              movementHistory: [],
              loads: []
            };
          }
        } else {
          // New player - add to gameState
          this.gameState.players.push(serverPlayer);
          
          // Queue train sprite update for new player if position exists
          if (serverPlayer.trainState?.position) {
            const { x, y, row, col } = serverPlayer.trainState.position;
            trainsToUpdate.push({ playerId: serverPlayer.id, x, y, row, col });
          }
        }
      });

      // Ensure trainSprites map exists before updating
      if (!this.gameState.trainSprites) {
        this.gameState.trainSprites = new Map();
      }

      // Update all train sprites after state is updated
      for (const train of trainsToUpdate) {
        try {
          await this.uiManager.updateTrainPosition(train.playerId, train.x, train.y, train.row, train.col);
        } catch (error) {
          console.error(`Error updating train position for player ${train.playerId}:`, error);
        }
      }

      // Refresh UI to show updated money
      this.uiManager.setupUIOverlay();
    } catch (error) {
      console.error('Error refreshing player data:', error);
    }
  }

  /**
   * Force-refresh UI overlay (leaderboard, banners, etc.).
   * Used when local-only actions update player state without a guaranteed socket patch
   * (e.g., if Socket.IO is disconnected and we're relying on polling for turns).
   */
  public refreshUIOverlay(): void {
    try {
      this.uiManager.setupUIOverlay();
    } catch (error) {
      console.error('Error refreshing UI overlay:', error);
    }
  }
}
