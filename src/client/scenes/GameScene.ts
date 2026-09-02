import "phaser";
import { FullGameState, Player, TrainType, TRAIN_PROPERTIES, VICTORY_INITIAL_THRESHOLD } from "../../shared/types/GameTypes";
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
import { DebugOverlay } from "../components/DebugOverlay";
import { RiverDebugOverlay } from "../components/RiverDebugOverlay";
import { LLMTranscriptOverlay } from "../components/LLMTranscriptOverlay";
import { BotTrainAnimator } from "../components/BotTrainAnimator";
import { GameToastManager } from "../components/GameToastManager";
import { WhisperPanel } from "../components/WhisperPanel";
import { AutoRunBadge } from "../components/AutoRunBadge";
import { MapHighlighter } from "../components/MapHighlighter";
import { EventCardOverlay } from "../components/EventCardOverlay";
import { UI_FONT_FAMILY } from "../config/uiFont";
import { MAP_BACKGROUND_CALIBRATION, MAP_BOARD_CALIBRATION } from "../config/mapConfig";
import { useGameStore } from "../lobby/store/game.store";
import { EventCardDrawnPayload, EventCardType } from "../../shared/types/EventCard";
import { socketService } from "../lobby/shared/socket";
import { GameSocketCoordinator } from "../services/GameSocketCoordinator";
import type { RefreshSpriteUpdate } from "../services/PlayerStateService";
import { BotTurnPresenter, BotTurnCompletePayload, BotDisplay } from "../components/BotTurnPresenter";

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
  private socketCoordinator!: GameSocketCoordinator;
  private turnChangeListener?: (currentPlayerIndex: number) => void;
  private stateChangeListener?: () => void;
  private previousActivePlayerId: string | null = null;
  private turnChangeSeq = 0;
  private loadsReferencePanel?: LoadsReferencePanel;
  private debugOverlay?: DebugOverlay;
  private riverDebugOverlay?: RiverDebugOverlay;
  private botTrainAnimator?: BotTrainAnimator;
  private gameToastManager?: GameToastManager;
  private whisperPanel?: WhisperPanel;
  private socketUnsubDebugAny?: () => void;
  private autoRunBadge?: AutoRunBadge;
  private llmTranscriptOverlay?: LLMTranscriptOverlay;
  private botTurnPresenter?: BotTurnPresenter;
  // bot:turn-complete payloads that arrive before create() has constructed the
  // presenter (the socket coordinator starts — and joining the room can resume
  // a queued bot turn — well before the presenter's dependencies exist).
  private pendingBotTurns: BotTurnCompletePayload[] = [];

  // Event card UI components
  private mapHighlighter?: MapHighlighter;
  private eventCardOverlay?: EventCardOverlay;
  private unsubEventOverlay?: () => void;
  private unsubActiveEffects?: () => void;

  // Game state
  public gameState: FullGameState; // Keep public for compatibility with SettingsScene

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

  /**
   * Expose MapRenderer for other scenes (e.g., Settings) without reaching into private fields via `as any`.
   */
  public getMapRenderer(): MapRenderer | null {
    return this.mapRenderer ?? null;
  }

  /**
   * Persist the current camera position/zoom to the per-player camera state (and server) so it survives reloads.
   * Safe to call after any external camera changes (e.g., "Take me to…" jump).
   */
  public persistLocalCameraState(): void {
    try {
      void this.cameraController?.saveCameraState?.();
    } catch (_e) {
      // Non-fatal
    }
  }

  /**
   * Build a list of all cities currently available on the board (from MapRenderer grid points).
   * Returns a stable, alphabetized list for UI search/autocomplete.
   */
  public getAllCityNames(): string[] {
    const names = new Set<string>();
    const grid = this.mapRenderer?.gridPoints;
    if (!grid) return [];

    for (const row of grid) {
      for (const point of row) {
        const name = point?.city?.name;
        if (name) {
          names.add(name);
        }
      }
    }

    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Pan/center the main camera on a given city by name.
   * Returns true if the city was found and the camera was centered.
   */
  public centerCameraOnCity(cityName: string): boolean {
    const target = cityName.trim().toLowerCase();
    if (!target) return false;

    const grid = this.mapRenderer?.gridPoints;
    if (!grid) return false;

    let sumX = 0;
    let sumY = 0;
    let count = 0;

    for (const row of grid) {
      for (const point of row) {
        const name = point?.city?.name;
        if (name && name.trim().toLowerCase() === target) {
          sumX += point.x;
          sumY += point.y;
          count += 1;
        }
      }
    }

    if (count === 0) return false;

    const x = sumX / count;
    const y = sumY / count;
    this.cameras.main.centerOn(x, y);
    this.persistLocalCameraState();
    return true;
  }

  init(data: { gameState?: FullGameState }) {
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
    // Drop any presenter/queue state from a prior lifecycle — a stale presenter
    // references destroyed game objects and must not receive early events.
    this.botTurnPresenter = undefined;
    this.pendingBotTurns = [];
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

    // Socket.IO is the primary transport for real-time updates; polling is the fallback.
    // GameSocketCoordinator owns the connect-or-poll decision, every game socket
    // subscription, and the debounced HTTP resync — GameScene only supplies the
    // seams it needs (accessors for components created later in this method, and
    // callbacks for the UI effects those events should have).
    this.socketCoordinator = new GameSocketCoordinator();
    const connected = await this.socketCoordinator.start({
      gameId: this.gameState.id,
      gameStateService: this.gameStateService,
      playerStateService: this.playerStateService,
      loadService: this.loadService,
      getTrackManager: () => this.trackManager,
      getMapGridPoint: (row, col) => this.mapRenderer?.gridPoints[row]?.[col],
      isBotAnimating: (playerId) => this.botTrainAnimator?.isAnimating(playerId) ?? false,
      onApplySpriteUpdates: (updates) => this.applySpriteUpdates(updates),
      onUIRefresh: () => this.refreshGameUI(),
      onLaunchWinner: (winnerId, winnerName) => this.launchWinnerScene(winnerId, winnerName),
      onTieExtended: (newThreshold) => {
        this.turnNotification.show(
          `Tie! Victory threshold increased to ${newThreshold}M ECU. Game continues.`,
          5000
        );
      },
      onAutoRunStatus: (enabled) => this.autoRunBadge?.setVisible(enabled),
      onBotTurnComplete: (data) => this.presentOrQueueBotTurn(data as BotTurnCompletePayload),
    });

    if (!connected) {
      console.warn('🔄 Starting polling fallback for turn changes (5 second interval)');
      this.gameStateService.startPollingForTurnChanges(5000);
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
    this.cameraController = new CameraController(
      this,
      mapWorldWidth,
      mapWorldHeight,
      this.gameState
    );

    // Set local player ID for per-player camera state
    const localPlayerId = this.playerStateService.getLocalPlayerId();
    this.cameraController.setLocalPlayerId(localPlayerId);
    
    // Set map container for automatic drag state reset
    this.cameraController.setMapContainer(this.mapContainer);

    // Initialize turn notification component
    this.turnNotification = new TurnNotification(this);
    
    // Initialize previous active player ID to current player to avoid showing notification on first load
    const initialCurrentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
    this.previousActivePlayerId = initialCurrentPlayer?.id || null;

    // Load existing tracks before creating UI
    await this.trackManager.loadExistingTracks();

    // Track update events (join + onTrackUpdated) are registered by
    // GameSocketCoordinator.start() above.

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
      this.playerStateService,
      this.cameraController
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

    // Static slideout reference panel with interactive tables (issue #192)
    this.loadsReferencePanel = new LoadsReferencePanel(this, [
      { key: "by-resource", label: "By Resource", type: "resource" }, // Interactive resource table
      { key: "by-city", label: "By City", type: "city" }, // Interactive city table
      { key: "player-cards", label: "Cards", type: "cards" }, // Dynamic content showing all players' hands
    ], this.gameState, this.cameraController);
    this.loadsReferencePanel.create();

    // Debug overlay (toggled with backtick key)
    this.debugOverlay = new DebugOverlay(this, this.gameStateService);

    // River crossing debug overlay (toggled with F10)
    this.riverDebugOverlay = new RiverDebugOverlay(this, this.mapContainer);

    // LLM transcript overlay (toggled with spacebar)
    this.llmTranscriptOverlay = new LLMTranscriptOverlay();

    // JIRA-36: Bot train animation system
    this.botTrainAnimator = new BotTrainAnimator(this);

    // Game event toast notifications
    this.gameToastManager = new GameToastManager(this);

    // Whisper advice panel — only instantiate when bots are present
    const hasBots = this.gameState.players.some(p => p.isBot);
    if (hasBots) {
      this.whisperPanel = new WhisperPanel(this, this.gameState.id, this.gameToastManager);
    }

    // Single dispatch point for bot:turn-complete payloads (toasts, animation,
    // whisper entries, transcript ingest) — depends only on the components
    // just constructed above, injected explicitly rather than reached into.
    this.botTurnPresenter = new BotTurnPresenter({
      gameToastManager: this.gameToastManager,
      botTrainAnimator: this.botTrainAnimator,
      whisperPanel: this.whisperPanel,
      llmTranscriptOverlay: this.llmTranscriptOverlay,
      getMapGridPoints: () => this.mapRenderer.gridPoints,
      getTrainSprite: (playerId) => this.uiManager.getTrainSprite(playerId),
      updateTrainPosition: (playerId, x, y, row, col, opts) =>
        void this.uiManager.updateTrainPosition(playerId, x, y, row, col, opts),
      resolveBotDisplay: (botPlayerId) => this.resolveBotDisplay(botPlayerId),
    });

    // Present any bot turns that completed while create() was still
    // constructing the presenter's dependencies, in arrival order.
    const queuedBotTurns = this.pendingBotTurns.splice(0);
    queuedBotTurns.forEach((payload) => this.botTurnPresenter!.present(payload));

    // Auto-run badge (hidden by default)
    this.autoRunBadge = new AutoRunBadge(this);

    // Event card overlay & map highlighting
    this.mapHighlighter = new MapHighlighter(this, this.mapContainer);
    this.setupEventOverlaySubscription();
    this.setupActiveEffectsSubscription();

    // Guard: clean up any stale listener from a prior create() call
    // that wasn't paired with a full shutdown() (e.g. scene re-entry).
    // Event-card, auto-run status, and bot:turn-complete subscriptions are
    // owned by GameSocketCoordinator (started above); only the debug-all-events
    // listener remains scene-local, so it is the only one guarded here.
    this.socketUnsubDebugAny?.();

    // F9 key listener — toggle auto-run (a one-shot emit, not a subscription,
    // so it stays here rather than in the coordinator)
    this.input.keyboard?.on('keydown-F9', () => {
      socketService.emitAutoRunToggle(this.gameState.id);
    });

    const overlay = this.debugOverlay;
    this.socketUnsubDebugAny = socketService.onAnyEvent((eventName: string, ...args: any[]) => {
      overlay.logSocketEvent(eventName, args.length === 1 ? args[0] : args);
    });

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
    this.showCitySelectionIfUnplaced(false);

    // Set a low frame rate for the scene
    this.game.loop.targetFps = 30;

    // Initialize ChatScene for this game (use auth userId for chat, not player slot id)
    const localPlayer = this.playerStateService.getLocalPlayer();
    if (localPlayer) {
      const authUserId =
        localPlayer.userId ??
        (() => {
          try {
            const userJson = localStorage.getItem('eurorails.user');
            return userJson ? (JSON.parse(userJson) as { id?: string })?.id : undefined;
          } catch {
            return undefined;
          }
        })();
      if (authUserId) {
        const existingChatScene = this.scene.get('ChatScene');
        
        // If ChatScene exists but isn't ready, restart it (handles hot reload scenarios)
        if (existingChatScene && !(existingChatScene as any).isReady) {
          this.scene.stop('ChatScene');
          this.scene.launch('ChatScene', {
            gameId: this.gameState.id,
            userId: authUserId,
          });
        } else if (!existingChatScene) {
          this.scene.launch('ChatScene', {
            gameId: this.gameState.id,
            userId: authUserId,
          });
        }
      }
    }

    // Add event handler for scene resume
    this.events.on("resume", async () => {
      this.uiManager.setupUIOverlay();
      await this.uiManager.setupPlayerHand(this.trackManager.isInDrawingMode);
      this.showCitySelectionIfUnplaced(false);
    });

    // Add resize handler to update UI when browser window is resized
    this.scale.on('resize', async () => {
      // Wait a bit for the resize to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      if (this.trackManager.isInDrawingMode) {
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        await this.uiManager.setupPlayerHand(true, this.getTotalBuildCost(currentPlayer.id));
      } else {
        await this.uiManager.setupPlayerHand(false);
      }

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

    // Always show the current cost until turn changes
    const currentPlayer =
      this.gameState.players[this.gameState.currentPlayerIndex];
    await this.uiManager.setupPlayerHand(isDrawingMode, this.getTotalBuildCost(currentPlayer.id));
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

    // Deduct build cost before the victory check below (eligibility reads
    // post-deduction money).
    await this.gameStateService.applyBuildCostDeduction(currentPlayer, buildCost);

    // Always end-turn cleanup (even if buildCost was 0) so per-turn UI state resets
    // and undo state doesn't leak across turns (e.g., 0-cost ferry builds).
    // This can throw and abort the turn; the turn-number increment below must
    // stay after it so a failed/retried End Turn does not skip turn numbers.
    await this.trackManager.endTurnCleanup(currentPlayer.id);
    this.uiManager.clearTurnUndoStack();

    // Increment the ending player's turn number only after cleanup succeeded.
    await this.gameStateService.applyTurnNumberIncrement(currentPlayer);

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

    this.resetMovementForNewTurn(newCurrentPlayer);
  }

  /**
   * Apply ferry turn-transition rules (PlayerStateService) and render the
   * resulting UI effects.
   */
  private async handleFerryTurnTransition(player: Player): Promise<void> {
    const result = this.playerStateService.applyFerryTurnTransition(
      player,
      (row, col) => this.mapRenderer.gridPoints[row]?.[col]
    );

    if (result.newPosition) {
      await this.uiManager.updateTrainPosition(
        player.id,
        result.newPosition.x,
        result.newPosition.y,
        result.newPosition.row,
        result.newPosition.col
      );
    }

    if (result.arrivedAtCity) {
      await this.uiManager.triggerCityArrival(player, result.arrivedAtCity);
    }
  }

  /**
   * Dispatch a bot:turn-complete payload to the presenter, or queue it if the
   * presenter has not been constructed yet (the socket coordinator registers
   * this callback early in create(); joining the room can immediately resume a
   * queued bot turn). Queued payloads are flushed right after construction.
   */
  private presentOrQueueBotTurn(payload: BotTurnCompletePayload): void {
    if (this.botTurnPresenter) {
      this.botTurnPresenter.present(payload);
    } else {
      this.pendingBotTurns.push(payload);
    }
  }

  /** Resolve display info (name/color) for a bot player — used by BotTurnPresenter. */
  private resolveBotDisplay(botPlayerId: string): BotDisplay {
    const botPlayer = this.gameState.players.find(p => p.id === botPlayerId);
    return {
      name: botPlayer?.name ?? 'Unknown Player',
      color: botPlayer ? parseInt(botPlayer.color.replace('#', '0x')) : 0x1a1a2e,
    };
  }

  /** Reset a player's movement allowance for a new turn, halving it after a ferry crossing. */
  private resetMovementForNewTurn(player: Player): void {
    const trainProps = TRAIN_PROPERTIES[player.trainType];
    if (!trainProps) {
      console.error(`Invalid train type: ${player.trainType}`);
      return;
    }
    if (player.trainState.justCrossedFerry) {
      player.trainState.remainingMovement = Math.ceil(trainProps.speed / 2);
      player.trainState.justCrossedFerry = false;
    } else {
      player.trainState.remainingMovement = trainProps.speed;
    }
  }

  /** Total build cost for the turn: previous drawing sessions plus the current one. */
  private getTotalBuildCost(playerId: string): number {
    const previousSessionsCost = this.trackManager.getPlayerTrackState(playerId)?.turnBuildCost || 0;
    return previousSessionsCost + this.trackManager.getCurrentTurnBuildCost();
  }

  /** Prompt city selection when the current player's train has no position yet. */
  private showCitySelectionIfUnplaced(localOnly: boolean): void {
    const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
    if (!currentPlayer || currentPlayer.trainState?.position) return;
    if (localOnly && this.playerStateService.getLocalPlayerId() !== currentPlayer.id) return;
    this.uiManager.showCitySelectionForPlayer(currentPlayer.id);
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
    const victoryState = await victoryService.declareVictory(
      this.gameState.id,
      player.id,
      connectedCities
    );
    if (victoryState) {
      this.gameState.victoryState = victoryState;
      // Note: Socket event handler (onVictoryTriggered) will show the notification to all players
    }
  }

  /**
   * Resolve victory at the end of the final round.
   * Called by the final turn player's client to determine winner.
   * Returns true if the game is over, false if it continues (e.g., tie extension).
   */
  private async resolveVictory(): Promise<boolean> {
    const { gameOver } = await VictoryService.getInstance().resolveVictory(
      this.gameState.id
    );
    return gameOver;
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
    const mySeq = ++this.turnChangeSeq;

    // Refresh player data from server to get updated money amounts
    await this.refreshPlayerData();
    if (mySeq !== this.turnChangeSeq) return;
    
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
      // Ferry transition must run before movement reset so justCrossedFerry is set
      await this.handleFerryTurnTransition(newCurrentPlayer);
      if (mySeq !== this.turnChangeSeq) return;

      this.resetMovementForNewTurn(newCurrentPlayer);

      this.uiManager.updateGameState(this.gameState);
      this.uiManager.setupUIOverlay();

      // Only show build costs for the local player
      const localPlayer = localPlayerId
        ? this.gameState.players.find(p => p.id === localPlayerId)
        : null;
      const totalCost = localPlayer && this.trackManager.isInDrawingMode
        ? this.getTotalBuildCost(localPlayer.id)
        : 0;

      await this.uiManager.setupPlayerHand(this.trackManager.isInDrawingMode, totalCost);
      if (mySeq !== this.turnChangeSeq) return;

      // Do not auto-pan on turn changes: each client keeps its own camera state,
      // and jumping to the new active player's train is disorienting.
      this.showCitySelectionIfUnplaced(true);
    }
  }

  /**
   * Subscribe to pendingEventOverlay store state.
   * Shows/hides EventCardOverlay and activates MapHighlighter when an event card is drawn.
   */
  private setupEventOverlaySubscription(): void {
    let prevOverlay = useGameStore.getState().pendingEventOverlay;

    this.unsubEventOverlay = useGameStore.subscribe((state) => {
      const overlay = state.pendingEventOverlay;
      if (overlay === prevOverlay) return;

      if (overlay && !prevOverlay) {
        // New overlay — show EventCardOverlay and activate map highlighting.
        this.showEventOverlay(overlay);
      } else if (overlay && prevOverlay) {
        // Another card arrived before the first was dismissed — replace it.
        this.eventCardOverlay?.destroy();
        this.showEventOverlay(overlay);
      } else if (!overlay && prevOverlay) {
        // Overlay dismissed — destroy it (MapHighlighter stays active until effect expires)
        this.eventCardOverlay?.destroy();
        this.eventCardOverlay = undefined;
      }

      prevOverlay = overlay;
    });
  }

  /** Create and display an EventCardOverlay, activating map highlights if applicable. */
  private showEventOverlay(overlay: EventCardDrawnPayload): void {
    this.eventCardOverlay = new EventCardOverlay(
      this,
      overlay,
      () => useGameStore.getState().dismissEventOverlay(),
    );

    if (overlay.affectedZone.length > 0 && this.mapHighlighter) {
      const eventType = overlay.card.type as EventCardType;
      this.mapHighlighter.activate(overlay.affectedZone, eventType, overlay.card.id);
    }
  }

  /**
   * Subscribe to activeEffects store state.
   * Activates MapHighlighter zones for newly added effects (e.g. on reconnect)
   * and deactivates zones when effects expire.
   */
  private setupActiveEffectsSubscription(): void {
    let previousCardIds = new Set(
      useGameStore.getState().activeEffects.map(e => e.cardId)
    );

    this.unsubActiveEffects = useGameStore.subscribe((state) => {
      const currentCardIds = new Set(state.activeEffects.map(e => e.cardId));

      // Activate highlights for newly added effects (e.g. restored on reconnect)
      for (const effect of state.activeEffects) {
        if (!previousCardIds.has(effect.cardId) && this.mapHighlighter && effect.affectedZone.length > 0) {
          this.mapHighlighter.activate(effect.affectedZone, effect.cardType as EventCardType, effect.cardId);
        }
      }

      // Deactivate highlights for removed effects
      for (const cardId of previousCardIds) {
        if (!currentCardIds.has(cardId) && this.mapHighlighter) {
          this.mapHighlighter.deactivate(cardId);
        }
      }

      previousCardIds = currentCardIds;
    });
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

    // Stop the resync timer and all game socket subscriptions.
    this.socketCoordinator?.stop();

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
    this.botTrainAnimator?.destroy();
    this.gameToastManager?.destroy();
    this.socketUnsubDebugAny?.();
    this.socketUnsubDebugAny = undefined;
    this.debugOverlay?.destroy();
    this.riverDebugOverlay?.destroy();
    this.llmTranscriptOverlay?.destroy();
    this.whisperPanel?.destroy();
    this.autoRunBadge?.destroy();

    // Clean up event card UI subscriptions and components
    this.unsubEventOverlay?.();
    this.unsubEventOverlay = undefined;
    this.unsubActiveEffects?.();
    this.unsubActiveEffects = undefined;
    this.mapHighlighter?.clear();
    this.mapHighlighter = undefined;
    this.eventCardOverlay = undefined;
  }

  /**
   * Apply resolved sprite position updates from GameSocketCoordinator (onPatch
   * and HTTP resync both funnel through this single apply path — see
   * GameSocketCoordinatorDeps.onApplySpriteUpdates).
   */
  private applySpriteUpdates(updates: RefreshSpriteUpdate[]): void {
    if (!this.gameState.trainSprites) {
      this.gameState.trainSprites = new Map();
    }
    for (const update of updates) {
      // persist: false — this position just came from the server, so writing
      // it back would be a redundant round-trip.
      this.uiManager.updateTrainPosition(
        update.playerId,
        update.x,
        update.y,
        update.row,
        update.col,
        { persist: false }
      );
    }
  }

  /** Refresh the UI overlay and loads reference panel after a server-driven state change. */
  private refreshGameUI(): void {
    this.uiManager.setupUIOverlay();
    // issue #176: hands are public — keep the reference panel in sync too.
    this.loadsReferencePanel?.setGameState(this.gameState);
  }

  /**
   * Refresh player data from server to get updated money and other state
   */
  private async refreshPlayerData(): Promise<void> {
    if (!this.gameState.id) return;

    const { spriteUpdates } = await this.playerStateService.refreshPlayersFromServer(
      this.gameState.id,
      this.gameState
    );

    // Ensure trainSprites map exists before updating
    if (!this.gameState.trainSprites) {
      this.gameState.trainSprites = new Map();
    }

    for (const train of spriteUpdates) {
      // JIRA-80: Skip sprite position update if bot animation is in progress —
      // turn:change events during animation would snap the sprite back mid-animation.
      if (this.botTrainAnimator?.isAnimating(train.playerId)) continue;
      try {
        await this.uiManager.updateTrainPosition(train.playerId, train.x, train.y, train.row, train.col);
      } catch (error) {
        console.error(`Error updating train position for player ${train.playerId}:`, error);
      }
    }

    // Refresh UI to show updated money
    this.uiManager.setupUIOverlay();
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

  /**
   * Toggle the chat sidebar
   */
  public toggleChat(): void {
    const chatScene = this.scene.get('ChatScene') as any;
    if (chatScene && chatScene.toggle) {
      chatScene.toggle();
    }
  }

  /**
   * Open the chat sidebar
   */
  public openChat(): void {
    const chatScene = this.scene.get('ChatScene') as any;
    if (chatScene && chatScene.open) {
      chatScene.open();
    }
  }

  /**
   * Open the chat sidebar in DM mode with a specific player
   */
  public openChatDM(recipientUserId: string, recipientName: string): void {
    const chatScene = this.scene.get('ChatScene') as any;

    if (!chatScene) {
      console.warn('[GameScene] ChatScene not available for DM');
      return;
    }

    // ChatScene.whenReady() resolves once its create() has finished, whether
    // that already happened or is still in flight — no polling required.
    chatScene.whenReady().then(() => {
      if (chatScene.openDM) {
        chatScene.openDM(recipientUserId, recipientName);
      }
    });
  }
}
