import 'phaser';
import { GameState, TerrainType } from '../../shared/types/GameTypes';
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
        // If we get a gameState, always use it
        if (data.gameState) {
            this.gameState = {
                ...data.gameState,
                // Ensure we preserve the camera state if it exists
                cameraState: data.gameState.cameraState || this.gameState.cameraState
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
            // Load both regular and fast/heavy train images
            this.load.image(`train_${color}`, `/assets/train_${color}.png`);
            this.load.image(`train_12_${color}`, `/assets/train_12_${color}.png`);
        });
    }

    async create() {
        // Clear any existing containers
        this.children.removeAll(true);
        
        // Initialize services
        this.gameStateService = new GameStateService(this.gameState);
        
        // Create containers in the right order
        this.mapContainer = this.add.container(0, 0);
        this.uiContainer = this.add.container(0, 0);
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
        this.mapRenderer = new MapRenderer(this, this.mapContainer, this.gameState, this.trackManager);
        
        // Create the map
        this.mapRenderer.createTriangularGrid();
        
        // Now update TrackManager with the created grid points
        this.trackManager.updateGridPoints(this.mapRenderer.gridPoints);
        
        // Create camera controller with map dimensions
        const { width, height } = this.mapRenderer.calculateMapDimensions();
        this.cameraController = new CameraController(this, width, height, this.gameState);
        
        // Load existing tracks before creating UI
        await this.trackManager.loadExistingTracks();
        
        // Create UI manager with callbacks after tracks are loaded
        this.uiManager = new UIManager(
            this,
            this.gameState,
            () => this.toggleDrawingMode(), // Call GameScene's method instead of directly accessing TrackManager
            () => this.nextPlayerTurn(),
            () => this.openSettings(),
            this.gameStateService,
            this.mapRenderer
        );
        
        // Set container references from UI manager
        const containers = this.uiManager.getContainers();
        this.uiContainer = containers.uiContainer;
        this.playerHandContainer = containers.playerHandContainer;
        
        // Add train container to map container
        this.mapContainer.add(containers.trainContainer);
        
        // Register for track cost updates
        this.trackManager.onCostUpdate((cost) => {
            // Update the UI to show the current track cost
            if (this.trackManager.isInDrawingMode) {
                this.uiManager.setupPlayerHand(true, cost);
            }
        });
        
        // Create a separate camera for UI that won't move
        const uiCamera = this.cameras.add(0, 0, this.cameras.main.width, this.cameras.main.height);
        uiCamera.setScroll(0, 0);
        uiCamera.ignore(this.mapContainer);  // UI camera ignores the map
        
        // Main camera ignores UI elements
        this.cameras.main.ignore([this.uiContainer, this.playerHandContainer]);
        
        // Initialize or restore train positions for each player
        this.gameState.players.forEach(player => {
            if (player.trainState.position) {
                // Restore existing position
                this.uiManager.updateTrainPosition(
                    player.id,
                    player.trainState.position.x,
                    player.trainState.position.y,
                    player.trainState.position.row,
                    player.trainState.position.col
                );
            }
            else {
                this.uiManager.showCitySelectionForPlayer(player.id);
            }
            
        });
        
        // Setup camera
        this.cameraController.setupCamera();
        
        // Setup UI elements
        this.uiManager.setupUIOverlay();
        this.uiManager.setupPlayerHand(this.trackManager.isInDrawingMode);
        
        // Set a low frame rate for the scene
        this.game.loop.targetFps = 30;
        
        // Add event handler for scene resume
        this.events.on('resume', () => {
            // Clear and recreate UI elements
            this.uiManager.setupUIOverlay();
            this.uiManager.setupPlayerHand(this.trackManager.isInDrawingMode);
            
            // Re-show city selection for current player if needed
            const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
            if (!currentPlayer.trainState.position) {
                this.uiManager.showCitySelectionForPlayer(currentPlayer.id);
            }
        });
    }
    
    private toggleDrawingMode(): void {
        const isDrawingMode = this.trackManager.toggleDrawingMode();
        
        // Update UIManager's drawing mode state
        this.uiManager.setDrawingMode(isDrawingMode);
        
        // If exiting drawing mode, update the UI completely to refresh money display
        if (!isDrawingMode) {
            this.uiManager.setupUIOverlay();
        }
        
        // Get the current cost to display regardless of drawing mode
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const previousSessionsCost = this.trackManager.getLastBuildCost(currentPlayer.id);
        const currentSessionCost = this.trackManager.getCurrentTurnBuildCost();
        const totalCost = previousSessionsCost + currentSessionCost;
        
        // Always show the current cost until turn changes
        this.uiManager.setupPlayerHand(isDrawingMode, totalCost);
    }
    
    private async nextPlayerTurn(): Promise<void> {
        // Get the current player before changing turns
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        
        // Check if there was a build cost from the player's previous activity
        let buildCost = this.trackManager.getLastBuildCost(currentPlayer.id);
        
        // If in drawing mode, finalize track drawing first by toggling it off
        // This will handle saving tracks and cleanup through TrackDrawingManager
        if (this.trackManager.isInDrawingMode) {
            const isDrawingMode = this.trackManager.toggleDrawingMode();
            // Make sure UIManager's drawing mode state stays in sync
            this.uiManager.setDrawingMode(isDrawingMode);
            
            // Get the updated build cost after saving track state
            buildCost = this.trackManager.getLastBuildCost(currentPlayer.id);
        }
        
        // Deduct track building cost from player's money if there was any building
        if (buildCost > 0) {
            const newMoney = currentPlayer.money - buildCost;
            
            try {
                // Update player money in local state and database
                await this.gameStateService.updatePlayerMoney(currentPlayer.id, newMoney);
            } catch (error) {
                console.error('Error updating player money:', error);
            }
            
            // Clear the build cost after processing it to avoid double-counting
            await this.trackManager.clearLastBuildCost(currentPlayer.id);
        }
        
        // Use the game state service to handle player turn changes
        await this.gameStateService.nextPlayerTurn();
        
        // Get the new current player after the turn change
        const newCurrentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        newCurrentPlayer.turnNumber = newCurrentPlayer.turnNumber + 1;
        console.log('newCurrentPlayer', newCurrentPlayer);
        // Update the UI
        this.uiManager.cleanupCityDropdowns();
        this.uiManager.setupUIOverlay();
        // Ensure drawing mode is off for the new player and sync the state
        this.uiManager.setDrawingMode(false);
        this.uiManager.setupPlayerHand(false);

        // Check if new current player needs to select a starting city
        if (!this.mapRenderer.playerHasTrack(newCurrentPlayer.id)) {
            this.uiManager.showCitySelectionForPlayer(newCurrentPlayer.id);
        }
    }
    
    private openSettings() {
        // Pause this scene and start settings scene
        this.scene.pause();
        this.scene.launch('SettingsScene', { gameState: this.gameState });
    }
}