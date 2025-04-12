import 'phaser';
import { mapConfig } from '../config/mapConfig';
import { TerrainType, GridPoint, CityData } from '../../shared/types/GameTypes';
import { GameState } from '../../shared/types/GameTypes';
import { TrackDrawingManager } from '../components/TrackDrawingManager';


export class MapRenderer {
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
        [TerrainType.MediumCity]: 0x9999ff, // Brighter blue for cities
        [TerrainType.SmallCity]: 0x99ff99   // Brighter green for small cities
    };

    private readonly CITY_RADIUS = {
        [TerrainType.MajorCity]: 30,   // Size for major city hexagon
        [TerrainType.MediumCity]: 12,  // Reduced size for city circle
        [TerrainType.SmallCity]: 8     // Reduced size for small city square
    };

    private scene: Phaser.Scene;
    private mapContainer: Phaser.GameObjects.Container;
    public gridPoints: GridPoint[][] = [];
    private gameState: GameState;
    private trackDrawingManager: TrackDrawingManager;
    private backgroundGraphics: Phaser.GameObjects.Graphics;

    constructor(
        scene: Phaser.Scene,
        mapContainer: Phaser.GameObjects.Container,
        gameState: GameState,
        trackDrawingManager: TrackDrawingManager
    ) {
        this.scene = scene;
        this.mapContainer = mapContainer;
        this.gameState = gameState;
        this.trackDrawingManager = trackDrawingManager;
        
        // Initialize background graphics with lowest depth
        this.backgroundGraphics = this.scene.add.graphics();
        this.backgroundGraphics.setDepth(-1);
        this.mapContainer.add(this.backgroundGraphics);
    }

    public calculateMapDimensions() {
        const width = (this.GRID_WIDTH * this.HORIZONTAL_SPACING) + (this.GRID_MARGIN * 2);
        const height = (this.GRID_HEIGHT * this.VERTICAL_SPACING) + (this.GRID_MARGIN * 2);
        return { width, height };
    }

    private drawBackgroundTerrain(): void {
        // Clear any existing background
        this.backgroundGraphics.clear();
        
        // Draw the lake with a natural, irregular shape
        this.backgroundGraphics.lineStyle(2, 0x4444ff, 0.3); // Light blue border
        this.backgroundGraphics.fillStyle(0x1cb2f5, 0.2);    // Lighter blue fill with transparency
        
        // Create a natural-looking lake shape using curves
        const lakeCenter = {
            x: (39 * this.HORIZONTAL_SPACING) + this.GRID_MARGIN,
            y: (32 * this.VERTICAL_SPACING) + this.GRID_MARGIN
        };
        
        // Draw a series of curves to create an irregular shape
        this.backgroundGraphics.beginPath();
        
        // Create points for the lake shape
        const points = [
            { x: lakeCenter.x - 100, y: lakeCenter.y - 50 },  // Start
            { x: lakeCenter.x - 50, y: lakeCenter.y - 120 },  // Top control
            { x: lakeCenter.x + 50, y: lakeCenter.y - 120 },  // Top control
            { x: lakeCenter.x + 100, y: lakeCenter.y - 50 },  // Top right
            { x: lakeCenter.x + 150, y: lakeCenter.y },       // Right control
            { x: lakeCenter.x + 120, y: lakeCenter.y + 100 }, // Right control
            { x: lakeCenter.x + 50, y: lakeCenter.y + 120 },  // Bottom right
            { x: lakeCenter.x, y: lakeCenter.y + 150 },       // Bottom control
            { x: lakeCenter.x - 100, y: lakeCenter.y + 100 }, // Bottom control
            { x: lakeCenter.x - 120, y: lakeCenter.y + 50 },  // Bottom left
            { x: lakeCenter.x - 150, y: lakeCenter.y },       // Left control
            { x: lakeCenter.x - 150, y: lakeCenter.y - 50 },  // Left control
            { x: lakeCenter.x - 100, y: lakeCenter.y - 50 }   // Back to start
        ];

        // Draw the lake shape
        this.backgroundGraphics.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            this.backgroundGraphics.lineTo(points[i].x, points[i].y);
        }
        
        this.backgroundGraphics.closePath();
        this.backgroundGraphics.fill();
        this.backgroundGraphics.stroke();
        
        // Add some detail to the lake
        // Inner curves for depth perception
        this.backgroundGraphics.lineStyle(1, 0x4444ff, 0.1);
        
        // Draw inner shapes for depth
        const innerPoints = [
            { x: lakeCenter.x - 60, y: lakeCenter.y - 30 },
            { x: lakeCenter.x + 60, y: lakeCenter.y - 30 },
            { x: lakeCenter.x + 60, y: lakeCenter.y + 30 },
            { x: lakeCenter.x - 60, y: lakeCenter.y + 30 }
        ];
        
        this.backgroundGraphics.beginPath();
        this.backgroundGraphics.moveTo(innerPoints[0].x, innerPoints[0].y);
        for (let i = 1; i < innerPoints.length; i++) {
            this.backgroundGraphics.lineTo(innerPoints[i].x, innerPoints[i].y);
        }
        this.backgroundGraphics.closePath();
        this.backgroundGraphics.stroke();
        
        // Add some subtle ripple effects using small shapes
        for (let i = 0; i < 5; i++) {
            const rippleX = lakeCenter.x + Math.random() * 40 - 20;
            const rippleY = lakeCenter.y + Math.random() * 40 - 20;
            const rippleWidth = 20 + Math.random() * 30;
            const rippleHeight = 10 + Math.random() * 20;
            
            this.backgroundGraphics.lineStyle(1, 0x4444ff, 0.05);
            this.backgroundGraphics.beginPath();
            
            // Draw oval ripples using line segments
            for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 16) {
                const x = rippleX + Math.cos(angle) * rippleWidth;
                const y = rippleY + Math.sin(angle) * rippleHeight;
                if (angle === 0) {
                    this.backgroundGraphics.moveTo(x, y);
                } else {
                    this.backgroundGraphics.lineTo(x, y);
                }
            }
            
            this.backgroundGraphics.closePath();
            this.backgroundGraphics.stroke();
        }
    }

    public createTriangularGrid(): void {
        // Draw background terrain first
        this.drawBackgroundTerrain();
        
        // Create lookup maps
        const terrainLookup = new Map<string, { 
            terrain: TerrainType, 
            ferryConnection?: { row: number; col: number },
            city?: { type: TerrainType; name: string; connectedPoints?: Array<{ row: number; col: number }>, availableLoads?: string[] }
        }>();
        
        // Create a map to store connected city points
        const cityAreaPoints = new Map<string, { 
            city: CityData,  // Use CityData type which includes connectedPoints
            terrain: TerrainType 
        }>();
        
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
        const cityAreas = this.scene.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });
        const landPoints = this.scene.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });
        const mountainPoints = this.scene.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });
        const hillPoints = this.scene.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });
        const ferryConnections = this.scene.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });
        ferryConnections.setDepth(0);  // Set ferry line depth lower than circle

        // Set styles
        landPoints.lineStyle(1, 0x000000);
        landPoints.fillStyle(this.terrainColors[TerrainType.Clear]);
        mountainPoints.lineStyle(1, 0x000000);
        hillPoints.lineStyle(1, 0x000000);
        hillPoints.fillStyle(this.terrainColors[TerrainType.Mountain]);
        ferryConnections.lineStyle(6, 0x808080, 0.8); // Increased thickness to 6, using gray color, 0.8 opacity

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
                            const cityName = this.scene.add.text(
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
                        const cityName = this.scene.add.text(
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
                        const cityName = this.scene.add.text(
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
                let terrain = config?.terrain || TerrainType.Clear;
                const ferryConnection = config?.ferryConnection;
                const city = cityAreaConfig?.city || config?.city;
                
                // If this point has a city, use the city's type as the terrain type for cost calculations
                if (city) {
                    terrain = city.type;
                }

                // Add coordinate label for each point
                // const coordLabel = this.scene.add.text(
                //     x + this.GRID_MARGIN + 5,  // Offset slightly to the right
                //     y + this.GRID_MARGIN - 10, // Offset slightly above
                //     `${row},${col}`,
                //     { 
                //         color: '#000000',
                //         fontSize: '8px',
                //         backgroundColor: '#ffffff80' // Semi-transparent white background
                //     }
                // );
                // coordLabel.setOrigin(0, 1);
                // this.mapContainer.add(coordLabel);

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
                        sprite = this.scene.add.image(x + this.GRID_MARGIN, y + this.GRID_MARGIN, 'ferry-port');
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
                    city: city ? {
                        type: city.type,
                        name: city.name,
                        connectedPoints: city.connectedPoints || [],
                        availableLoads: city.availableLoads || []
                    } : undefined
                };
            }
        }

        // Draw ferry connections
        mapConfig.points.forEach(point => {
            if (point.ferryConnection) {
                const isFromOffsetRow = point.row % 2 === 1;
                const isToOffsetRow = point.ferryConnection.row % 2 === 1;
                
                const fromX = point.col * this.HORIZONTAL_SPACING + 
                    (isFromOffsetRow ? this.HORIZONTAL_SPACING / 2 : 0);
                const fromY = point.row * this.VERTICAL_SPACING;
                
                const toX = point.ferryConnection.col * this.HORIZONTAL_SPACING + 
                    (isToOffsetRow ? this.HORIZONTAL_SPACING / 2 : 0);
                const toY = point.ferryConnection.row * this.VERTICAL_SPACING;
                
                // Draw the ferry connection line
                ferryConnections.beginPath();
                ferryConnections.moveTo(fromX, fromY);
                ferryConnections.lineTo(toX, toY);
                ferryConnections.stroke();

                // Calculate midpoint for the cost circle
                const midX = (fromX + toX) / 2;
                const midY = (fromY + toY) / 2;

                // Draw the circled cost (5 ECU)
                this.drawCircledNumber(ferryConnections, midX, midY, 5);
            }
        });

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

    private drawCircledNumber(graphics: Phaser.GameObjects.Graphics, x: number, y: number, number: number): void {
        const CIRCLE_RADIUS = 12;
        
        // Create a new graphics object for the circle and text with higher depth
        const circleGraphics = this.scene.add.graphics({ x: this.GRID_MARGIN, y: this.GRID_MARGIN });
        circleGraphics.setDepth(1);  // Set higher depth to appear above ferry line
        
        // Draw white circle background
        circleGraphics.lineStyle(2, 0x000000, 1);  // Black border
        circleGraphics.fillStyle(0xFFFFFF, 1);     // White fill
        circleGraphics.beginPath();
        circleGraphics.arc(x, y, CIRCLE_RADIUS, 0, Math.PI * 2);
        circleGraphics.closePath();
        circleGraphics.fill();
        circleGraphics.stroke();

        // Add the number with even higher depth
        const text = this.scene.add.text(
            x + this.GRID_MARGIN,
            y + this.GRID_MARGIN,
            number.toString(),
            {
                color: '#000000',
                fontSize: '14px',
                fontStyle: 'bold'
            }
        );
        text.setDepth(2);  // Set even higher depth to ensure text appears above circle
        text.setOrigin(0.5, 0.5);
        
        // Add both to the container
        this.mapContainer.add([circleGraphics, text]);
    }

    public getGridPointAtPosition(screenX: number, screenY: number, camera: Phaser.Cameras.Scene2D.Camera): GridPoint | null {
        // Convert screen coordinates to world coordinates
        const worldPoint = camera.getWorldPoint(screenX, screenY);
        
        // Define maximum distance for point selection
        const MAX_DISTANCE = 15; // pixels
        
        let closestPoint: GridPoint | null = null;
        let minDistance = MAX_DISTANCE;

        // Check all points in a 3x3 grid area around the cursor
        const approxRow = Math.floor((worldPoint.y - this.GRID_MARGIN) / this.VERTICAL_SPACING);
        const approxCol = Math.floor((worldPoint.x - this.GRID_MARGIN) / this.HORIZONTAL_SPACING);

        // Search in a 3x3 area around the approximate position
        for (let r = Math.max(0, approxRow - 1); r <= Math.min(this.GRID_HEIGHT - 1, approxRow + 1); r++) {
            for (let c = Math.max(0, approxCol - 1); c <= Math.min(this.GRID_WIDTH - 1, approxCol + 1); c++) {
                if (!this.gridPoints[r] || !this.gridPoints[r][c]) continue;
                
                const point = this.gridPoints[r][c];
                if (!point) continue;

                // Skip water points
                if (point.terrain === TerrainType.Water) continue;

                // Calculate distance to this point
                const dx = point.x - worldPoint.x;
                const dy = point.y - worldPoint.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                // Update closest point if this is closer
                if (distance < minDistance) {
                    minDistance = distance;
                    closestPoint = point;
                }
            }
        }

        return closestPoint;
    }

    public isAdjacent(point1: GridPoint, point2: GridPoint): boolean {
        // Prevent null/undefined points
        if (!point1 || !point2) return false;

        // Same row adjacency - must be consecutive columns
        if (point1.row === point2.row) {
            return Math.abs(point1.col - point2.col) === 1;
        }

        // One row difference only
        const rowDiff = Math.abs(point1.row - point2.row);
        if (rowDiff !== 1) return false;

        // For points in adjacent rows, the column relationship depends on which row is odd/even
        const isPoint1OddRow = point1.row % 2 === 1;
        const colDiff = point2.col - point1.col;  // Use directed difference

        // If point1 is in an odd row
        if (isPoint1OddRow) {
            // Can connect to same column or one column to the right in adjacent rows
            return colDiff === 0 || colDiff === 1;
        } else {
            // If point1 is in an even row
            // Can connect to same column or one column to the left in adjacent rows
            return colDiff === 0 || colDiff === -1;
        }
    }

    public playerHasTrack(playerId: string): boolean {
        // Get player's track state from TrackDrawingManager
        const playerTrackState = this.trackDrawingManager.getPlayerTrackState(playerId);
        if (!playerTrackState || !playerTrackState.segments) {
            return false;
        }
        return playerTrackState.segments.length > 0;
    }

    // Also let's add a method to help debug track data
    public debugTrackData(): void {
        console.log('=== Track Data Debug ===');
        this.gridPoints.forEach((row, rowIndex) => {
            row.forEach((point, colIndex) => {
                if (point?.tracks && point.tracks.length > 0) {
                    console.log(`Track at [${rowIndex},${colIndex}]:`, {
                        point,
                        tracks: point.tracks,
                        numTracks: point.tracks.length
                    });
                }
            });
        });
        console.log('=== End Track Data Debug ===');
    }

    public findNearestMilepostOnOwnTrack(x: number, y: number, playerId: string): GridPoint | null {
        // First, get the clicked point using TrackDrawingManager's method
        const clickedPoint = this.trackDrawingManager.getGridPointAtPosition(x, y);
        
        if (!clickedPoint) {
            console.log('No valid grid point found at click position');
            return null;
        }

        // Get the player's track state
        const playerTrackState = this.trackDrawingManager.getPlayerTrackState(playerId);
        if (!playerTrackState || !playerTrackState.segments) {
            console.log('No track state found for player');
            return null;
        }

        // Check if the clicked point is part of any of the player's track segments
        const isOnPlayerTrack = playerTrackState.segments.some(segment => 
            // Check both ends of each segment
            (segment.from.row === clickedPoint.row && segment.from.col === clickedPoint.col) ||
            (segment.to.row === clickedPoint.row && segment.to.col === clickedPoint.col)
        );

        if (isOnPlayerTrack) {
            console.log('Found player track at clicked point');
            return clickedPoint;
        }

        // If not, find the nearest point that is part of a player's track segment
        let nearestPoint: GridPoint | null = null;
        let minDistance = Infinity;

        // Create a set of all points that are part of the player's track network
        const trackPoints = new Set<string>();
        playerTrackState.segments.forEach(segment => {
            trackPoints.add(`${segment.from.row},${segment.from.col}`);
            trackPoints.add(`${segment.to.row},${segment.to.col}`);
        });

        // Search through adjacent points first (within a reasonable radius)
        const searchRadius = 3; // Adjust this value as needed
        const rowStart = Math.max(0, clickedPoint.row - searchRadius);
        const rowEnd = Math.min(this.gridPoints.length - 1, clickedPoint.row + searchRadius);
        
        for (let row = rowStart; row <= rowEnd; row++) {
            if (!this.gridPoints[row]) continue;
            
            const colStart = Math.max(0, clickedPoint.col - searchRadius);
            const colEnd = Math.min(this.gridPoints[row].length - 1, clickedPoint.col + searchRadius);
            
            for (let col = colStart; col <= colEnd; col++) {
                const point = this.gridPoints[row][col];
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
            console.log('Found nearest point with player track:', nearestPoint);
            return nearestPoint;
        }

        console.log('No valid track point found within search radius');
        return null;
    }
}