import 'jest-canvas-mock';
import { Scene } from 'phaser';
import { SetupScene } from '../scenes/SetupScene';
import { GameState, GameStatus, PlayerColor, INITIAL_PLAYER_MONEY } from '../../shared/types/GameTypes';
import { mocks } from './setupTests';
import { GameObjects } from 'phaser';
import { IdService } from '../../shared/services/IdService';
import { MockScene } from './setupTests';

// Mock fetch globally
global.fetch = jest.fn();

// Mock IdService
jest.mock('../../shared/services/IdService', () => ({
    IdService: {
        generateGameId: jest.fn().mockReturnValue('test-game-id')
    }
}));

describe('SetupScene Unit Tests', () => {
    let scene: SetupScene;
    
    beforeEach(() => {
        // Reset fetch mock
        (global.fetch as jest.Mock).mockReset();
        
        // Create a new scene instance
        scene = new MockScene() as unknown as SetupScene;
        
        // Mock scene methods that interact with Phaser
        scene.add = {
            text: jest.fn().mockReturnValue({ 
                setOrigin: jest.fn().mockReturnThis(),
                setInteractive: jest.fn().mockReturnThis(),
                setText: jest.fn().mockReturnThis(),
                destroy: jest.fn()
            }),
            rectangle: jest.fn().mockReturnValue({ 
                setOrigin: jest.fn().mockReturnThis(),
                setInteractive: jest.fn().mockReturnThis(),
                setFillStyle: jest.fn().mockReturnThis(),
                destroy: jest.fn()
            }),
            dom: jest.fn().mockReturnValue({
                setOrigin: jest.fn().mockReturnThis()
            })
        } as any;

        scene.time = {
            delayedCall: jest.fn().mockReturnValue({ destroy: jest.fn() })
        } as any;

        scene.input = {
            on: jest.fn()
        } as any;

        scene.cameras = {
            main: {
                setBackgroundColor: jest.fn()
            }
        } as any;

        scene.children = {
            removeAll: jest.fn()
        } as any;

        scene.scale = {
            width: 800,
            height: 600
        } as any;

        scene.scene = {
            start: jest.fn()
        } as any;

        scene.init({ gameState: {
            id: '',
            players: [],
            status: 'setup' as GameStatus,
            currentPlayerIndex: 0,
            maxPlayers: 6
        }});

        // Set up error text mock
        scene['errorText'] = {
            setText: jest.fn().mockReturnThis(),
            setOrigin: jest.fn().mockReturnThis()
        } as unknown as GameObjects.Text;
    });

    afterEach(() => {
        // Clean up any timers
        if (scene.time?.delayedCall) {
            const mockFn = scene.time.delayedCall as jest.Mock;
            const timer = mockFn.mock.results[0]?.value;
            if (timer?.destroy) {
                timer.destroy();
            }
        }
        jest.clearAllMocks();
    });

    describe('Scene Initialization', () => {
        it('should initialize with empty game state', () => {
            expect(scene['gameState']).toBeDefined();
            expect(scene['gameState'].players).toEqual([]);
            expect(scene['gameState'].id).toBe('');
        });

        it('should update game state when initialized', () => {
            const testState = {
                id: 'test-game',
                players: [],
                status: 'setup' as GameStatus,
                currentPlayerIndex: 0,
                maxPlayers: 6
            };
            scene.init({ gameState: testState });
            expect(scene['gameState']).toEqual(testState);
        });
    });

    describe('Player Management', () => {
        beforeEach(() => {
            scene['nameInput'] = document.createElement('input');
            scene['selectedColor'] = PlayerColor.BLUE;
        });

        it('should validate player name', async () => {
            scene['nameInput']!.value = '';
            await scene['addPlayer']();
            expect(scene['errorText']?.setText).toHaveBeenCalledWith('Please enter a valid name');
        });

        it('should validate color selection', async () => {
            scene['nameInput']!.value = 'Test Player';
            scene['selectedColor'] = undefined;
            await scene['addPlayer']();
            expect(scene['errorText']?.setText).toHaveBeenCalledWith('Please enter a name and select a color');
        });

        it('should prevent duplicate names', async () => {
            scene['gameState'].players = [{
                id: 'player1',
                name: 'Test Player',
                color: PlayerColor.BLUE,
                money: 50,
                trainType: 'Freight',
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: []
                },
                hand: []
            }];

            scene['nameInput']!.value = 'Test Player';
            await scene['addPlayer']();
            expect(scene['errorText']?.setText).toHaveBeenCalledWith('This name is already taken');
        });

        it('should prevent duplicate colors', async () => {
            scene['gameState'].players = [{
                id: 'player1',
                name: 'Player 1',
                color: PlayerColor.RED,
                money: 50,
                trainType: 'Freight',
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: []
                },
                hand: []
            }];

            scene['nameInput']!.value = 'Player 2';
            scene['selectedColor'] = PlayerColor.RED;
            await scene['addPlayer']();
            expect(scene['errorText']?.setText).toHaveBeenCalledWith('This color is already taken');
        });
    });

    describe('Game Start', () => {
        it('should require minimum players', async () => {
            scene['gameState'].players = [{
                id: 'player1',
                name: 'Player 1',
                color: PlayerColor.RED,
                money: 50,
                trainType: 'Freight',
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: []
                },
                hand: []
            }];

            await scene['startGame']();
            expect(scene['errorText']?.setText).toHaveBeenCalledWith('At least 2 players are required to start');
        });

        it('should update game status when starting', async () => {
            scene['gameState'].players = [
                {
                    id: 'player1',
                    name: 'Player 1',
                    color: PlayerColor.RED,
                    money: 50,
                    trainType: 'Freight',
                    turnNumber: 1,
                    trainState: {
                        position: {x: 0, y: 0, row: 0, col: 0},
                        movementHistory: [],
                        remainingMovement: 9,
                        loads: []
                    },
                    hand: []
                },
                {
                    id: 'player2',
                    name: 'Player 2',
                    color: PlayerColor.BLUE,
                    money: 50,
                    trainType: 'Freight',
                    turnNumber: 1,
                    trainState: {
                        position: {x: 0, y: 0, row: 0, col: 0},
                        movementHistory: [],
                        remainingMovement: 9,
                        loads: []
                    },
                    hand: []
                }
            ];

            (global.fetch as jest.Mock).mockImplementationOnce(() => 
                Promise.resolve({ ok: true })
            );

            await scene['startGame']();
            expect(global.fetch).toHaveBeenCalled();
            expect(scene['gameState'].status).toBe('active');
            expect(scene.scene.start).toHaveBeenCalledWith('GameScene', { gameState: scene['gameState'] });
        });
    });
}); 