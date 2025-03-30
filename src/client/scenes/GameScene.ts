import 'phaser';
import { GameState } from '../../shared/types/GameTypes';
import { MapRenderer } from '../components/MapRenderer';
import { CameraController } from '../components/CameraController';
import { TrackDrawingManager } from '../components/TrackDrawingManager';
import { UIManager } from '../components/UIManager';
import { GameStateService } from '../services/GameStateService';

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
    
    // Game state
    public gameState: GameState;  // Keep public for compatibility with SettingsScene

    constructor() {
        super({ key: 'GameScene' });
        // Initialize with empty game state
        this.gameState = {
            id: '',  // Will be set by SetupScene
            players: [],
            currentPlayerIndex: 0,
            status: 'setup',
            maxPlayers: 6
        };
    }

    init(data: { gameState?: GameState }) {
        console.debug('GameScene init called with data:', data);
        
        // If we get a gameState, always use it
        if (data.gameState) {
            this.gameState = {
                ...data.gameState,
                // Ensure we preserve the camera state if it exists
                cameraState: data.gameState.cameraState || this.gameState.cameraState
            };
            
            // If we have camera state, apply it immediately
            if (this.gameState.cameraState) {
                console.debug('Applying camera state in init:', this.gameState.cameraState);
                this.cameras.main.setZoom(this.gameState.cameraState.zoom);
                this.cameras.main.scrollX = this.gameState.cameraState.scrollX;
                this.cameras.main.scrollY = this.gameState.cameraState.scrollY;
            }
            return;
        }
        
        // If we don't have a game state or players, go to setup
        if (!this.gameState.id || this.gameState.players.length === 0) {
            this.scene.start('SetupScene');
            return;
        }
    }

    preload() {
        this.load.image('ferry-port', '/assets/ferry-port.png');
        
        // Preload crayon images for each player color
        const colors = ['red', 'blue', 'green', 'yellow', 'black', 'brown'];
        colors.forEach(color => {
            this.load.image(`crayon_${color}`, `/assets/crayon_${color}.png`);
        });
    }

    async create() {
        console.debug('GameScene create method called');
        console.debug('Initial game state:', this.gameState);
        
        // Clear any existing containers
        this.children.removeAll(true);
        
        // Initialize services
        this.gameStateService = new GameStateService(this.gameState);
        
        // Create containers in the right order
        this.mapContainer = this.add.container(0, 0);
        this.uiContainer = this.add.container(0, 0);
        this.playerHandContainer = this.add.container(0, 0);
        
        // Initialize component managers
        this.mapRenderer = new MapRenderer(this, this.mapContainer);
        
        // Create the map
        console.debug('Creating triangular grid...');
        this.mapRenderer.createTriangularGrid();
        
        // Create camera controller with map dimensions
        const { width, height } = this.mapRenderer.calculateMapDimensions();
        this.cameraController = new CameraController(this, width, height, this.gameState);
        
        // Create UI manager with callbacks
        this.uiManager = new UIManager(
            this, 
            this.gameState,
            () => this.toggleDrawingMode(),
            () => this.nextPlayerTurn(),
            () => this.openSettings()
        );
        
        // Set container references from UI manager
        const containers = this.uiManager.getContainers();
        this.uiContainer = containers.uiContainer;
        this.playerHandContainer = containers.playerHandContainer;
        
        // Create track manager
        this.trackManager = new TrackDrawingManager(
            this,
            this.mapContainer,
            this.gameState,
            this.mapRenderer.gridPoints
        );
        
        // Create a separate camera for UI that won't move
        const uiCamera = this.cameras.add(0, 0, this.cameras.main.width, this.cameras.main.height);
        uiCamera.setScroll(0, 0);
        uiCamera.ignore(this.mapContainer);  // UI camera ignores the map
        
        // Main camera ignores UI elements
        this.cameras.main.ignore([this.uiContainer, this.playerHandContainer]);
        
        // Load existing tracks
        console.debug('Loading existing tracks...');
        await this.trackManager.loadExistingTracks();
        
        // Setup camera
        console.debug('Setting up camera...');
        this.cameraController.setupCamera();
        
        // Setup UI elements
        this.uiManager.setupUIOverlay();
        this.uiManager.setupPlayerHand();
        
        // Set a low frame rate for the scene
        this.game.loop.targetFps = 30;
        
        // Add event handler for scene resume
        this.events.on('resume', () => {
            console.debug('Scene resumed, refreshing UI...');
            // Clear and recreate UI elements
            this.uiManager.setupUIOverlay();
            this.uiManager.setupPlayerHand();
        });
    }
    
    private toggleDrawingMode(): void {
        this.trackManager.toggleDrawingMode();
        // Re-render the player hand to update UI state if needed
        this.uiManager.setupPlayerHand();
    }
    
    private async nextPlayerTurn() {
        // Use the game state service to handle player turn changes
        await this.gameStateService.nextPlayerTurn();
        
        // Update the UI
        this.uiManager.setupUIOverlay();
        this.uiManager.setupPlayerHand();
    }
    
    private openSettings() {
        // Pause this scene and start settings scene
        this.scene.pause();
        this.scene.launch('SettingsScene', { gameState: this.gameState });
    }
}