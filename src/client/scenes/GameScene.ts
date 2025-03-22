import 'phaser';
import { mapConfig } from '../config/mapConfig';
import { TerrainType, GridPointConfig, CityType } from '../../shared/types/GridTypes';
import { GameState } from '../../shared/types/GameTypes';

interface GridPoint {
    x: number;
    y: number;
    sprite?: Phaser.GameObjects.Graphics | Phaser.GameObjects.Image;
    terrain: TerrainType;
    ferryConnection?: { row: number; col: number };
    city?: {
        type: CityType;
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
    private gameState: GameState;
    
    // Grid configuration
    private readonly GRID_WIDTH = 70;
    private readonly GRID_HEIGHT = 90;
    private readonly HORIZONTAL_SPACING = 35;
    private readonly VERTICAL_SPACING = 35;
    private readonly POINT_RADIUS = 3;
    private readonly GRID_MARGIN = 100;        // Increased margin around the grid
    private readonly FERRY_ICON_SIZE = 12; // Size for the ferry icon
    private readonly terrainColors = {
        [TerrainType.LAND]: 0x000000,
        [TerrainType.WATER]: 0x0000ff,
        [TerrainType.HILL]: 0x964B00,
        [TerrainType.MOUNTAIN]: 0x808080,
        [TerrainType.FERRY_PORT]: 0xffa500
    };

    private readonly CITY_COLORS = {
        [CityType.MAJOR_CITY]: 0xff9999,  // Brighter red for major cities
        [CityType.CITY]: 0x9999ff,        // Brighter blue for cities
        [CityType.SMALL_CITY]: 0x99ff99   // Brighter green for small cities
    };

    private readonly CITY_RADIUS = {
        [CityType.MAJOR_CITY]: 30,   // Size for major city hexagon
        [CityType.CITY]: 12,         // Reduced size for city circle
        [CityType.SMALL_CITY]: 8     // Reduced size for small city square
    };

    constructor() {
        super({ key: 'GameScene' });
        // Initialize with default state
        this.gameState = {
            players: [],
            currentPlayerIndex: 0,
            gamePhase: 'setup',
            maxPlayers: 6
        };
    }

    init(data: { gameState?: GameState }) {
        // Update gameState if provided
        if (data.gameState) {
            this.gameState = data.gameState;
        }
        
        // If no players, return to setup
        if (this.gameState.players.length === 0) {
            this.scene.start('SetupScene');
            return;
        }
    }

    preload() {
        this.load.image('ferry-port', '/assets/ferry-port.png');
    }

    create() {
        // Create containers in the right order
        this.mapContainer = this.add.container(0, 0);
        
        // Setup scene elements
        this.setupCamera();
        this.createTriangularGrid();

        // Create UI containers last to ensure they overlay
        this.uiContainer = this.add.container(0, 0);
        this.playerHandContainer = this.add.container(0, 0);  // Position will be set in setupPlayerHand
        
        // Create a separate camera for UI that won't move
        const uiCamera = this.cameras.add(0, 0, this.cameras.main.width, this.cameras.main.height);
        uiCamera.setScroll(0, 0);
        uiCamera.ignore(this.mapContainer);  // UI camera ignores the map
        
        // Main camera ignores UI elements
        this.cameras.main.ignore([this.uiContainer, this.playerHandContainer]);

        this.setupUIOverlay();
        this.setupPlayerHand();

        // Set a low frame rate for the scene
        this.game.loop.targetFps = 30;
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
            city?: { type: CityType; name: string; connectedPoints?: Array<{ row: number; col: number }> }
        }>();
        
        mapConfig.points.forEach(point => {
            terrainLookup.set(`${point.row},${point.col}`, {
                terrain: point.terrain,
                ferryConnection: point.ferryConnection,
                city: point.city
            });
        });

        // Create graphics objects for different elements
        const cityAreas = this.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });
        const landPoints = this.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });
        const mountainPoints = this.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });
        const hillPoints = this.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });
        const ferryConnections = this.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });

        // Set styles
        landPoints.lineStyle(1, 0x000000);
        landPoints.fillStyle(this.terrainColors[TerrainType.LAND]);
        mountainPoints.lineStyle(1, 0x000000);
        hillPoints.lineStyle(1, 0x000000);
        hillPoints.fillStyle(this.terrainColors[TerrainType.HILL]);
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

                    if (config.city.type === CityType.MAJOR_CITY && config.city.connectedPoints) {
                        // Only draw major city once
                        const cityKey = `${config.city.name}`;
                        if (!majorCities.has(cityKey)) {
                            majorCities.add(cityKey);
                            
                            // Draw hexagonal area
                            cityAreas.fillStyle(this.CITY_COLORS[CityType.MAJOR_CITY], 0.7);
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
                    } else if (config.city.type === CityType.CITY) {
                        // Draw circle for regular city
                        cityAreas.fillStyle(this.CITY_COLORS[CityType.CITY], 0.7);  // Increased opacity
                        cityAreas.lineStyle(2, 0x000000, 0.7);  // Darker border
                        cityAreas.beginPath();
                        cityAreas.arc(x, y, this.CITY_RADIUS[CityType.CITY], 0, Math.PI * 2);
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
                    } else if (config.city.type === CityType.SMALL_CITY) {
                        // Draw square for small city
                        cityAreas.fillStyle(this.CITY_COLORS[CityType.SMALL_CITY], 0.7);  // Increased opacity
                        cityAreas.lineStyle(2, 0x000000, 0.7);  // Darker border
                        const radius = this.CITY_RADIUS[CityType.SMALL_CITY];
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
                const terrain = config?.terrain || TerrainType.LAND;
                const ferryConnection = config?.ferryConnection;
                const city = config?.city;

                let sprite: Phaser.GameObjects.Graphics | Phaser.GameObjects.Image | undefined;

                // Skip drawing point for water terrain
                if (terrain !== TerrainType.WATER) {
                    if (terrain === TerrainType.MOUNTAIN || terrain === TerrainType.HILL) {
                        // Draw terrain features as before
                        const graphics = terrain === TerrainType.MOUNTAIN ? mountainPoints : hillPoints;
                        const triangleHeight = this.POINT_RADIUS * 2;
                        graphics.beginPath();
                        graphics.moveTo(x, y - triangleHeight);
                        graphics.lineTo(x - triangleHeight, y + triangleHeight);
                        graphics.lineTo(x + triangleHeight, y + triangleHeight);
                        graphics.closePath();
                        if (terrain === TerrainType.HILL) {
                            graphics.fill();
                        }
                        graphics.stroke();
                    } else if (terrain === TerrainType.FERRY_PORT) {
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

                // Store point data
                this.gridPoints[row][col] = { 
                    x: x + this.GRID_MARGIN, 
                    y: y + this.GRID_MARGIN, 
                    sprite, 
                    terrain,
                    ferryConnection,
                    city 
                };

                // Draw ferry connections
                if (ferryConnection) {
                    const targetX = ferryConnection.col * this.HORIZONTAL_SPACING + 
                        (ferryConnection.row % 2 === 1 ? this.HORIZONTAL_SPACING / 2 : 0);
                    const targetY = ferryConnection.row * this.VERTICAL_SPACING;
                    
                    ferryConnections.beginPath();
                    ferryConnections.moveTo(x, y);
                    ferryConnections.lineTo(targetX, targetY);
                    ferryConnections.closePath();
                    ferryConnections.stroke();
                }
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
        
        // Create semi-transparent background for leaderboard
        const leaderboardBg = this.add.rectangle(
            this.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
            LEADERBOARD_PADDING,  // Position at top
            LEADERBOARD_WIDTH,
            40 + (this.gameState.players.length * 20),  // Tighter spacing
            0x333333,
            0.9  // More opaque background
        ).setOrigin(0, 0);  // Align to top-right
        
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
        
        this.uiContainer.add([leaderboardBg, leaderboardTitle, ...playerEntries]);
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
                color: '#000000',
                fontSize: '20px',
                fontStyle: 'bold'
            }
        ).setOrigin(0, 0);
        
        this.playerHandContainer.add([handBackground, trainSection, trainLabel, playerInfo]);
    }

    private setupCamera() {
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

        this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
            this.isDragging = true;
            lastPointerPosition = { x: pointer.x, y: pointer.y };
            this.lastDragTime = Date.now();
        });

        this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
            if (this.isDragging) {
                const now = Date.now();
                // Throttle updates to every 32ms (approximately 30fps)
                if (now - this.lastDragTime >= 32) {
                    const deltaX = pointer.x - lastPointerPosition.x;
                    const deltaY = pointer.y - lastPointerPosition.y;
                    
                    // Calculate new scroll position
                    const newScrollX = this.cameras.main.scrollX - (deltaX / this.cameras.main.zoom);
                    const newScrollY = this.cameras.main.scrollY - (deltaY / this.cameras.main.zoom);
                    
                    // Ensure the bottom of the map doesn't scroll above the player hand area
                    const maxScrollY = height - ((this.cameras.main.height - 200) / this.cameras.main.zoom);
                    
                    this.cameras.main.scrollX = newScrollX;
                    this.cameras.main.scrollY = Math.min(maxScrollY, Math.max(0, newScrollY));
                    
                    lastPointerPosition = { x: pointer.x, y: pointer.y };
                    this.lastDragTime = now;
                    this.requestRender();
                }
            }
        });

        this.input.on('pointerup', () => {
            this.isDragging = false;
            this.requestRender();
        });

        // Add zoom controls with adjusted limits and throttling
        let lastWheelTime = 0;
        this.input.on('wheel', (pointer: Phaser.Input.Pointer, gameObjects: any, deltaX: number, deltaY: number) => {
            const now = Date.now();
            // Throttle zoom updates to every 32ms
            if (now - lastWheelTime >= 32) {
                const zoom = this.cameras.main.zoom;
                const minZoom = Math.min(
                    (this.cameras.main.width - 100) / width,  // Added padding for zoom
                    (this.cameras.main.height - 300) / height // Added more space for UI
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