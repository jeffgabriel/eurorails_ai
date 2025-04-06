import 'jest-canvas-mock';
import { SettingsScene } from '../scenes/SettingsScene';
import { PlayerColor, GameStatus } from '../../shared/types/GameTypes';
import { MockScene } from './setupTests';

// Mock fetch globally
global.fetch = jest.fn();

describe('SettingsScene Unit Tests', () => {
    let scene: SettingsScene;
    
    beforeEach(() => {
        // Reset fetch mock
        (global.fetch as jest.Mock).mockReset();
        
        // Create a new scene instance
        scene = new MockScene() as unknown as SettingsScene;
        
        // Mock scene methods that interact with Phaser
        scene.add = {
            text: jest.fn().mockReturnValue({ 
                setOrigin: jest.fn().mockReturnThis(),
                setText: jest.fn().mockReturnThis()
            }),
            rectangle: jest.fn().mockReturnValue({ 
                setInteractive: jest.fn().mockReturnThis(),
                on: jest.fn().mockReturnThis(),
                setOrigin: jest.fn().mockReturnThis(),
                setFillStyle: jest.fn().mockReturnThis()
            }),
            container: jest.fn().mockReturnValue({
                add: jest.fn(),
                destroy: jest.fn()
            }),
            dom: jest.fn().mockReturnValue({
                setOrigin: jest.fn().mockReturnThis()
            })
        } as any;

        scene.children = {
            removeAll: jest.fn()
        } as any;

        scene.scale = {
            width: 800,
            height: 600
        } as any;

        scene.scene = {
            stop: jest.fn(),
            start: jest.fn(),
            resume: jest.fn(),
            get: jest.fn().mockReturnValue({
                gameState: {},
                scene: {
                    restart: jest.fn()
                }
            })
        } as any;

        // Mock time system with a timer cleanup method
        const mockTimer = { destroy: jest.fn() };
        scene.time = {
            delayedCall: jest.fn().mockReturnValue(mockTimer)
        } as any;

        scene.init({ gameState: {
            id: '',
            players: [],
            status: 'setup' as GameStatus,
            currentPlayerIndex: 0,
            maxPlayers: 6
        }});
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
        const testPlayer = {
            id: 'player1',
            name: 'Test Player',
            color: PlayerColor.RED,
            money: 50,
            trainType: 'Freight',
            turnNumber: 1,
            trainState: {
                position: {x: 0, y: 0, row: 0, col: 0},
                movementHistory: [],
                remainingMovement: 9
            }
        };

        beforeEach(() => {
            scene['nameInput'] = document.createElement('input');
            scene['selectedColor'] = PlayerColor.BLUE;
            scene['editingPlayer'] = testPlayer;
            scene['gameState'].id = 'test-game';
        });

        it('should validate player name when saving changes', async () => {
            scene['editingPlayer'] = {
                id: 'player1',
                name: '',
                color: '#0000FF',
                money: 50,
                trainType: 'Freight',
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9
                }
            };
            scene['nameInput'] = document.createElement('input');
            scene['nameInput'].value = '';  // Empty name to trigger validation
            await scene['savePlayerChanges']();
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('should update player when save is successful', async () => {
            scene['editingPlayer'] = {
                id: 'player1',
                name: 'Test',
                color: '#0000FF',
                money: 50,
                trainType: 'Freight',
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9
                }
            };
            scene['nameInput'] = document.createElement('input');
            scene['nameInput'].value = 'Updated Name';
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Map(),
                text: () => Promise.resolve(JSON.stringify({
                    success: true,
                    data: {
                        players: []
                    }
                }))
            });
            await scene['savePlayerChanges']();
            expect(global.fetch).toHaveBeenCalled();
        });
    });

    describe('Game End', () => {
        beforeEach(() => {
            scene['gameState'].id = 'test-game';
        });

        it('should handle successful game end', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                status: 200,
                headers: new Map(),
                text: () => Promise.resolve(JSON.stringify({
                    success: true,
                    data: {
                        id: '',
                        players: [],
                        status: 'setup' as GameStatus,
                        currentPlayerIndex: 0,
                        maxPlayers: 6
                    }
                }))
            });
            await scene['endGame']();
            expect(scene.scene.start).toHaveBeenCalledWith('SetupScene', {
                gameState: {
                    id: '',
                    players: [],
                    status: 'setup' as GameStatus,
                    currentPlayerIndex: 0,
                    maxPlayers: 6
                }
            });
        });

        it('should handle failed game end', async () => {
            global.fetch = jest.fn().mockRejectedValue(new Error('Failed to end game'));
            await scene['endGame']();
            expect(scene.scene.start).not.toHaveBeenCalled();
        });
    });
}); 