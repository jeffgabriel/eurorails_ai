import { db } from '../db';
import { PlayerService } from '../services/playerService';
import { v4 as uuidv4 } from 'uuid';
import '@jest/globals';
import { LoadType } from '../../shared/types/LoadTypes';
import { cleanDatabase } from '../db/index';

// Force Jest to run this test file serially
export const test = { concurrent: false };

// Helper to run a query with automatic connection management
async function runQuery<T = any>(queryFn: (client: any) => Promise<T>): Promise<T> {
    const client = await db.connect();
    try {
        return await queryFn(client);
    } finally {
        client.release();
    }
}

describe('PlayerService Integration Tests', () => {
    let gameId: string;

    beforeEach(async () => {
        gameId = uuidv4();
        await runQuery(async (client) => {
            await client.query(
                'INSERT INTO games (id, status, current_player_index, max_players) VALUES ($1, $2, $3, $4)',
                [gameId, 'setup', 0, 6]
            );
        });
    });

    afterEach(async () => {
        await runQuery(async (client) => {
            // Delete in dependency order to avoid constraint errors
            await client.query('DELETE FROM player_tracks');
            await client.query('DELETE FROM games'); // Delete games first (they reference players)
            await client.query('DELETE FROM players');
        });
    });

    describe('Game Operations', () => {
        it('should create a new game', async () => {
            const newGameId = uuidv4();
            await PlayerService.createGame(newGameId);
            const result = await db.query('SELECT * FROM games WHERE id = $1', [newGameId]);
            expect(result.rows.length).toBe(1);
        });

        it('should not throw when creating duplicate game', async () => {
            await expect(PlayerService.createGame(gameId)).resolves.not.toThrow();
        });
    });

    describe('Player Operations', () => {
        it('should create a new player', async () => {
            const player = {
                id: uuidv4(),
                name: 'Test Player',
                color: '#FF0000',
                money: 50,
                trainType: 'Freight',
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            };
            await PlayerService.createPlayer(gameId, player);
            const result = await db.query('SELECT * FROM players WHERE id = $1', [player.id]);
            expect(result.rows.length).toBe(1);
            expect(result.rows[0].loads).toEqual([]);
        });

        it('should update an existing player', async () => {
            const playerId = uuidv4();
            const player = {
                id: playerId,
                name: 'Test Player',
                color: '#FF0000',
                money: 50,
                trainType: 'Freight',
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            };
            await PlayerService.createPlayer(gameId, player);

            const updatedPlayer = {
                ...player,
                name: 'Updated Name',
                money: 100,
                trainState: {
                    ...player.trainState,
                    loads: [LoadType.Wheat]
                }
            };
            await PlayerService.updatePlayer(gameId, updatedPlayer);

            const result = await db.query('SELECT * FROM players WHERE id = $1', [playerId]);
            expect(result.rows.length).toBeGreaterThan(0);
            expect(result.rows[0].name).toBe('Updated Name');
            expect(result.rows[0].money).toBe(100);
            expect(result.rows[0].loads).toEqual([LoadType.Wheat]);
        });

        it('should prevent duplicate colors in the same game', async () => {
            const player1 = {
                id: uuidv4(),
                name: 'Player 1',
                color: '#FF0000',
                money: 50,
                trainType: 'Freight',
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            };
            await PlayerService.createPlayer(gameId, player1);

            const player2 = {
                id: uuidv4(),
                name: 'Player 2',
                color: '#FF0000',
                money: 50,
                trainType: 'Freight',
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            };
            await expect(PlayerService.createPlayer(gameId, player2))
                .rejects.toThrow('Color already taken by another player');
        });

        it('should validate color format', async () => {
            const player = {
                id: uuidv4(),
                name: 'Test Player',
                color: 'invalid-color',
                money: 50,
                trainType: 'Freight',
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            };
            await expect(PlayerService.createPlayer(gameId, player))
                .rejects.toThrow('Invalid color format');
        });

        it('should delete a player', async () => {
            const playerId = uuidv4();
            const player = {
                id: playerId,
                name: 'Test Player',
                color: '#FF0000',
                money: 50,
                trainType: 'Freight',
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            };
            await PlayerService.createPlayer(gameId, player);
            await PlayerService.deletePlayer(gameId, playerId);

            const result = await db.query('SELECT * FROM players WHERE id = $1', [playerId]);
            expect(result.rows.length).toBe(0);
        });

        it('should cascade delete player tracks when player is deleted', async () => {
            // Ensure the game exists before inserting player and tracks
            const playerId = uuidv4();
            const player = {
                id: playerId,
                name: 'Test Player',
                color: '#FF0000',
                money: 50,
                trainType: 'Freight',
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            };
            await PlayerService.createPlayer(gameId, player);
            
            // Add some track data
            await db.query(
                'INSERT INTO player_tracks (game_id, player_id, segments, total_cost) VALUES ($1, $2, $3, $4)',
                [gameId, playerId, JSON.stringify([{x1: 0, y1: 0, x2: 1, y2: 1}]), 10]
            );
            await PlayerService.deletePlayer(gameId, playerId);

            const trackResult = await db.query('SELECT * FROM player_tracks WHERE player_id = $1', [playerId]);
            expect(trackResult.rows.length).toBe(0);
        });
    });

    describe('Default Game', () => {
        it('should initialize default game with correct values', async () => {
            const defaultGameId = await PlayerService.initializeDefaultGame();
            const result = await db.query('SELECT * FROM games WHERE id = $1', [defaultGameId]);
            expect(result.rows.length).toBe(1);
            expect(result.rows[0].status).toBe('setup');
        });
    });
}); 