import 'jest-canvas-mock';
import { TrackDrawingManager } from '../components/TrackDrawingManager';
import { MockScene } from './setupTests';
import { TerrainType, GameState, GridPoint } from '../../shared/types/GameTypes';
import { MapRenderer } from '../components/MapRenderer';

describe('TrackDrawingManager', () => {
    let scene: MockScene;
    let mapContainer: any;
    let gameState: GameState;
    let gridPoints: GridPoint[][];
    let trackDrawingManager: TrackDrawingManager;

    beforeEach(() => {
        // Set up our mocks
        scene = new MockScene();
        mapContainer = {
            add: jest.fn()
        };
        gameState = {
            id: 'test-game-id',
            players: [
                { 
                    id: 'player1', 
                    name: 'Player 1', 
                    color: '#FF0000', 
                    money: 50, 
                    trainType: 'basic',
                    turnNumber: 1,
                    trainState: {
                        position: {x: 0, y: 0, row: 0, col: 0},
                        movementHistory: [],
                        remainingMovement: 9,
                        loads: []
                    },
                    hand: []
                }   
            ],
            currentPlayerIndex: 0,
            status: 'active',
            maxPlayers: 6
        };
        
        // Create a simple 3x3 grid of points for testing
        gridPoints = [];
        for (let row = 0; row < 3; row++) {
            gridPoints[row] = [];
            for (let col = 0; col < 3; col++) {
                // Create a basic grid point with Clear terrain
                gridPoints[row][col] = {
                    id: `${row}-${col}`,
                    x: col * 35,
                    y: row * 35,
                    row,
                    col,
                    terrain: TerrainType.Clear
                };
            }
        }

        // Create the TrackDrawingManager instance with our test grid
        const mockGraphics = {
            setDepth: jest.fn(),
            lineStyle: jest.fn(),
            beginPath: jest.fn(),
            moveTo: jest.fn(),
            lineTo: jest.fn(),
            strokePath: jest.fn(),
            clear: jest.fn()
        };

        const mockScene = {
            add: {
                graphics: () => mockGraphics
            }
        } as unknown as Phaser.Scene;

        const mockContainer = {
            add: jest.fn()
        } as unknown as Phaser.GameObjects.Container;

        const mockGameState = {
            players: [{ id: 'player1', color: '#FF0000' }],
            currentPlayerIndex: 0
        } as GameState;

        const manager = new TrackDrawingManager(mockScene, mockContainer, mockGameState, gridPoints);
        trackDrawingManager = manager;
    });

    describe('Track Cost Calculation', () => {
        let calculateTrackCost: (from: GridPoint, to: GridPoint) => number;
        let gridPoints: GridPoint[][];
        let majorCityPoint: GridPoint;
        let regularPoint: GridPoint;

        beforeEach(() => {
            // Create a simple grid of points for testing
            majorCityPoint = {
                id: '0-1',
                x: 35,
                y: 0,
                row: 0,
                col: 1,
                terrain: TerrainType.MajorCity,
                city: {
                    type: TerrainType.MajorCity,
                    name: 'Test Major City',
                    availableLoads: [],
                    connectedPoints: []
                }
            };

            regularPoint = {
                id: '0-2',
                x: 70,
                y: 0,
                row: 0,
                col: 2,
                terrain: TerrainType.Clear
            };

            // Create a 3x3 grid with the major city and its outpost
            gridPoints = Array(3).fill(null).map(() => Array(3).fill(null));
            gridPoints[0][1] = majorCityPoint; // Major city at (0,1)
            gridPoints[0][2] = regularPoint;   // Regular point at (0,2)

            // Create the TrackDrawingManager instance with our test grid
            const mockGraphics = {
                setDepth: jest.fn(),
                lineStyle: jest.fn(),
                beginPath: jest.fn(),
                moveTo: jest.fn(),
                lineTo: jest.fn(),
                strokePath: jest.fn(),
                clear: jest.fn()
            };

            const mockScene = {
                add: {
                    graphics: () => mockGraphics
                }
            } as unknown as Phaser.Scene;

            const mockContainer = {
                add: jest.fn()
            } as unknown as Phaser.GameObjects.Container;

            const mockGameState = {
                players: [{ id: 'player1', color: '#FF0000' }],
                currentPlayerIndex: 0
            } as GameState;

            const manager = new TrackDrawingManager(mockScene, mockContainer, mockGameState, gridPoints);
            calculateTrackCost = manager['calculateTrackCost'].bind(manager);
        });

        it('should calculate correct costs for different terrain types', () => {
            // Get access to the private calculateTrackCost method
            const calculateTrackCost = (trackDrawingManager as any).calculateTrackCost.bind(trackDrawingManager);

            // Create from point (always Clear terrain for testing)
            const fromPoint: GridPoint = {
                id: '0-0',
                x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear
            };

            // Test each terrain type
            const terrainTypes: Array<{terrain: TerrainType, name: string, expected: number}> = [
                { terrain: TerrainType.Clear, name: 'Clear', expected: 1 },
                { terrain: TerrainType.Mountain, name: 'Mountain', expected: 2 },
                { terrain: TerrainType.Alpine, name: 'Alpine', expected: 5 },
                { terrain: TerrainType.SmallCity, name: 'SmallCity', expected: 3 },
                { terrain: TerrainType.MediumCity, name: 'MediumCity', expected: 3 },
                { terrain: TerrainType.MajorCity, name: 'MajorCity', expected: 5 },
                { terrain: TerrainType.FerryPort, name: 'FerryPort', expected: 0 },
                { terrain: TerrainType.Water, name: 'Water', expected: 0 }
            ];

            for (const testCase of terrainTypes) {
                // Create a destination point with the specific terrain type
                const toPoint: GridPoint = {
                    id: '0-1',
                    x: 35, y: 35, row: 1, col: 1, terrain: testCase.terrain
                };

                // For city terrain types, add the city property
                if ([TerrainType.SmallCity, TerrainType.MediumCity, TerrainType.MajorCity].includes(testCase.terrain)) {
                    toPoint.city = {
                        type: testCase.terrain,
                        name: `Test ${testCase.name}`,
                        availableLoads: []  // Add empty array for test purposes
                    };
                }

                // Calculate cost
                const cost = calculateTrackCost(fromPoint, toPoint);
                
                // We should ignore the small fractional cost added for row changes
                const roundedCost = Math.floor(cost);
                
                // Verify the cost matches the expected value
                expect(roundedCost).toBe(testCase.expected);
            }
        });

        it('should add a small penalty cost for diagonal movement', () => {
            // Get access to the private calculateTrackCost method
            const calculateTrackCost = (trackDrawingManager as any).calculateTrackCost.bind(trackDrawingManager);

            // Create points for horizontal and diagonal movement
            const fromPoint: GridPoint = { id: '0-0', x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear };
            
            // Horizontal movement (same row)
            const horizontalPoint: GridPoint = { id: '0-1', x: 35, y: 0, row: 0, col: 1, terrain: TerrainType.Clear };
            
            // Diagonal movement (different row)
            const diagonalPoint: GridPoint = { id: '1-1', x: 35, y: 35, row: 1, col: 1, terrain: TerrainType.Clear };

            // Calculate costs
            const horizontalCost = calculateTrackCost(fromPoint, horizontalPoint);
            const diagonalCost = calculateTrackCost(fromPoint, diagonalPoint);

            // Diagonal cost should be slightly higher than horizontal cost for the same terrain
            expect(diagonalCost).toBeGreaterThan(horizontalCost);
            
            // The difference should be exactly 0.01
            expect(diagonalCost - horizontalCost).toBeCloseTo(0.01);
        });
        
        it('should correctly calculate costs when entering cities', () => {
            // Get access to the private calculateTrackCost method
            const calculateTrackCost = (trackDrawingManager as any).calculateTrackCost.bind(trackDrawingManager);

            // Create a source point (clear terrain)
            const fromPoint: GridPoint = { id: '0-0', x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear };
            
            // Test all city types
            const cityTypes = [
                { 
                    type: TerrainType.SmallCity, 
                    name: 'Small City', 
                    expected: 3 
                },
                { 
                    type: TerrainType.MediumCity, 
                    name: 'Medium City', 
                    expected: 3 
                },
                { 
                    type: TerrainType.MajorCity, 
                    name: 'Major City', 
                    expected: 5 
                }
            ];
            
            for (const cityType of cityTypes) {
                // Create a destination point with the city
                const toPoint: GridPoint = { 
                    id: '0-1',
                    x: 35, 
                    y: 0, 
                    row: 0, 
                    col: 1, 
                    terrain: cityType.type,
                    city: {
                        type: cityType.type,
                        name: cityType.name,
                        availableLoads: []  // Add empty array for test purposes
                    }
                };
                
                // Calculate cost to enter this city
                const cost = calculateTrackCost(fromPoint, toPoint);
                const roundedCost = Math.floor(cost);  // Ignore diagonal penalty
                
                // Verify correct city cost
                expect(roundedCost).toBe(cityType.expected);
            }
        });

        it('should apply major city connection cost correctly', () => {
            // Test 1: First connection to major city center (should cost exactly 5 ECU)
            const firstConnectionCost = calculateTrackCost(regularPoint, majorCityPoint);
            expect(Math.floor(firstConnectionCost)).toBe(5); // Exactly 5 ECU for first connection

            // Test 2: Connection from major city (should use destination terrain cost)
            const fromMajorCityCost = calculateTrackCost(majorCityPoint, regularPoint);
            expect(Math.floor(fromMajorCityCost)).toBe(1); // Clear terrain cost

            // Test 3: First connection to major city outpost (should also cost 5 ECU)
            const outpostPoint: GridPoint = {
                id: '1-1',
                x: 35,
                y: 35,
                row: 1,
                col: 1,
                terrain: TerrainType.Clear
            };
            // Add the outpost to the grid and to the major city's connected points
            gridPoints[1][1] = outpostPoint;
            majorCityPoint.city = {
                type: TerrainType.MajorCity,
                name: 'Test Major City',
                availableLoads: [],
                connectedPoints: [{
                    row: outpostPoint.row,
                    col: outpostPoint.col
                }]
            };
            const outpostConnectionCost = calculateTrackCost(regularPoint, outpostPoint);
            expect(Math.floor(outpostConnectionCost)).toBe(5); // Exactly 5 ECU for first connection to outpost

            // Test 4: Second connection to same major city (should still cost 5 ECU)
            // We need to simulate that this is a second connection by adding a track segment
            const playerTrackState = {
                playerId: 'player1',
                gameId: 'test-game-id',
                segments: [{
                    from: { row: 0, col: 2, x: 70, y: 0, terrain: TerrainType.Clear },
                    to: { row: 0, col: 1, x: 35, y: 0, terrain: TerrainType.MajorCity },
                    cost: 5
                }],
                totalCost: 5,
                turnBuildCost: 5,
                lastBuildTimestamp: new Date()
            };

            // Set the player's track state
            (trackDrawingManager as any).playerTracks.set('player1', playerTrackState);

            // Now test second connection to same major city
            const secondConnectionCost = calculateTrackCost(regularPoint, majorCityPoint);
            expect(Math.floor(secondConnectionCost)).toBe(5); // Major city terrain cost
        });
    });

    describe('getGridPointAtPosition', () => {
        it('should find the correct grid point based on world coordinates', () => {
            // Set static properties for MapRenderer using defineProperty to bypass read-only
            Object.defineProperty(MapRenderer, 'GRID_MARGIN', { value: 100, configurable: true });
            Object.defineProperty(MapRenderer, 'VERTICAL_SPACING', { value: 35, configurable: true });
            Object.defineProperty(MapRenderer, 'HORIZONTAL_SPACING', { value: 35, configurable: true });
            // Arrange: create a grid with known spacing and a target point at (row=39, col=21)
            const targetRow = 39;
            const targetCol = 21;
            const gridRows = 50;
            const gridCols = 30;
            const gridPoints: GridPoint[][] = [];
            for (let row = 0; row < gridRows; row++) {
                gridPoints[row] = [];
                for (let col = 0; col < gridCols; col++) {
                    const isOffsetRow = row % 2 === 1;
                    gridPoints[row][col] = {
                        id: `${row}-${col}`,
                        x: MapRenderer.GRID_MARGIN + col * MapRenderer.HORIZONTAL_SPACING + (isOffsetRow ? MapRenderer.HORIZONTAL_SPACING / 2 : 0),
                        y: MapRenderer.GRID_MARGIN + row * MapRenderer.VERTICAL_SPACING,
                        row,
                        col,
                        terrain: TerrainType.Clear
                    };
                }
            }
            // Create the manager
            const mockGraphics = {
                setDepth: jest.fn(),
                lineStyle: jest.fn(),
                beginPath: jest.fn(),
                moveTo: jest.fn(),
                lineTo: jest.fn(),
                strokePath: jest.fn(),
                clear: jest.fn()
            };
            const mockScene = {
                add: {
                    graphics: () => mockGraphics
                }
            } as unknown as Phaser.Scene;
            const mockContainer = { add: jest.fn() } as unknown as Phaser.GameObjects.Container;
            const mockGameState = {
                players: [{ id: 'player1', color: '#FF0000' }],
                currentPlayerIndex: 0
            } as GameState;
            const manager = new TrackDrawingManager(mockScene, mockContainer, mockGameState, gridPoints);
            // Act: use the world coordinates that should map to (39,21)
            const isTargetOffsetRow = targetRow % 2 === 1;
            const worldX = MapRenderer.GRID_MARGIN + targetCol * MapRenderer.HORIZONTAL_SPACING + (isTargetOffsetRow ? MapRenderer.HORIZONTAL_SPACING / 2 : 0);
            const worldY = MapRenderer.GRID_MARGIN + targetRow * MapRenderer.VERTICAL_SPACING;
            // Log the grid point and world coordinates for debugging
            console.log('Grid point at (39,21):', gridPoints[targetRow][targetCol]);
            console.log('worldX:', worldX, 'worldY:', worldY);
            const foundPoint = manager.getGridPointAtPosition(worldX, worldY);
            // Assert
            expect(foundPoint).not.toBeNull();
            expect(foundPoint?.row).toBe(targetRow);
            expect(foundPoint?.col).toBe(targetCol);
        });

        it('should correctly find grid points on both even and odd rows', () => {
            // Arrange: create mock scene and container
            const mockScene = new MockScene();
            const mockContainer = { add: jest.fn() };
            
            // Create a mock grid
            const gridPoints: GridPoint[][] = [];
            for (let row = 0; row < 10; row++) {
                gridPoints[row] = [];
                for (let col = 0; col < 10; col++) {
                    const isOffsetRow = row % 2 === 1;
                    const x = MapRenderer.GRID_MARGIN + col * MapRenderer.HORIZONTAL_SPACING + (isOffsetRow ? MapRenderer.HORIZONTAL_SPACING / 2 : 0);
                    const y = MapRenderer.GRID_MARGIN + row * MapRenderer.VERTICAL_SPACING;
                    gridPoints[row][col] = {
                        row,
                        col,
                        x,
                        y,
                        terrain: TerrainType.Clear,
                        id: `${col}-${row}`
                    };
                }
            }
            
            const mockGameState = {
                players: [{ id: 'player1', color: '#FF0000' }],
                currentPlayerIndex: 0
            } as GameState;
            const manager = new TrackDrawingManager(mockScene, mockContainer, mockGameState, gridPoints);
            
            // Test several points on even rows (0, 2, 4)
            const evenRowTests = [
                { row: 0, col: 0 },
                { row: 0, col: 5 },
                { row: 2, col: 3 },
                { row: 4, col: 9 }
            ];
            
            for (const test of evenRowTests) {
                const worldX = MapRenderer.GRID_MARGIN + test.col * MapRenderer.HORIZONTAL_SPACING;
                const worldY = MapRenderer.GRID_MARGIN + test.row * MapRenderer.VERTICAL_SPACING;
                const foundPoint = manager.getGridPointAtPosition(worldX, worldY);
                expect(foundPoint).not.toBeNull();
                expect(foundPoint?.row).toBe(test.row);
                expect(foundPoint?.col).toBe(test.col);
            }
            
            // Test several points on odd rows (1, 3, 5)
            const oddRowTests = [
                { row: 1, col: 0 },
                { row: 1, col: 5 },
                { row: 3, col: 3 },
                { row: 5, col: 9 }
            ];
            
            for (const test of oddRowTests) {
                const worldX = MapRenderer.GRID_MARGIN + test.col * MapRenderer.HORIZONTAL_SPACING + MapRenderer.HORIZONTAL_SPACING / 2;
                const worldY = MapRenderer.GRID_MARGIN + test.row * MapRenderer.VERTICAL_SPACING;
                const foundPoint = manager.getGridPointAtPosition(worldX, worldY);
                expect(foundPoint).not.toBeNull();
                expect(foundPoint?.row).toBe(test.row);
                expect(foundPoint?.col).toBe(test.col);
            }
        });

        it('should return null for water terrain points', () => {
            // Arrange: create mock scene and container
            const mockScene = new MockScene();
            const mockContainer = { add: jest.fn() };
            
            // Create a mock grid with a water point
            const gridPoints: GridPoint[][] = [];
            gridPoints[0] = [
                {
                    row: 0,
                    col: 0,
                    x: MapRenderer.GRID_MARGIN,
                    y: MapRenderer.GRID_MARGIN,
                    terrain: TerrainType.Water,
                    id: '0-0'
                }
            ];
            
            const mockGameState = {
                players: [{ id: 'player1', color: '#FF0000' }],
                currentPlayerIndex: 0
            } as GameState;
            const manager = new TrackDrawingManager(mockScene, mockContainer, mockGameState, gridPoints);
            
            // Act: try to find the water point
            const foundPoint = manager.getGridPointAtPosition(MapRenderer.GRID_MARGIN, MapRenderer.GRID_MARGIN);
            
            // Assert: should return null for water points
            expect(foundPoint).toBeNull();
        });
    });

    describe('Real-time Cost Display', () => {
        let scene: MockScene;
        let mapContainer: any;
        let gameState: GameState;
        let gridPoints: GridPoint[][];
        let trackDrawingManager: TrackDrawingManager;
        let costUpdateCallback: jest.Mock;

        beforeEach(() => {
            // Set up our mocks
            scene = new MockScene();
            mapContainer = {
                add: jest.fn()
            };
            gameState = {
                id: 'test-game-id',
                players: [
                    { 
                        id: 'player1', 
                        name: 'Player 1', 
                        color: '#FF0000', 
                        money: 50, 
                        trainType: 'Freight',
                        turnNumber: 1,
                        trainState: {
                            position: {x: 100, y: 100, row: 1, col: 1},
                            movementHistory: [],
                            remainingMovement: 9,
                            loads: []
                        },
                        hand: []
                    }   
                ],
                currentPlayerIndex: 0,
                status: 'active',
                maxPlayers: 6
            };
            
            // Create a simple 5x5 grid of points for testing
            gridPoints = [];
            for (let row = 0; row < 5; row++) {
                gridPoints[row] = [];
                for (let col = 0; col < 5; col++) {
                    const terrain = row === 2 && col === 2 ? TerrainType.MajorCity : TerrainType.Clear;
                    gridPoints[row][col] = {
                        id: `${row}-${col}`,
                        x: col * 35 + 100,
                        y: row * 35 + 100,
                        row,
                        col,
                        terrain: terrain
                    };
                    
                    // Add city property for major city
                    if (terrain === TerrainType.MajorCity) {
                        gridPoints[row][col].city = {
                            type: TerrainType.MajorCity,
                            name: 'Test City',
                            availableLoads: []
                        };
                    }
                }
            }

            // Create the TrackDrawingManager instance
            trackDrawingManager = new TrackDrawingManager(scene as any, mapContainer, gameState, gridPoints);
            
            // Create mock callback
            costUpdateCallback = jest.fn();
        });

        it('should register and call cost update callback', () => {
            // Register callback
            trackDrawingManager.onCostUpdate(costUpdateCallback);
            
            // Toggle drawing mode on
            trackDrawingManager.toggleDrawingMode();
            
            // Verify callback was called with initial cost (0 for new session)
            expect(costUpdateCallback).toHaveBeenCalledWith(0);
        });

        it('should update cost during preview hover', () => {
            // Setup: Register callback and enter drawing mode
            trackDrawingManager.onCostUpdate(costUpdateCallback);
            trackDrawingManager.toggleDrawingMode();
            costUpdateCallback.mockClear();
            
            // Simulate starting from major city
            const startPoint = gridPoints[2][2]; // Major city
            (trackDrawingManager as any).lastClickedPoint = startPoint;
            
            // Target point (adjacent clear terrain)
            const targetPoint = gridPoints[2][3];
            
            // Mock the findPreviewPath method to return a simple path
            const mockPath = [startPoint, targetPoint];
            jest.spyOn(trackDrawingManager as any, 'findPreviewPath').mockReturnValue(mockPath);
            
            // Call processHoverUpdate directly to bypass throttling
            (trackDrawingManager as any).processHoverUpdate(targetPoint);
            
            // Should have called callback with cost for clear terrain (1)
            expect(costUpdateCallback).toHaveBeenCalledWith(1);
        });

        it('should accumulate costs across multiple drawing sessions', () => {
            // Setup: Register callback
            trackDrawingManager.onCostUpdate(costUpdateCallback);
            
            // Simulate previous session cost in player track state
            const playerTrackState = {
                playerId: 'player1',
                gameId: 'test-game-id',
                segments: [],
                totalCost: 0,
                turnBuildCost: 10, // Previous session cost
                lastBuildTimestamp: new Date()
            };
            (trackDrawingManager as any).playerTracks.set('player1', playerTrackState);
            
            // Enter drawing mode
            trackDrawingManager.toggleDrawingMode();
            
            // Should call callback with accumulated cost (10 from previous session)
            expect(costUpdateCallback).toHaveBeenCalledWith(10);
        });

        it('should show correct total cost when adding segments', () => {
            // Setup: Register callback and enter drawing mode
            trackDrawingManager.onCostUpdate(costUpdateCallback);
            
            // Mock fetch for saving tracks
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: async () => ({})
            });
            
            // Set up player track state with previous build cost
            const playerTrackState = {
                playerId: 'player1',
                gameId: 'test-game-id',
                segments: [],
                totalCost: 0,
                turnBuildCost: 15, // Previous session cost
                lastBuildTimestamp: new Date()
            };
            (trackDrawingManager as any).playerTracks.set('player1', playerTrackState);
            
            trackDrawingManager.toggleDrawingMode();
            costUpdateCallback.mockClear();
            
            // Simulate click on major city to start
            const majorCityPoint = gridPoints[2][2];
            
            // Mock getGridPointAtPosition to return the major city point
            jest.spyOn(trackDrawingManager, 'getGridPointAtPosition')
                .mockReturnValueOnce(majorCityPoint);
            
            const mockPointer = {
                x: majorCityPoint.x,
                y: majorCityPoint.y,
                leftButtonDown: () => true,
                event: null
            };
            
            scene.cameras.main.getWorldPoint = jest.fn().mockReturnValue({ 
                x: majorCityPoint.x, 
                y: majorCityPoint.y 
            });
            
            // First click to set starting point
            (trackDrawingManager as any).handleDrawingClick(mockPointer);
            
            // Now set up for second click on adjacent point
            const targetPoint = gridPoints[2][3]; // Adjacent clear terrain
            
            // Mock getGridPointAtPosition to return the target point
            jest.spyOn(trackDrawingManager, 'getGridPointAtPosition')
                .mockReturnValueOnce(targetPoint);
            
            scene.cameras.main.getWorldPoint = jest.fn().mockReturnValue({ 
                x: targetPoint.x, 
                y: targetPoint.y 
            });
            
            // Set up preview path
            (trackDrawingManager as any).previewPath = [majorCityPoint, targetPoint];
            
            // Second click to create segment
            (trackDrawingManager as any).handleDrawingClick(mockPointer);
            
            // Should update with previous (15) + new segment cost (1 for clear terrain) = 16
            expect(costUpdateCallback).toHaveBeenCalledWith(16);
        });

        it('should reset cost display when hovering over invalid paths', () => {
            // Setup: Register callback and enter drawing mode
            trackDrawingManager.onCostUpdate(costUpdateCallback);
            
            // Set accumulated cost
            const playerTrackState = {
                playerId: 'player1',
                gameId: 'test-game-id',
                segments: [],
                totalCost: 0,
                turnBuildCost: 20,
                lastBuildTimestamp: new Date()
            };
            (trackDrawingManager as any).playerTracks.set('player1', playerTrackState);
            
            trackDrawingManager.toggleDrawingMode();
            (trackDrawingManager as any).lastClickedPoint = gridPoints[2][2];
            (trackDrawingManager as any).turnBuildCost = 5; // Current session cost
            costUpdateCallback.mockClear();
            
            // Hover over water point (invalid)
            const waterPoint = {
                id: 'water',
                x: 300,
                y: 300,
                row: 8,
                col: 8,
                terrain: TerrainType.Water
            };
            
            scene.cameras.main.getWorldPoint = jest.fn().mockReturnValue({ x: 300, y: 300 });
            
            // Mock getGridPointAtPosition to return water point
            jest.spyOn(trackDrawingManager, 'getGridPointAtPosition').mockReturnValue(waterPoint);
            
            const mockPointer = { x: 300, y: 300, leftButtonDown: () => false, event: null };
            (trackDrawingManager as any).handleDrawingHover(mockPointer);
            
            // Should reset to committed cost only (20 + 5 = 25)
            expect(costUpdateCallback).toHaveBeenCalledWith(25);
        });

        it('should validate cost against player money and turn limit', () => {
            // Setup: Player with limited money
            gameState.players[0].money = 15;
            trackDrawingManager.onCostUpdate(costUpdateCallback);
            
            // Mock isValidCost to test the logic
            const isValidCost = (trackDrawingManager as any).isValidCost.bind(trackDrawingManager);
            
            // Test 1: Within both budget and money
            expect(isValidCost(10)).toBe(true);
            
            // Test 2: Over player money
            expect(isValidCost(16)).toBe(false);
            
            // Test 3: Over turn limit (20M)
            gameState.players[0].money = 100;
            expect(isValidCost(21)).toBe(false);
        });

        it('should show different preview colors based on cost validity', () => {
            // Setup graphics mock to track color changes
            const mockGraphics = {
                clear: jest.fn(),
                lineStyle: jest.fn(),
                beginPath: jest.fn(),
                moveTo: jest.fn(),
                lineTo: jest.fn(),
                strokePath: jest.fn()
            };
            (trackDrawingManager as any).previewGraphics = mockGraphics;
            
            trackDrawingManager.onCostUpdate(costUpdateCallback);
            trackDrawingManager.toggleDrawingMode();
            
            // Set starting point (major city)
            const startPoint = gridPoints[2][2];
            (trackDrawingManager as any).lastClickedPoint = startPoint;
            
            // Target point (adjacent clear terrain)
            const targetPoint = gridPoints[2][3];
            
            // Mock the findPreviewPath method to return a valid path
            const mockPath = [startPoint, targetPoint];
            jest.spyOn(trackDrawingManager as any, 'findPreviewPath').mockReturnValue(mockPath);
            
            // Test 1: Valid cost (green preview)
            gameState.players[0].money = 50;
            
            // Call processHoverUpdate directly to bypass throttling
            (trackDrawingManager as any).processHoverUpdate(targetPoint);
            
            // Should use green color (0x00ff00)
            expect(mockGraphics.lineStyle).toHaveBeenCalledWith(2, 0x00ff00, 0.5);
            
            // Test 2: Invalid cost (red preview) - player has insufficient money
            gameState.players[0].money = 0.5; // Not enough money for even 1 ECU cost
            mockGraphics.clear.mockClear();
            mockGraphics.lineStyle.mockClear();
            
            // Call processHoverUpdate again
            (trackDrawingManager as any).processHoverUpdate(targetPoint);
            
            // Should use red color (0xff0000)
            expect(mockGraphics.lineStyle).toHaveBeenCalledWith(2, 0xff0000, 0.5);
        });
    });
});