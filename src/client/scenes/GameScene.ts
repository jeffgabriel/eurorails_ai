import 'phaser';
import { mapConfig } from '../config/mapConfig';
import { GameState, TerrainType } from '../../shared/types/GameTypes';
import { PlayerTrackState, TrackSegment, TrackBuildResult, TrackBuildError } from '../../shared/types/TrackTypes';

interface GridPoint {
    x: number;  // screen x
    y: number;  // screen y
    row: number;  // grid row
    col: number;  // grid column
    sprite?: Phaser.GameObjects.Graphics | Phaser.GameObjects.Image;
    terrain: TerrainType;
    ferryConnection?: { row: number; col: number };
    city?: {
        type: TerrainType;
        name: string;
        connectedPoints?: Array<{ row: number; col: number }>;
    };
}

export class GameScene extends Phaser.Scene {
    private mapContainer!: Phaser.GameObjects.Container;
    private uiContainer!: Phaser.GameObjects.Container;
    private playerHandContainer!: Phaser.GameObjects.Container;
    private gridPoints: GridPoint[][] = [];
    private isDragging: boolean = false;
    private lastDragTime: number = 0;
    private pendingRender: boolean = false;
    public gameState: GameState;  // Make gameState public
    
    // Drawing mode state
    private isDrawingMode: boolean = false;
    private drawingGraphics!: Phaser.GameObjects.Graphics;
    private currentSegments: TrackSegment[] = [];
    private lastClickedPoint: GridPoint | null = null;
    private turnBuildCost: number = 0;
    private readonly MAX_TURN_BUILD_COST = 20; // 20M ECU per turn
    
    // Track state
    private playerTracks: Map<string, PlayerTrackState> = new Map();

    // Grid configuration
    private readonly GRID_WIDTH = 70;
    private readonly GRID_HEIGHT = 90;
    private readonly HORIZONTAL_SPACING = 35;
    private readonly VERTICAL_SPACING = 35;
    private readonly POINT_RADIUS = 3;
    private readonly GRID_MARGIN = 100;        // Increased margin around the grid
    private readonly FERRY_ICON_SIZE = 12; // Size for the ferry icon
    private readonly terrainColors = {
        [TerrainType.Clear]: 0x000000,
        [TerrainType.Water]: 0x0000ff,
        [TerrainType.Mountain]: 0x964B00,
        [TerrainType.Alpine]: 0x808080,
        [TerrainType.FerryPort]: 0xffa500
    };

    private readonly CITY_COLORS = {
        [TerrainType.MajorCity]: 0xff9999,  // Brighter red for major cities
        [TerrainType.MediumCity]: 0x9999ff,        // Brighter blue for cities
        [TerrainType.SmallCity]: 0x99ff99   // Brighter green for small cities
    };

    private readonly CITY_RADIUS = {
        [TerrainType.MajorCity]: 30,   // Size for major city hexagon
        [TerrainType.MediumCity]: 12,         // Reduced size for city circle
        [TerrainType.SmallCity]: 8     // Reduced size for small city square
    };

    // Track building costs
    private readonly TERRAIN_COSTS: { [key in TerrainType]: number } = {
        [TerrainType.Clear]: 1,
        [TerrainType.Mountain]: 2,
        [TerrainType.Alpine]: 5,
        [TerrainType.SmallCity]: 3,
        [TerrainType.MediumCity]: 3,
        [TerrainType.MajorCity]: 5,
        [TerrainType.Water]: 0,
        [TerrainType.FerryPort]: 0
    };

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
            this.gameState = data.gameState;
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

