import 'jest-canvas-mock';
import { TrackDrawingManager } from '../components/TrackDrawingManager';
import { MockScene } from './setupTests';
import { TerrainType, GameState, GridPoint } from '../../shared/types/GameTypes';

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
            const fromPoint: GridPoint = { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear };
            
            // Horizontal movement (same row)
            const horizontalPoint: GridPoint = { x: 35, y: 0, row: 0, col: 1, terrain: TerrainType.Clear };
            
            // Diagonal movement (different row)
            const diagonalPoint: GridPoint = { x: 35, y: 35, row: 1, col: 1, terrain: TerrainType.Clear };

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
            const fromPoint: GridPoint = { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear };
            
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
});