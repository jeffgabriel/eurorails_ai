import { db } from '../db';
import { PlayerService } from '../services/playerService';
import { v4 as uuidv4 } from 'uuid';
import '@jest/globals';
import { LoadType } from '../../shared/types/LoadTypes';
import { cleanDatabase } from '../db/index';
import { TrainType } from '../../shared/types/GameTypes';
import { demandDeckService } from '../services/demandDeckService';

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
            await client.query('DELETE FROM users');
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
                trainType: TrainType.Freight,
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
                trainType: TrainType.Freight,
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
                trainType: TrainType.Freight,
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
                trainType: TrainType.Freight,
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
                trainType: TrainType.Freight,
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
                trainType: TrainType.Freight,
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
                trainType: TrainType.Freight,
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

    describe('Train purchases (upgrade / crossgrade)', () => {
        it('should allow Freight -> FastFreight upgrade for 20M when no track spent this turn', async () => {
            const playerId = uuidv4();
            const userId = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId, `user_${userId.slice(0, 8)}`, `user_${userId.slice(0, 8)}@test.local`, 'hash']
            );
            const player = {
                id: playerId,
                userId,
                name: 'Upgrader',
                color: '#FF0000',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            };
            await PlayerService.createPlayer(gameId, player as any);

            const updated = await PlayerService.purchaseTrainType(
                gameId,
                userId,
                'upgrade',
                TrainType.FastFreight
            );

            expect(updated.trainType).toBe(TrainType.FastFreight);
            expect(updated.money).toBe(30);
        });

        it('should block upgrade if turn_build_cost > 0', async () => {
            const playerId = uuidv4();
            const userId = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId, `user_${userId.slice(0, 8)}`, `user_${userId.slice(0, 8)}@test.local`, 'hash']
            );
            const player = {
                id: playerId,
                userId,
                name: 'Blocked',
                color: '#00FF00',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            };
            await PlayerService.createPlayer(gameId, player as any);

            // Simulate track spend this turn
            await db.query(
                `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [gameId, playerId, JSON.stringify([]), 0, 1]
            );

            await expect(
                PlayerService.purchaseTrainType(gameId, userId, 'upgrade', TrainType.FastFreight)
            ).rejects.toThrow('Cannot upgrade after building track this turn');
        });

        it('should allow crossgrade after building as long as turn_build_cost <= 15', async () => {
            const playerId = uuidv4();
            const userId = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId, `user_${userId.slice(0, 8)}`, `user_${userId.slice(0, 8)}@test.local`, 'hash']
            );
            const player = {
                id: playerId,
                userId,
                name: 'Crossgrader',
                color: '#0000FF',
                money: 50,
                trainType: TrainType.FastFreight,
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 12,
                    loads: [] as LoadType[]
                },
                hand: []
            };
            await PlayerService.createPlayer(gameId, player as any);

            await db.query(
                `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [gameId, playerId, JSON.stringify([]), 0, 12]
            );

            const updated = await PlayerService.purchaseTrainType(
                gameId,
                userId,
                'crossgrade',
                TrainType.HeavyFreight
            );

            expect(updated.trainType).toBe(TrainType.HeavyFreight);
            expect(updated.money).toBe(45);
        });

        it('should block crossgrade if turn_build_cost > 15', async () => {
            const playerId = uuidv4();
            const userId = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId, `user_${userId.slice(0, 8)}`, `user_${userId.slice(0, 8)}@test.local`, 'hash']
            );
            const player = {
                id: playerId,
                userId,
                name: 'CrossgradeBlocked',
                color: '#000000',
                money: 50,
                trainType: TrainType.HeavyFreight,
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            };
            await PlayerService.createPlayer(gameId, player as any);

            await db.query(
                `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [gameId, playerId, JSON.stringify([]), 0, 16]
            );

            await expect(
                PlayerService.purchaseTrainType(gameId, userId, 'crossgrade', TrainType.FastFreight)
            ).rejects.toThrow('Cannot crossgrade after spending more than 15M on track this turn');
        });

        it('should block crossgrade if current loads exceed target capacity', async () => {
            const playerId = uuidv4();
            const userId = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId, `user_${userId.slice(0, 8)}`, `user_${userId.slice(0, 8)}@test.local`, 'hash']
            );
            const player = {
                id: playerId,
                userId,
                name: 'OverCapacity',
                color: '#8B4513',
                money: 50,
                trainType: TrainType.HeavyFreight,
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [LoadType.Wheat, LoadType.Coal, LoadType.Oil] as LoadType[]
                },
                hand: []
            };
            await PlayerService.createPlayer(gameId, player as any);

            // Crossgrade heavy -> fast would reduce capacity to 2, but player has 3 loads.
            await expect(
                PlayerService.purchaseTrainType(gameId, userId, 'crossgrade', TrainType.FastFreight)
            ).rejects.toThrow('Cannot crossgrade: too many loads for target train capacity');
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

    describe('Load Delivery', () => {
        it('should deliver a load immediately server-side and prevent double delivery', async () => {
            demandDeckService.reset();

            const userId = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId, `user_${userId.slice(0, 8)}`, `user_${userId.slice(0, 8)}@test.local`, 'hash']
            );

            const playerId = uuidv4();
            const player = {
                id: playerId,
                userId,
                name: 'Deliverer',
                color: '#123456',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: {
                    position: {x: 0, y: 0, row: 0, col: 0},
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            };
            await PlayerService.createPlayer(gameId, player as any);

            const playerRow = await db.query('SELECT hand FROM players WHERE id = $1', [playerId]);
            const cardId: number = playerRow.rows[0].hand[0];
            const card = demandDeckService.getCard(cardId);
            expect(card).toBeTruthy();
            if (!card) {
                throw new Error('Expected demand card to exist');
            }
            const demand = card.demands[0];

            // Ensure the player is carrying the required load and has baseline money
            await db.query(
                'UPDATE players SET loads = $1, money = $2 WHERE id = $3',
                [[demand.resource], 50, playerId]
            );

            const result = await PlayerService.deliverLoadForUser(
                gameId,
                userId,
                demand.city,
                demand.resource,
                cardId
            );

            expect(result.payment).toBe(demand.payment);
            expect(result.newCard.id).toBeDefined();
            expect(result.updatedLoads).toEqual([]);
            expect(result.updatedMoney).toBe(50 + demand.payment);

            const after = await db.query('SELECT money, loads, hand FROM players WHERE id = $1', [playerId]);
            expect(after.rows[0].money).toBe(50 + demand.payment);
            expect(after.rows[0].loads).toEqual([]);
            expect(after.rows[0].hand).toHaveLength(3);
            expect(after.rows[0].hand).not.toContain(cardId);
            expect(after.rows[0].hand).toContain(result.newCard.id);

            // Second attempt should fail because the demand card has already been replaced
            await expect(
                PlayerService.deliverLoadForUser(gameId, userId, demand.city, demand.resource, cardId)
            ).rejects.toThrow('Demand card not in hand');
        });
    });
}); 