    create() {
        console.debug('GameScene create method called');
        // Clear any existing containers
        this.children.removeAll(true);
        
        // Create containers in the right order
        this.mapContainer = this.add.container(0, 0);
        this.uiContainer = this.add.container(0, 0);
        this.playerHandContainer = this.add.container(0, 0);
        
        // Initialize drawing graphics
        this.drawingGraphics = this.add.graphics({ lineStyle: { width: 3, color: 0x000000 } });
        this.mapContainer.add(this.drawingGraphics);
        
        // Setup scene elements
        this.setupCamera();
        this.createTriangularGrid();

        // Create a separate camera for UI that won't move
        const uiCamera = this.cameras.add(0, 0, this.cameras.main.width, this.cameras.main.height);
        uiCamera.setScroll(0, 0);
        uiCamera.ignore(this.mapContainer);  // UI camera ignores the map
        
        // Main camera ignores UI elements
        this.cameras.main.ignore([this.uiContainer, this.playerHandContainer]);

        // Setup UI elements
        this.setupUIOverlay();
        this.setupPlayerHand();

        // Set up drawing mode click handler
        this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
            if (this.isDrawingMode) {
                this.handleDrawingClick(pointer);
            }
        });

        // Set a low frame rate for the scene
        this.game.loop.targetFps = 30;

        // Add event handler for scene resume
        this.events.on('resume', () => {
            // Clear and recreate UI elements
            this.uiContainer?.removeAll(true);
            this.playerHandContainer?.removeAll(true);
            this.setupUIOverlay();
            this.setupPlayerHand();
        });
    }

    private requestRender() {
        if (!this.pendingRender) {
            this.pendingRender = true;
            requestAnimationFrame(() => {
                this.cameras.main.dirty = true;
                this.pendingRender = false;
            });
        }
    }

    private createContainers() {
        // Main map container - will be scrollable
        this.mapContainer = this.add.container(0, 0);
        
        // UI overlay container - fixed position
        this.uiContainer = this.add.container(0, 0);
        
        // Player hand container - fixed at bottom
        this.playerHandContainer = this.add.container(0, this.cameras.main.height - 200);
        
        // Create a separate camera for UI elements that shouldn't scroll
        const uiCamera = this.cameras.add(0, 0, this.cameras.main.width, this.cameras.main.height);
        uiCamera.ignore(this.mapContainer);
        uiCamera.setScroll(0, 0);
        
        // Make main camera ignore UI elements
        this.cameras.main.ignore([this.uiContainer, this.playerHandContainer]);
    }

    private calculateMapDimensions() {
        const width = (this.GRID_WIDTH * this.HORIZONTAL_SPACING) + (this.GRID_MARGIN * 2);
        const height = (this.GRID_HEIGHT * this.VERTICAL_SPACING) + (this.GRID_MARGIN * 2);
        return { width, height };
    }

    private setupMapArea() {
        const { width, height } = this.calculateMapDimensions();
        
        // Create a background for the map area that fits the grid exactly
        const mapBackground = this.add.rectangle(
            width / 2,  // Center the background
            height / 2,
            width,
            height,
            0xf0f0f0
        );
        
        const mapLabel = this.add.text(
            this.GRID_MARGIN + 10,  // Adjust label position to account for margin
            this.GRID_MARGIN + 10,
            'Game Map (Pan & Zoom)',
            { color: '#000000', fontSize: '16px' }
        );
        
        this.mapContainer.add([mapBackground, mapLabel]);
        
        // Create the triangular grid
        this.createTriangularGrid();
    }

    private createTriangularGrid(): void {
        // Create lookup maps
        const terrainLookup = new Map<string, { 
            terrain: TerrainType, 
            ferryConnection?: { row: number; col: number },
            city?: { type: TerrainType; name: string; connectedPoints?: Array<{ row: number; col: number }> }
        }>();
        
        // Create a map to store connected city points
        const cityAreaPoints = new Map<string, { city: { type: TerrainType; name: string }, terrain: TerrainType }>();
        
        // First pass: Build lookup maps and identify city areas
        mapConfig.points.forEach(point => {
            terrainLookup.set(`${point.row},${point.col}`, {
                terrain: point.terrain,
                ferryConnection: point.ferryConnection,
                city: point.city
            });
            
            // If this is a city point, mark all its connected points
            if (point.city?.connectedPoints) {
                // Mark the center point
                cityAreaPoints.set(`${point.row},${point.col}`, {
                    city: point.city,
                    terrain: point.terrain
                });
                
                // Mark all connected points as part of the city
                point.city.connectedPoints.forEach(connectedPoint => {
                    cityAreaPoints.set(`${connectedPoint.row},${connectedPoint.col}`, {
                        city: point.city!,
                        terrain: point.terrain
                    });
                });
            }
        });

        // Create graphics objects for different elements
        const cityAreas = this.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });
        const landPoints = this.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });
        const mountainPoints = this.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });
        const hillPoints = this.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });
        const ferryConnections = this.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });

        // Set styles
        landPoints.lineStyle(1, 0x000000);
        landPoints.fillStyle(this.terrainColors[TerrainType.Clear]);
        mountainPoints.lineStyle(1, 0x000000);
        hillPoints.lineStyle(1, 0x000000);
        hillPoints.fillStyle(this.terrainColors[TerrainType.Mountain]);
        ferryConnections.lineStyle(2, 0xffa500, 0.5);

        // First pass: Draw city areas
        const majorCities = new Set<string>(); // Track major city points
        for (let row = 0; row < this.GRID_HEIGHT; row++) {
            for (let col = 0; col < this.GRID_WIDTH; col++) {
                const config = terrainLookup.get(`${row},${col}`);
                if (config?.city) {
                    const isOffsetRow = row % 2 === 1;
                    const x = col * this.HORIZONTAL_SPACING + (isOffsetRow ? this.HORIZONTAL_SPACING / 2 : 0);
                    const y = row * this.VERTICAL_SPACING;

                    if (config.city.type === TerrainType.MajorCity && config.city.connectedPoints) {
                        // Only draw major city once
                        const cityKey = `${config.city.name}`;
                        if (!majorCities.has(cityKey)) {
                            majorCities.add(cityKey);
                            
                            // Draw hexagonal area
                            cityAreas.fillStyle(this.CITY_COLORS[TerrainType.MajorCity], 0.7);
                            cityAreas.lineStyle(2, 0x000000, 0.7);
                            cityAreas.beginPath();
                            
                            // Find center point (first point in the array) and outer points
                            const centerPoint = config.city.connectedPoints[0];
                            const outerPoints = config.city.connectedPoints.slice(1);
                            
                            // Calculate center coordinates
                            const centerIsOffsetRow = centerPoint.row % 2 === 1;
                            const centerX = centerPoint.col * this.HORIZONTAL_SPACING + 
                                         (centerIsOffsetRow ? this.HORIZONTAL_SPACING / 2 : 0);
                            const centerY = centerPoint.row * this.VERTICAL_SPACING;

                            // Sort outer points clockwise around the center
                            const sortedPoints = outerPoints
                                .map(p => ({
                                    point: p,
                                    angle: Math.atan2(
                                        p.row - centerPoint.row,
                                        p.col - centerPoint.col
                                    )
                                }))
                                .sort((a, b) => a.angle - b.angle)
                                .map(p => {
                                    const pIsOffsetRow = p.point.row % 2 === 1;
                                    return {
                                        x: p.point.col * this.HORIZONTAL_SPACING + 
                                           (pIsOffsetRow ? this.HORIZONTAL_SPACING / 2 : 0),
                                        y: p.point.row * this.VERTICAL_SPACING
                                    };
                                });
                            
                            // Draw the hexagon
                            cityAreas.moveTo(sortedPoints[0].x, sortedPoints[0].y);
                            for (let i = 1; i < sortedPoints.length; i++) {
                                cityAreas.lineTo(sortedPoints[i].x, sortedPoints[i].y);
                            }
                            cityAreas.closePath();
                            cityAreas.fill();
                            cityAreas.stroke();

                            // Draw star at center point
                            this.drawStar(cityAreas, centerX, centerY, 8);

                            // Add city name centered in the hexagon
                            const cityName = this.add.text(
                                centerX + this.GRID_MARGIN,
                                centerY + this.GRID_MARGIN + 15,  // Added offset to move below center point
                                config.city.name,
                                { 
                                    color: '#000000',
                                    fontSize: '12px',
                                    fontStyle: 'bold'
                                }
                            );
                            cityName.setOrigin(0.5, 0.5);
                            this.mapContainer.add(cityName);
                        }
                    } else if (config.city.type === TerrainType.MediumCity) {
                        // Draw circle for regular city
                        cityAreas.fillStyle(this.CITY_COLORS[TerrainType.MediumCity], 0.7);  // Increased opacity
                        cityAreas.lineStyle(2, 0x000000, 0.7);  // Darker border
                        cityAreas.beginPath();
                        cityAreas.arc(x, y, this.CITY_RADIUS[TerrainType.MediumCity], 0, Math.PI * 2);
                        cityAreas.closePath();
                        cityAreas.fill();
                        cityAreas.stroke();

                        // Add city name with adjusted position
                        const cityName = this.add.text(
                            x + this.GRID_MARGIN,
                            y + this.GRID_MARGIN - 15,
                            config.city.name,
                            { 
                                color: '#000000',
                                fontSize: '10px'
                            }
                        );
                        cityName.setOrigin(0.5, 0.5);
                        this.mapContainer.add(cityName);
                    } else if (config.city.type === TerrainType.SmallCity) {
                        // Draw square for small city
                        cityAreas.fillStyle(this.CITY_COLORS[TerrainType.SmallCity], 0.7);  // Increased opacity
                        cityAreas.lineStyle(2, 0x000000, 0.7);  // Darker border
                        const radius = this.CITY_RADIUS[TerrainType.SmallCity];
                        cityAreas.fillRect(x - radius, y - radius, radius * 2, radius * 2);
                        cityAreas.strokeRect(x - radius, y - radius, radius * 2, radius * 2);

                        // Add city name with adjusted position
                        const cityName = this.add.text(
                            x + this.GRID_MARGIN,
                            y + this.GRID_MARGIN - 15,
                            config.city.name,
                            { 
                                color: '#000000',
                                fontSize: '8px'
                            }
                        );
                        cityName.setOrigin(0.5, 0.5);
                        this.mapContainer.add(cityName);
                    }
                }
            }
        }

        // Second pass: Draw regular grid points and terrain
        for (let row = 0; row < this.GRID_HEIGHT; row++) {
            this.gridPoints[row] = [];
            const isOffsetRow = row % 2 === 1;
            
            for (let col = 0; col < this.GRID_WIDTH; col++) {
                const x = col * this.HORIZONTAL_SPACING + (isOffsetRow ? this.HORIZONTAL_SPACING / 2 : 0);
                const y = row * this.VERTICAL_SPACING;

                const config = terrainLookup.get(`${row},${col}`);
                const cityAreaConfig = cityAreaPoints.get(`${row},${col}`);
                
                // Use city area config if available, otherwise use regular config
                const terrain = config?.terrain || TerrainType.Clear;
                const ferryConnection = config?.ferryConnection;
                const city = cityAreaConfig?.city || config?.city;

                let sprite: Phaser.GameObjects.Graphics | Phaser.GameObjects.Image | undefined;

                // Skip drawing point for water terrain
                if (terrain !== TerrainType.Water) {
                    if (terrain === TerrainType.Alpine || terrain === TerrainType.Mountain) {
                        // Draw terrain features as before
                        const graphics = terrain === TerrainType.Alpine ? mountainPoints : hillPoints;
                        const triangleHeight = this.POINT_RADIUS * 2;
                        graphics.beginPath();
                        graphics.moveTo(x, y - triangleHeight);
                        graphics.lineTo(x - triangleHeight, y + triangleHeight);
                        graphics.lineTo(x + triangleHeight, y + triangleHeight);
                        graphics.closePath();
                        if (terrain === TerrainType.Mountain) {
                            graphics.fill();
                        }
                        graphics.stroke();
                    } else if (terrain === TerrainType.FerryPort) {
                        sprite = this.add.image(x + this.GRID_MARGIN, y + this.GRID_MARGIN, 'ferry-port');
                        sprite.setDisplaySize(this.FERRY_ICON_SIZE, this.FERRY_ICON_SIZE);
                        this.mapContainer.add(sprite);
                    } else {
                        // Draw standard point
                        landPoints.beginPath();
                        landPoints.arc(x, y, this.POINT_RADIUS, 0, Math.PI * 2);
                        landPoints.closePath();
                        landPoints.fill();
                        landPoints.stroke();
                    }
                }

                // Store point data with grid coordinates
                this.gridPoints[row][col] = { 
                    x: x + this.GRID_MARGIN, 
                    y: y + this.GRID_MARGIN,
                    row,
                    col,
                    sprite, 
                    terrain,
                    ferryConnection,
                    city 
                };
            }
        }

        // Add all graphics objects to the map container in correct order
        this.mapContainer.add([cityAreas, landPoints, mountainPoints, hillPoints, ferryConnections]);
    }

    private drawStar(graphics: Phaser.GameObjects.Graphics, x: number, y: number, radius: number) {
        const points = 5;
        const innerRadius = radius * 0.4;  // Inner radius of the star
        
        graphics.beginPath();
        
        for (let i = 0; i <= points * 2; i++) {
            const r = i % 2 === 0 ? radius : innerRadius;
            const angle = (i * Math.PI) / points;
            const pointX = x + r * Math.sin(angle);
            const pointY = y - r * Math.cos(angle);
            
            if (i === 0) {
                graphics.moveTo(pointX, pointY);
            } else {
                graphics.lineTo(pointX, pointY);
            }
        }
        
        graphics.closePath();
        graphics.fillStyle(0x000000, 1);  // Black fill
        graphics.fill();
        graphics.lineStyle(1, 0x000000);
        graphics.stroke();
    }

    private setupUIOverlay() {
        if (!this.gameState || !this.gameState.players || this.gameState.players.length === 0) {
            return;
        }

        const LEADERBOARD_WIDTH = 150;
        const LEADERBOARD_PADDING = 10;
        
        // Add settings button
        const settingsButton = this.add.rectangle(
            LEADERBOARD_PADDING,
            LEADERBOARD_PADDING,
            40,
            40,
            0x444444,
            0.9
        ).setOrigin(0, 0);

        const settingsIcon = this.add.text(
            LEADERBOARD_PADDING + 20,
            LEADERBOARD_PADDING + 20,
            '⚙️',
            { fontSize: '24px' }
        ).setOrigin(0.5);

        settingsButton.setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.openSettings())
            .on('pointerover', () => settingsButton.setFillStyle(0x555555))
            .on('pointerout', () => settingsButton.setFillStyle(0x444444));

        // Create semi-transparent background for leaderboard
        const leaderboardHeight = 40 + (this.gameState.players.length * 20) + 50; // Added height for next player button
        const leaderboardBg = this.add.rectangle(
            this.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
            LEADERBOARD_PADDING,
            LEADERBOARD_WIDTH,
            leaderboardHeight,
            0x333333,
            0.9
        ).setOrigin(0, 0);
        
        // Add leaderboard title
        const leaderboardTitle = this.add.text(
            this.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING + (LEADERBOARD_WIDTH / 2),
            LEADERBOARD_PADDING + 5,
            'Players',
            { 
                color: '#ffffff',
                fontSize: '16px',
                fontStyle: 'bold'
            }
        ).setOrigin(0.5, 0);
        
        // Add all player entries
        const playerEntries = this.gameState.players.map((player, index) => {
            const isCurrentPlayer = index === this.gameState.currentPlayerIndex;
            
            // Create background highlight for current player
            let entryBg;
            if (isCurrentPlayer) {
                entryBg = this.add.rectangle(
                    this.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
                    LEADERBOARD_PADDING + 30 + (index * 20),
                    LEADERBOARD_WIDTH,
                    20,
                    0x666666,
                    0.5
                ).setOrigin(0, 0);
            }
            
            // Create player text
            const playerText = this.add.text(
                this.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING + 5,
                LEADERBOARD_PADDING + 30 + (index * 20),
                `${isCurrentPlayer ? '►' : ' '} ${player.name}`,
                { 
                    color: '#ffffff',
                    fontSize: '14px',
                    fontStyle: isCurrentPlayer ? 'bold' : 'normal'
                }
            ).setOrigin(0, 0);

            // Create money text (right-aligned)
            const moneyText = this.add.text(
                this.scale.width - LEADERBOARD_PADDING - 5,
                LEADERBOARD_PADDING + 30 + (index * 20),
                `${player.money}M`,
                { 
                    color: '#ffffff',
                    fontSize: '14px',
                    fontStyle: isCurrentPlayer ? 'bold' : 'normal'
                }
            ).setOrigin(1, 0);  // Right-align

            // Return all elements for this player
            return entryBg ? [entryBg, playerText, moneyText] : [playerText, moneyText];
        }).flat();  // Flatten the array of arrays

        // Add next player button
        const nextPlayerButton = this.add.rectangle(
            this.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
            LEADERBOARD_PADDING + 40 + (this.gameState.players.length * 20),
            LEADERBOARD_WIDTH,
            40,
            0x00aa00,
            0.9
        ).setOrigin(0, 0);

        const nextPlayerText = this.add.text(
            this.scale.width - LEADERBOARD_WIDTH / 2 - LEADERBOARD_PADDING,
            LEADERBOARD_PADDING + 60 + (this.gameState.players.length * 20),
            'Next Player',
            { 
                color: '#ffffff',
                fontSize: '16px',
                fontStyle: 'bold'
            }
        ).setOrigin(0.5, 0.5);

        // Make the button interactive
        nextPlayerButton.setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.nextPlayerTurn())
            .on('pointerover', () => nextPlayerButton.setFillStyle(0x008800))
            .on('pointerout', () => nextPlayerButton.setFillStyle(0x00aa00));
        
        this.uiContainer.add([leaderboardBg, leaderboardTitle, ...playerEntries, nextPlayerButton, nextPlayerText]);
    }

    private openSettings() {
        // Pause this scene and start settings scene
        this.scene.pause();
        this.scene.launch('SettingsScene', { gameState: this.gameState });
    }

    private setupPlayerHand() {
        if (!this.gameState || !this.gameState.players || this.gameState.players.length === 0) {
            return;
        }

        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        
        // Create background for player's hand area
        const handBackground = this.add.rectangle(
            0,
            this.scale.height - 200,  // Position from bottom of screen
            this.scale.width,
            200,
            0x333333,
            0.8
        ).setOrigin(0, 0);
        
        // Add sections for demand cards (3 slots)
        for (let i = 0; i < 3; i++) {
            // Create card background
            const cardSlot = this.add.rectangle(
                30 + (i * 180),  // Space cards horizontally
                this.scale.height - 180,  // Position relative to bottom
                150,  // Card width
                160,  // Card height
                0x666666
            ).setOrigin(0, 0);
            
            // Add card label
            const cardLabel = this.add.text(
                30 + (i * 180) + 75,  // Center text above card
                this.scale.height - 195,  // Position above card
                `Demand Card ${i + 1}`,
                { 
                    color: '#ffffff', 
                    fontSize: '14px' 
                }
            ).setOrigin(0.5, 0);
            
            this.playerHandContainer.add([cardSlot, cardLabel]);
        }
        
        // Create train card section
        const trainSection = this.add.rectangle(
            600,  // Position after demand cards
            this.scale.height - 180,  // Align with demand cards
            180,  // Width
            160,  // Height
            0x666666
        ).setOrigin(0, 0);
        
        const trainLabel = this.add.text(
            690,  // Center above train card
            this.scale.height - 195,  // Align with other labels
            `${currentPlayer.trainType}`,
            { 
                color: '#ffffff', 
                fontSize: '14px' 
            }
        ).setOrigin(0.5, 0);
        
        // Add player info
        const playerInfo = this.add.text(
            820,  // Position after train card
            this.scale.height - 180,  // Align with cards
            `${currentPlayer.name}\nMoney: ECU ${currentPlayer.money}M`,
            { 
                color: '#ffffff',  // Changed to white for better visibility
                fontSize: '20px',
                fontStyle: 'bold'
            }
        ).setOrigin(0, 0);

        // Add crayon button
        const colorMap: { [key: string]: string } = {
            '#FFD700': 'yellow',
            '#FF0000': 'red',
            '#0000FF': 'blue',
            '#000000': 'black',
            '#008000': 'green',
            '#8B4513': 'brown'
        };
        
        const crayonColor = colorMap[currentPlayer.color.toUpperCase()] || 'black';
        const crayonTexture = `crayon_${crayonColor}`;
        
        // Position crayon relative to player info
        const crayonButton = this.add.image(
            820 + 200,  // Position 200 pixels right of player info start
            this.scale.height - 140,  // Vertically center between player info lines
            crayonTexture
        ).setScale(0.15)
        .setInteractive({ useHandCursor: true });

        // Add hover effect and click handler
        crayonButton
            .on('pointerover', () => {
                if (!this.isDrawingMode) {
                    crayonButton.setScale(0.17);
                }
            })
            .on('pointerout', () => {
                if (!this.isDrawingMode) {
                    crayonButton.setScale(0.15);
                }
            })
            .on('pointerdown', (pointer: Phaser.Input.Pointer) => {
                pointer.event.stopPropagation();  // Prevent click from propagating
                this.toggleDrawingMode();
            });
        
        // Add elements to container in correct order
        this.playerHandContainer.add([handBackground]);  // Add background first
        this.playerHandContainer.add([trainSection, trainLabel, playerInfo, crayonButton]);  // Then add UI elements
    }

    private toggleDrawingMode(): void {
        this.isDrawingMode = !this.isDrawingMode;
        if (this.isDrawingMode) {
            this.initializeDrawingMode();
        } else {
            this.cleanupDrawingMode();
        }
    }

    private initializeDrawingMode(): void {
        if (!this.drawingGraphics) {
            this.drawingGraphics = this.add.graphics();
            this.drawingGraphics.setDepth(1);
        }

        // Clear any existing graphics
        this.drawingGraphics.clear();
        this.currentSegments = [];
        this.lastClickedPoint = null;
        this.turnBuildCost = 0;

        // Set up input handlers for drawing mode
        this.input.on('pointerdown', this.handleDrawingClick, this);
        this.input.on('pointermove', this.handleDrawingHover, this);
    }

    private cleanupDrawingMode(): void {
        this.input.off('pointerdown', this.handleDrawingClick, this);
        this.input.off('pointermove', this.handleDrawingHover, this);
        if (this.drawingGraphics) {
            this.drawingGraphics.clear();
        }
        this.currentSegments = [];
        this.lastClickedPoint = null;
        this.turnBuildCost = 0;
    }

    private handleDrawingClick(pointer: Phaser.Input.Pointer): void {
        if (!this.isDrawingMode) return;

        // Check if click is in the UI area (bottom 200px of screen)
        if (pointer.y > this.scale.height - 200) {
            return;  // Ignore clicks in the UI area
        }

        const clickedPoint = this.getGridPointAtPosition(pointer.x, pointer.y);
        if (!clickedPoint) return;

        // Only log on actual clicks in drawing mode
        if (pointer.leftButtonDown()) {
            // Get world coordinates
            const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
            
            console.debug('Drawing mode click:', {
                screen: { x: pointer.x, y: pointer.y },
                world: { x: worldPoint.x, y: worldPoint.y },
                grid: { row: clickedPoint.row, col: clickedPoint.col },
                point: clickedPoint,
                city: clickedPoint.city,
                isMajorCity: clickedPoint.city?.type === TerrainType.MajorCity
            });
        }

        if (!this.lastClickedPoint) {
            this.lastClickedPoint = clickedPoint;
            this.highlightValidPoints(clickedPoint);
        } else {
            const validationResult = this.validateTrackPlacement(this.lastClickedPoint, clickedPoint);
            if (validationResult.isValid && validationResult.cost !== undefined) {
                const segment: TrackSegment = {
                    from: {
                        x: this.lastClickedPoint.x,
                        y: this.lastClickedPoint.y,
                        row: this.lastClickedPoint.row,
                        col: this.lastClickedPoint.col,
                        terrain: this.lastClickedPoint.terrain
                    },
                    to: {
                        x: clickedPoint.x,
                        y: clickedPoint.y,
                        row: clickedPoint.row,
                        col: clickedPoint.col,
                        terrain: clickedPoint.terrain
                    },
                    cost: validationResult.cost
                };
                this.currentSegments.push(segment);
                this.turnBuildCost += validationResult.cost;
                this.drawTrackSegment(segment);
                this.lastClickedPoint = clickedPoint;
                this.highlightValidPoints(clickedPoint);
            } else {
                this.showInvalidPlacementFeedback(validationResult.error || TrackBuildError.UNKNOWN_ERROR);
            }
        }
    }

    private handleDrawingHover(pointer: Phaser.Input.Pointer): void {
        if (!this.isDrawingMode || !this.lastClickedPoint) return;

        const hoverPoint = this.getGridPointAtPosition(pointer.x, pointer.y);
        if (!hoverPoint) return;

        // Clear previous preview
        this.drawingGraphics.clear();

        // Redraw existing segments
        this.currentSegments.forEach(segment => this.drawTrackSegment(segment));

        // Only show preview line if hovering over an adjacent point
        if (this.isAdjacent(this.lastClickedPoint, hoverPoint)) {
            // Draw preview line
            const validationResult = this.validateTrackPlacement(this.lastClickedPoint!, hoverPoint);
            const color = validationResult.isValid ? 0x00ff00 : 0xff0000;
            const alpha = 0.5;

            this.drawingGraphics.lineStyle(2, color, alpha);
            this.drawingGraphics.beginPath();
            this.drawingGraphics.moveTo(this.lastClickedPoint!.x, this.lastClickedPoint!.y);
            this.drawingGraphics.lineTo(hoverPoint.x, hoverPoint.y);
            this.drawingGraphics.strokePath();
        }
    }

    private drawTrackSegment(segment: TrackSegment): void {
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const color = parseInt(currentPlayer.color.replace('#', '0x'));

        this.drawingGraphics.lineStyle(3, color, 1);
        this.drawingGraphics.beginPath();
        this.drawingGraphics.moveTo(segment.from.x, segment.from.y);
        this.drawingGraphics.lineTo(segment.to.x, segment.to.y);
        this.drawingGraphics.strokePath();

        // Add debug info for the drawn segment
        console.debug('Drawing track segment:', {
            from: { 
                screen: { x: segment.from.x, y: segment.from.y },
                grid: { row: segment.from.row, col: segment.from.col }
            },
            to: { 
                screen: { x: segment.to.x, y: segment.to.y },
                grid: { row: segment.to.row, col: segment.to.col }
            },
            color: currentPlayer.color
        });
    }

    private highlightValidPoints(fromPoint: GridPoint): void {
        // Clear previous highlights
        this.drawingGraphics.clear();

        // Redraw existing segments
        this.currentSegments.forEach(segment => this.drawTrackSegment(segment));

        // Only highlight adjacent points that are valid connections
        this.gridPoints.flat().forEach(point => {
            if (this.isAdjacent(fromPoint, point)) {
                const validationResult = this.validateTrackPlacement(fromPoint, point);
                if (validationResult.isValid) {
                    this.drawingGraphics.fillStyle(0x00ff00, 0.3);
                    this.drawingGraphics.fillCircle(
                        point.x,
                        point.y,
                        5
                    );
                }
            }
        });
    }

    private showInvalidPlacementFeedback(error: TrackBuildError): void {
        // TODO: Show visual feedback for invalid placement
    }

    private getGridPointAtPosition(screenX: number, screenY: number): GridPoint | null {
        // Convert screen coordinates to world coordinates
        const worldPoint = this.cameras.main.getWorldPoint(screenX, screenY);
        
        // Adjust for grid margin
        const x = worldPoint.x - this.GRID_MARGIN;
        const y = worldPoint.y - this.GRID_MARGIN;
        
        // Convert to grid coordinates
        const row = Math.floor(y / this.VERTICAL_SPACING);
        const col = Math.floor(x / this.HORIZONTAL_SPACING - (row % 2 === 1 ? 0.5 : 0));

        // Check if the point is within bounds
        if (col >= 0 && col < this.GRID_WIDTH &&
            row >= 0 && row < this.GRID_HEIGHT) {
            return this.gridPoints[row][col];
        }
        
        return null;
    }

    private async nextPlayerTurn() {
        // Move to the next player
        this.gameState.currentPlayerIndex = (this.gameState.currentPlayerIndex + 1) % this.gameState.players.length;
        
        try {
            // Update the current player in the database
            const response = await fetch('/api/players/updateCurrentPlayer', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    gameId: this.gameState.id,
                    currentPlayerIndex: this.gameState.currentPlayerIndex
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Failed to update current player:', errorData);
                // Continue with UI update even if save fails
            }
        } catch (error) {
            console.error('Error updating current player:', error);
            // Continue with UI update even if save fails
        }
        
        // Update the UI
        this.uiContainer.removeAll(true);
        this.playerHandContainer.removeAll(true);
        this.setupUIOverlay();
        this.setupPlayerHand();
    }

    private calculateTrackCost(from: GridPoint, to: GridPoint): number {
        // Base cost is the cost of the destination terrain
        let cost = this.TERRAIN_COSTS[to.terrain];

        // Add river/water crossing costs if applicable
        // TODO: Implement water crossing detection and costs

        return cost;
    }

    private isAdjacent(point1: GridPoint, point2: GridPoint): boolean {
        // Same row - must be adjacent columns
        if (point1.row === point2.row) {
            return Math.abs(point1.col - point2.col) === 1;
        }

        // Must be adjacent rows
        if (Math.abs(point1.row - point2.row) !== 1) {
            return false;
        }

        // In odd rows, can connect to same column or one to the left
        // In even rows, can connect to same column or one to the right
        return point1.row % 2 === 1 ? 
            point2.col === point1.col || point2.col === point1.col - 1 :
            point2.col === point1.col || point2.col === point1.col + 1;
    }

    private validateTrackPlacement(from: GridPoint, to: GridPoint): TrackBuildResult {
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const playerTrack = this.playerTracks.get(currentPlayer.id) || {
            playerId: currentPlayer.id,
            gameId: this.gameState.id,
            segments: [],
            totalCost: 0,
            turnBuildCost: 0,
            lastBuildTimestamp: new Date(),
            networkState: {
                nodes: [],
                edges: []
            }
        };
        const cost = this.calculateTrackCost(from, to);

        // Check if points are adjacent
        if (!this.isAdjacent(from, to)) {
            return { isValid: false, error: TrackBuildError.NOT_ADJACENT };
        }

        // Check if this would exceed the turn budget
        if (this.turnBuildCost + cost > this.MAX_TURN_BUILD_COST) {
            return { isValid: false, error: TrackBuildError.EXCEEDS_TURN_BUDGET };
        }

        // If this is the first track segment ever for this player
        if (this.currentSegments.length === 0) {
            // First track must start from a major city
            const isMajorCity = from.city?.type === TerrainType.MajorCity;
            if (!isMajorCity) {
                return { isValid: false, error: TrackBuildError.NOT_MAJOR_CITY };
            }
        } else {
            // Check if the new segment connects to the last placed segment
            const lastSegment = this.currentSegments[this.currentSegments.length - 1];
            const isConnected = 
                (lastSegment.to.x === from.x && lastSegment.to.y === from.y);
            
            if (!isConnected) {
                return { isValid: false, error: TrackBuildError.NOT_CONNECTED_TO_NETWORK };
            }
        }

        // Check if track already exists at this location
        const trackExists = Array.from(this.playerTracks.values()).some(track =>
            track.segments.some(segment =>
                (segment.from.x === from.x && segment.from.y === from.y &&
                 segment.to.x === to.x && segment.to.y === to.y) ||
                (segment.from.x === to.x && segment.from.y === to.y &&
                 segment.to.x === from.x && segment.to.y === from.y)
            )
        );

        if (trackExists) {
            return { isValid: false, error: TrackBuildError.TRACK_EXISTS };
        }

        return { isValid: true, cost };
    }

    private setupCamera(): void {
        const { width, height } = this.calculateMapDimensions();
        
        // Set up main camera with extended bounds to allow for proper scrolling
        this.cameras.main.setBounds(-this.GRID_MARGIN, -this.GRID_MARGIN, 
            width + (this.GRID_MARGIN * 2), height + (this.GRID_MARGIN * 2));
        
        // Center the camera on the map
        this.cameras.main.centerOn(width / 2, height / 2);
        
        // Set initial zoom to fit the board better, accounting for the player hand area
        const initialZoom = Math.min(
            (this.scale.width - 100) / width,
            (this.scale.height - 300) / height  // Leave space for player hand
        );
        this.cameras.main.setZoom(initialZoom);
        
        let lastPointerPosition = { x: 0, y: 0 };
        let isMouseDown = false;

        this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
            // Don't initiate drag if in drawing mode
            if (this.isDrawingMode) return;
            
            isMouseDown = true;
            this.isDragging = false;
            lastPointerPosition = { x: pointer.x, y: pointer.y };
            this.lastDragTime = Date.now();
        });

        this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
            // Don't handle drag if in drawing mode or mouse button isn't down
            if (this.isDrawingMode || !isMouseDown) return;
            
            const now = Date.now();
            const deltaX = pointer.x - lastPointerPosition.x;
            const deltaY = pointer.y - lastPointerPosition.y;
            
            // Only start dragging if we've moved a significant amount
            if (!this.isDragging && (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5)) {
                this.isDragging = true;
            }
            
            // If we're dragging, handle the camera movement
            if (this.isDragging && now - this.lastDragTime >= 32) {
                const newScrollX = this.cameras.main.scrollX - (deltaX / this.cameras.main.zoom);
                const newScrollY = this.cameras.main.scrollY - (deltaY / this.cameras.main.zoom);
                
                const maxScrollY = height - ((this.cameras.main.height - 200) / this.cameras.main.zoom);
                
                this.cameras.main.scrollX = newScrollX;
                this.cameras.main.scrollY = Math.min(maxScrollY, Math.max(0, newScrollY));
                
                lastPointerPosition = { x: pointer.x, y: pointer.y };
                this.lastDragTime = now;
                this.requestRender();
            }
        });

        this.input.on('pointerup', () => {
            isMouseDown = false;
            this.isDragging = false;
            this.requestRender();
        });

        // Handle edge case where mouse up happens outside the window
        this.game.events.on('blur', () => {
            isMouseDown = false;
            this.isDragging = false;
        });

        // Add zoom controls with adjusted limits and throttling
        let lastWheelTime = 0;
        this.input.on('wheel', (pointer: Phaser.Input.Pointer, gameObjects: any, deltaX: number, deltaY: number) => {
            const now = Date.now();
            // Throttle zoom updates to every 32ms
            if (now - lastWheelTime >= 32) {
                const zoom = this.cameras.main.zoom;
                const minZoom = Math.min(
                    (this.cameras.main.width - 100) / width,
                    (this.cameras.main.height - 300) / height
                ) * 0.8;
                const maxZoom = 2.0;
                
                if (deltaY > 0) {
                    this.cameras.main.zoom = Math.max(minZoom, zoom - 0.1);
                } else {
                    this.cameras.main.zoom = Math.min(maxZoom, zoom + 0.1);
                }
                
                const maxScrollY = height - ((this.cameras.main.height - 200) / this.cameras.main.zoom);
                this.cameras.main.scrollY = Math.min(maxScrollY, this.cameras.main.scrollY);
                
                lastWheelTime = now;
                this.requestRender();
            }
        });
    }

    update(time: number, delta: number): void {
        // Only update if we're dragging or have a pending render
        if (!this.isDragging && !this.pendingRender) {
            return;
        }
    }
} 