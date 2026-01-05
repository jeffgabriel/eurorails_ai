import { db } from '../db';
import { PlayerService } from '../services/playerService';
import { v4 as uuidv4 } from 'uuid';
import '@jest/globals';
import { LoadType } from '../../shared/types/LoadTypes';
import { cleanDatabase } from '../db/index';
import { TerrainType, TrainType } from '../../shared/types/GameTypes';
import { demandDeckService } from '../services/demandDeckService';
import { TrackService } from '../services/trackService';

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
        demandDeckService.reset();
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
            await client.query('DELETE FROM turn_actions');
            await client.query('DELETE FROM movement_history');
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

    describe('Track usage fees (move-train + undo)', () => {
        it('charges ECU 4M per distinct opponent per turn and supports undo reversal', async () => {
            const user1 = uuidv4();
            const user2 = uuidv4();
            await runQuery(async (client) => {
                await client.query(
                    `INSERT INTO users (id, username, email, password_hash)
                     VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
                    [
                        user1, 'u1', 'u1@example.com', 'hash',
                        user2, 'u2', 'u2@example.com', 'hash'
                    ]
                );
            });

            const p1Id = uuidv4();
            const p2Id = uuidv4();
            await PlayerService.createPlayer(gameId, {
                id: p1Id,
                userId: user1,
                name: 'P1',
                color: '#ff0000',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: {
                    position: { x: 0, y: 0, row: 1000, col: 1000 },
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[],
                },
                hand: []
            } as any);
            await PlayerService.createPlayer(gameId, {
                id: p2Id,
                userId: user2,
                name: 'P2',
                color: '#00ff00',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: {
                    position: { x: 0, y: 0, row: 1000, col: 1003 },
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[],
                },
                hand: []
            } as any);

            // Track graph (use out-of-map coordinates to avoid accidental major-city public edges):
            // P1 owns 1000,1000-1000,1001; P2 owns 1000,1001-1000,1002 and 1000,1002-1000,1003
            await TrackService.saveTrackState(gameId, p1Id, {
                playerId: p1Id,
                gameId,
                segments: [
                    {
                        from: { x: 0, y: 0, row: 1000, col: 1000, terrain: TerrainType.Clear },
                        to: { x: 0, y: 0, row: 1000, col: 1001, terrain: TerrainType.Clear },
                        cost: 1,
                    }
                ],
                totalCost: 1,
                turnBuildCost: 0,
                lastBuildTimestamp: new Date() as any,
            } as any);
            await TrackService.saveTrackState(gameId, p2Id, {
                playerId: p2Id,
                gameId,
                segments: [
                    {
                        from: { x: 0, y: 0, row: 1000, col: 1001, terrain: TerrainType.Clear },
                        to: { x: 0, y: 0, row: 1000, col: 1002, terrain: TerrainType.Clear },
                        cost: 1,
                    },
                    {
                        from: { x: 0, y: 0, row: 1000, col: 1002, terrain: TerrainType.Clear },
                        to: { x: 0, y: 0, row: 1000, col: 1003, terrain: TerrainType.Clear },
                        cost: 1,
                    }
                ],
                totalCost: 2,
                turnBuildCost: 0,
                lastBuildTimestamp: new Date() as any,
            } as any);

            const move1 = await PlayerService.moveTrainForUser({
                gameId,
                userId: user1,
                to: { row: 1000, col: 1002, x: 0, y: 0 }
            });
            expect(move1.feeTotal).toBe(4);
            expect(move1.ownersPaid.map(o => o.playerId)).toEqual([p2Id]);

            const afterMove1P1 = await db.query('SELECT money, position_row, position_col FROM players WHERE id = $1', [p1Id]);
            const afterMove1P2 = await db.query('SELECT money FROM players WHERE id = $1', [p2Id]);
            expect(afterMove1P1.rows[0].money).toBe(46);
            expect(afterMove1P1.rows[0].position_row).toBe(1000);
            expect(afterMove1P1.rows[0].position_col).toBe(1002);
            expect(afterMove1P2.rows[0].money).toBe(54);

            // Second move in same turn over same opponent should not charge again
            const move2 = await PlayerService.moveTrainForUser({
                gameId,
                userId: user1,
                to: { row: 1000, col: 1003, x: 0, y: 0 }
            });
            expect(move2.feeTotal).toBe(0);

            // Movement history should be persisted server-side for refresh rehydration
            // (directionality / reversal checks are client-side but depend on this state after refresh).
            const mh = await db.query(
                `SELECT movement_path
                 FROM movement_history
                 WHERE player_id = $1 AND game_id = $2 AND turn_number = $3`,
                [p1Id, gameId, 1]
            );
            expect(mh.rows.length).toBe(1);
            const path = mh.rows[0].movement_path;
            expect(Array.isArray(path)).toBe(true);
            expect(path).toHaveLength(2);
            expect(path[0]?.from?.row).toBe(1000);
            expect(path[0]?.from?.col).toBe(1000);
            expect(path[0]?.to?.col).toBe(1002);
            expect(path[1]?.to?.col).toBe(1003);

            // Undo second move (no fee) -> position back to 0,2, money unchanged
            const undo2 = await PlayerService.undoLastActionForUser(gameId, user1);
            expect((undo2 as any).kind).toBe('move');
            const afterUndo2P1 = await db.query('SELECT money, position_row, position_col FROM players WHERE id = $1', [p1Id]);
            const afterUndo2P2 = await db.query('SELECT money FROM players WHERE id = $1', [p2Id]);
            expect(afterUndo2P1.rows[0].money).toBe(46);
            expect(afterUndo2P1.rows[0].position_col).toBe(1002);
            expect(afterUndo2P2.rows[0].money).toBe(54);

            // Undo first move -> reverse fee and restore to 0,0
            const undo1 = await PlayerService.undoLastActionForUser(gameId, user1);
            expect((undo1 as any).kind).toBe('move');
            const afterUndo1P1 = await db.query('SELECT money, position_row, position_col FROM players WHERE id = $1', [p1Id]);
            const afterUndo1P2 = await db.query('SELECT money FROM players WHERE id = $1', [p2Id]);
            expect(afterUndo1P1.rows[0].money).toBe(50);
            expect(afterUndo1P1.rows[0].position_col).toBe(1000);
            expect(afterUndo1P2.rows[0].money).toBe(50);
        });

        it('getPlayers returns the latest movementHistory by timestamps (not UUID ordering)', async () => {
            const userId = uuidv4();
            await runQuery(async (client) => {
                await client.query(
                    `INSERT INTO users (id, username, email, password_hash)
                     VALUES ($1, $2, $3, $4)`,
                    [userId, 'mh_user', 'mh_user@example.com', 'hash']
                );
            });

            const playerId = uuidv4();
            await PlayerService.createPlayer(gameId, {
                id: playerId,
                userId,
                name: 'MH',
                color: '#ff0000',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: {
                    position: { x: 0, y: 0, row: 1, col: 1 },
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[],
                },
                hand: []
            } as any);

            const olderId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
            const newerId = '00000000-0000-0000-0000-000000000000';
            const olderPath = [{ from: { row: 1, col: 1 }, to: { row: 1, col: 2 }, cost: 0 }];
            const newerPath = [{ from: { row: 1, col: 2 }, to: { row: 1, col: 3 }, cost: 0 }];

            // Insert two movement_history rows for the same player. The "older" row has a higher UUID,
            // which would have been incorrectly selected by `ORDER BY id DESC`.
            await db.query(
                `INSERT INTO movement_history (id, player_id, game_id, movement_path, turn_number, created_at, updated_at)
                 VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $6, $6)`,
                [olderId, playerId, gameId, JSON.stringify(olderPath), 1, '2000-01-01T00:00:00Z']
            );
            await db.query(
                `INSERT INTO movement_history (id, player_id, game_id, movement_path, turn_number, created_at, updated_at)
                 VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $6, $6)`,
                [newerId, playerId, gameId, JSON.stringify(newerPath), 2, '2000-01-02T00:00:00Z']
            );

            // Update player to turn 2 so the query fetches the turn 2 movement history
            await db.query(
                `UPDATE players SET current_turn_number = 2 WHERE id = $1`,
                [playerId]
            );

            const players = await PlayerService.getPlayers(gameId, userId);
            const me = players.find(p => p.id === playerId);
            expect(me).toBeTruthy();
            expect(Array.isArray((me as any).trainState?.movementHistory)).toBe(true);
            expect((me as any).trainState.movementHistory).toEqual(newerPath);
        });

        it('rejects move when payer cannot afford new track-usage fees', async () => {
            const user1 = uuidv4();
            const user2 = uuidv4();
            await runQuery(async (client) => {
                await client.query(
                    `INSERT INTO users (id, username, email, password_hash)
                     VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
                    [
                        user1, 'u1b', 'u1b@example.com', 'hash',
                        user2, 'u2b', 'u2b@example.com', 'hash'
                    ]
                );
            });

            const p1Id = uuidv4();
            const p2Id = uuidv4();
            await PlayerService.createPlayer(gameId, {
                id: p1Id,
                userId: user1,
                name: 'P1',
                color: '#ff0000',
                money: 3,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: {
                    position: { x: 0, y: 0, row: 1000, col: 1000 },
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[],
                },
                hand: []
            } as any);
            await PlayerService.createPlayer(gameId, {
                id: p2Id,
                userId: user2,
                name: 'P2',
                color: '#00ff00',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: {
                    position: { x: 0, y: 0, row: 1000, col: 1002 },
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[],
                },
                hand: []
            } as any);

            await TrackService.saveTrackState(gameId, p1Id, {
                playerId: p1Id,
                gameId,
                segments: [
                    {
                        from: { x: 0, y: 0, row: 1000, col: 1000, terrain: TerrainType.Clear },
                        to: { x: 0, y: 0, row: 1000, col: 1001, terrain: TerrainType.Clear },
                        cost: 1,
                    }
                ],
                totalCost: 1,
                turnBuildCost: 0,
                lastBuildTimestamp: new Date() as any,
            } as any);
            await TrackService.saveTrackState(gameId, p2Id, {
                playerId: p2Id,
                gameId,
                segments: [
                    {
                        from: { x: 0, y: 0, row: 1000, col: 1001, terrain: TerrainType.Clear },
                        to: { x: 0, y: 0, row: 1000, col: 1002, terrain: TerrainType.Clear },
                        cost: 1,
                    }
                ],
                totalCost: 1,
                turnBuildCost: 0,
                lastBuildTimestamp: new Date() as any,
            } as any);

            await expect(PlayerService.moveTrainForUser({
                gameId,
                userId: user1,
                to: { row: 1000, col: 1002, x: 0, y: 0 }
            })).rejects.toThrow('Insufficient funds for track usage fees');
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

        it('should undo the last delivery and restore money, load, and the discarded demand card', async () => {
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
                name: 'UndoDeliverer',
                color: '#654321',
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
            if (!card) throw new Error('Expected demand card to exist');

            const demand = card.demands[0];
            await db.query(
                'UPDATE players SET loads = $1, money = $2 WHERE id = $3',
                [[demand.resource], 50, playerId]
            );

            const delivered = await PlayerService.deliverLoadForUser(
                gameId,
                userId,
                demand.city,
                demand.resource,
                cardId
            );
            expect(delivered.updatedMoney).toBe(50 + demand.payment);
            expect(delivered.updatedLoads).toEqual([]);
            expect(delivered.newCard.id).toBeDefined();

            const undone = await PlayerService.undoLastActionForUser(gameId, userId);
            expect(undone.kind).toBe('deliver');
            expect(undone.updatedMoney).toBe(50);
            if (undone.kind !== 'deliver') throw new Error('Expected deliver undo');
            expect(undone.updatedLoads).toEqual([demand.resource]);
            expect(undone.removedCardId).toBe(delivered.newCard.id);
            expect(undone.restoredCard.id).toBe(cardId);

            const after = await db.query('SELECT money, loads, hand FROM players WHERE id = $1', [playerId]);
            expect(after.rows[0].money).toBe(50);
            expect(after.rows[0].loads).toEqual([demand.resource]);
            expect(after.rows[0].hand).toHaveLength(3);
            expect(after.rows[0].hand).toContain(cardId);
            expect(after.rows[0].hand).not.toContain(delivered.newCard.id);

            // The card should no longer be considered dealt after undo.
            expect(demandDeckService.returnDealtCardToTop(delivered.newCard.id)).toBe(false);
        });
    });

    describe('Discard hand (skip turn)', () => {
        it('should discard all 3 cards, draw 3 new cards, and advance the turn', async () => {
            demandDeckService.reset();

            const userId1 = uuidv4();
            const userId2 = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId1, `user_${userId1.slice(0, 8)}`, `user_${userId1.slice(0, 8)}@test.local`, 'hash']
            );
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId2, `user_${userId2.slice(0, 8)}`, `user_${userId2.slice(0, 8)}@test.local`, 'hash']
            );

            const playerId1 = uuidv4();
            const playerId2 = uuidv4();

            await PlayerService.createPlayer(gameId, {
                id: playerId1,
                userId: userId1,
                name: 'Discarder',
                color: '#AA0000',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: {
                    position: { x: 0, y: 0, row: 0, col: 0 },
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            } as any);

            await PlayerService.createPlayer(gameId, {
                id: playerId2,
                userId: userId2,
                name: 'Other',
                color: '#00AA00',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: {
                    position: { x: 0, y: 0, row: 0, col: 0 },
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            } as any);

            const beforeDeck = demandDeckService.getDeckState();
            const beforePlayerRow = await db.query('SELECT hand, current_turn_number FROM players WHERE id = $1', [playerId1]);
            const oldHand: number[] = beforePlayerRow.rows[0].hand;
            const oldTurnNumber: number = beforePlayerRow.rows[0].current_turn_number;
            expect(Array.isArray(oldHand)).toBe(true);
            expect(oldHand).toHaveLength(3);

            const result = await PlayerService.discardHandForUser(gameId, userId1);
            expect(result.currentPlayerIndex).toBe(1);

            const afterDeck = demandDeckService.getDeckState();
            expect(afterDeck.discardPileSize).toBe(beforeDeck.discardPileSize + 3);
            expect(afterDeck.dealtCardsCount).toBe(beforeDeck.dealtCardsCount);

            const afterPlayerRow = await db.query('SELECT hand, current_turn_number FROM players WHERE id = $1', [playerId1]);
            const newHand: number[] = afterPlayerRow.rows[0].hand;
            const newTurnNumber: number = afterPlayerRow.rows[0].current_turn_number;
            expect(newHand).toHaveLength(3);
            expect(newTurnNumber).toBe(oldTurnNumber + 1);
            // Old hand should not remain intact (high probability); enforce at least one different id.
            const overlap = newHand.filter((id) => oldHand.includes(id));
            expect(overlap.length).toBeLessThan(3);

            const gameRow = await db.query('SELECT current_player_index FROM games WHERE id = $1', [gameId]);
            expect(gameRow.rows[0].current_player_index).toBe(1);
        });

        it('should reject discard when it is not your turn', async () => {
            demandDeckService.reset();

            const userId1 = uuidv4();
            const userId2 = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId1, `user_${userId1.slice(0, 8)}`, `user_${userId1.slice(0, 8)}@test.local`, 'hash']
            );
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId2, `user_${userId2.slice(0, 8)}`, `user_${userId2.slice(0, 8)}@test.local`, 'hash']
            );

            const playerId1 = uuidv4();
            const playerId2 = uuidv4();
            await PlayerService.createPlayer(gameId, {
                id: playerId1,
                userId: userId1,
                name: 'P1',
                color: '#111111',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: { position: { x: 0, y: 0, row: 0, col: 0 }, movementHistory: [], remainingMovement: 9, loads: [] as LoadType[] },
                hand: []
            } as any);
            await PlayerService.createPlayer(gameId, {
                id: playerId2,
                userId: userId2,
                name: 'P2',
                color: '#222222',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: { position: { x: 0, y: 0, row: 0, col: 0 }, movementHistory: [], remainingMovement: 9, loads: [] as LoadType[] },
                hand: []
            } as any);

            // Force current player index to 1 (P2's turn)
            await db.query('UPDATE games SET current_player_index = 1 WHERE id = $1', [gameId]);

            await expect(
                PlayerService.discardHandForUser(gameId, userId1)
            ).rejects.toThrow('Not your turn');
        });

        it('should reject discard when turn_build_cost > 0', async () => {
            demandDeckService.reset();

            const userId1 = uuidv4();
            const userId2 = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId1, `user_${userId1.slice(0, 8)}`, `user_${userId1.slice(0, 8)}@test.local`, 'hash']
            );
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId2, `user_${userId2.slice(0, 8)}`, `user_${userId2.slice(0, 8)}@test.local`, 'hash']
            );

            const playerId1 = uuidv4();
            const playerId2 = uuidv4();
            await PlayerService.createPlayer(gameId, {
                id: playerId1,
                userId: userId1,
                name: 'P1',
                color: '#111111',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: { position: { x: 0, y: 0, row: 0, col: 0 }, movementHistory: [], remainingMovement: 9, loads: [] as LoadType[] },
                hand: []
            } as any);
            await PlayerService.createPlayer(gameId, {
                id: playerId2,
                userId: userId2,
                name: 'P2',
                color: '#222222',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: { position: { x: 0, y: 0, row: 0, col: 0 }, movementHistory: [], remainingMovement: 9, loads: [] as LoadType[] },
                hand: []
            } as any);

            // Simulate track spend this turn for P1
            await db.query(
                `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [gameId, playerId1, JSON.stringify([]), 0, 1]
            );

            await expect(
                PlayerService.discardHandForUser(gameId, userId1)
            ).rejects.toThrow('Cannot discard hand after building track this turn');
        });

        it('should reject discard when server-tracked actions exist this turn', async () => {
            demandDeckService.reset();

            const userId1 = uuidv4();
            const userId2 = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId1, `user_${userId1.slice(0, 8)}`, `user_${userId1.slice(0, 8)}@test.local`, 'hash']
            );
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId2, `user_${userId2.slice(0, 8)}`, `user_${userId2.slice(0, 8)}@test.local`, 'hash']
            );

            const playerId1 = uuidv4();
            const playerId2 = uuidv4();
            await PlayerService.createPlayer(gameId, {
                id: playerId1,
                userId: userId1,
                name: 'P1',
                color: '#111111',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: { position: { x: 0, y: 0, row: 0, col: 0 }, movementHistory: [], remainingMovement: 9, loads: [] as LoadType[] },
                hand: []
            } as any);
            await PlayerService.createPlayer(gameId, {
                id: playerId2,
                userId: userId2,
                name: 'P2',
                color: '#222222',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: { position: { x: 0, y: 0, row: 0, col: 0 }, movementHistory: [], remainingMovement: 9, loads: [] as LoadType[] },
                hand: []
            } as any);

            const row = await db.query('SELECT current_turn_number FROM players WHERE id = $1', [playerId1]);
            const turnNumber: number = row.rows[0].current_turn_number;

            await db.query(
                `INSERT INTO turn_actions (player_id, game_id, turn_number, actions)
                 VALUES ($1, $2, $3, $4::jsonb)`,
                [playerId1, gameId, turnNumber, JSON.stringify([{ kind: 'deliver', payment: 0 }])]
            );

            await expect(
                PlayerService.discardHandForUser(gameId, userId1)
            ).rejects.toThrow('Cannot discard hand after performing actions this turn');
        });
    });

    describe('Movement state persistence', () => {
        it('should load movement history for current turn only, not previous turns', async () => {
            const userId = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId, `user_${userId.slice(0, 8)}`, `user_${userId.slice(0, 8)}@test.local`, 'hash']
            );

            const playerId = uuidv4();
            await PlayerService.createPlayer(gameId, {
                id: playerId,
                userId,
                name: 'MovementTester',
                color: '#FF0000',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 2, // Current turn is 2
                trainState: {
                    position: { x: 100, y: 100, row: 5, col: 5 },
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            } as any);

            // Insert movement history for turn 1 (previous turn)
            await db.query(
                `INSERT INTO movement_history (player_id, game_id, turn_number, movement_path)
                 VALUES ($1, $2, $3, $4)`,
                [playerId, gameId, 1, JSON.stringify([
                    { from: { row: 0, col: 0 }, to: { row: 1, col: 1 }, cost: 3 }
                ])]
            );

            // Insert movement history for turn 2 (current turn)
            await db.query(
                `INSERT INTO movement_history (player_id, game_id, turn_number, movement_path)
                 VALUES ($1, $2, $3, $4)`,
                [playerId, gameId, 2, JSON.stringify([
                    { from: { row: 5, col: 5 }, to: { row: 6, col: 6 }, cost: 2 }
                ])]
            );

            // getPlayers should return movement history for turn 2 only
            const players = await PlayerService.getPlayers(gameId, userId);
            const player = players.find(p => p.id === playerId);

            expect(player).toBeDefined();
            expect(player!.trainState.movementHistory).toHaveLength(1);
            expect(player!.trainState.movementHistory[0].from.row).toBe(5);
            expect(player!.trainState.movementHistory[0].to.row).toBe(6);
            expect(player!.trainState.movementHistory[0].cost).toBe(2);
        });

        it('should calculate remainingMovement from movement history costs', async () => {
            const userId = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId, `user_${userId.slice(0, 8)}`, `user_${userId.slice(0, 8)}@test.local`, 'hash']
            );

            const playerId = uuidv4();
            await PlayerService.createPlayer(gameId, {
                id: playerId,
                userId,
                name: 'MovementCalc',
                color: '#00FF00',
                money: 50,
                trainType: TrainType.Freight, // 9 movement points max
                turnNumber: 1,
                trainState: {
                    position: { x: 100, y: 100, row: 5, col: 5 },
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            } as any);

            // Insert movement history with costs totaling 5 movement points
            await db.query(
                `INSERT INTO movement_history (player_id, game_id, turn_number, movement_path)
                 VALUES ($1, $2, $3, $4)`,
                [playerId, gameId, 1, JSON.stringify([
                    { from: { row: 5, col: 5 }, to: { row: 6, col: 6 }, cost: 2 },
                    { from: { row: 6, col: 6 }, to: { row: 7, col: 7 }, cost: 3 }
                ])]
            );

            const players = await PlayerService.getPlayers(gameId, userId);
            const player = players.find(p => p.id === playerId);

            expect(player).toBeDefined();
            // Max movement (9) - costs used (2 + 3 = 5) = 4 remaining
            expect(player!.trainState.remainingMovement).toBe(4);
        });

        it('should return full movement when no movement history exists for current turn', async () => {
            const userId = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId, `user_${userId.slice(0, 8)}`, `user_${userId.slice(0, 8)}@test.local`, 'hash']
            );

            const playerId = uuidv4();
            await PlayerService.createPlayer(gameId, {
                id: playerId,
                userId,
                name: 'NoMovement',
                color: '#0000FF',
                money: 50,
                trainType: TrainType.FastFreight, // 12 movement points max
                turnNumber: 1,
                trainState: {
                    position: { x: 100, y: 100, row: 5, col: 5 },
                    movementHistory: [],
                    remainingMovement: 12,
                    loads: [] as LoadType[]
                },
                hand: []
            } as any);

            // No movement history inserted - should have full movement

            const players = await PlayerService.getPlayers(gameId, userId);
            const player = players.find(p => p.id === playerId);

            expect(player).toBeDefined();
            expect(player!.trainState.remainingMovement).toBe(12); // Full FastFreight speed
        });

        it('should not count previous turn movement against current turn remaining movement', async () => {
            const userId = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId, `user_${userId.slice(0, 8)}`, `user_${userId.slice(0, 8)}@test.local`, 'hash']
            );

            const playerId = uuidv4();
            await PlayerService.createPlayer(gameId, {
                id: playerId,
                userId,
                name: 'TurnBoundary',
                color: '#FF00FF',
                money: 50,
                trainType: TrainType.Freight, // 9 movement points max
                turnNumber: 3, // Current turn is 3
                trainState: {
                    position: { x: 100, y: 100, row: 5, col: 5 },
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            } as any);

            // Insert movement history for previous turns (should be ignored)
            await db.query(
                `INSERT INTO movement_history (player_id, game_id, turn_number, movement_path)
                 VALUES ($1, $2, $3, $4)`,
                [playerId, gameId, 1, JSON.stringify([
                    { from: { row: 0, col: 0 }, to: { row: 1, col: 1 }, cost: 5 }
                ])]
            );
            await db.query(
                `INSERT INTO movement_history (player_id, game_id, turn_number, movement_path)
                 VALUES ($1, $2, $3, $4)`,
                [playerId, gameId, 2, JSON.stringify([
                    { from: { row: 1, col: 1 }, to: { row: 2, col: 2 }, cost: 7 }
                ])]
            );

            // Insert movement for current turn (turn 3) with cost 2
            await db.query(
                `INSERT INTO movement_history (player_id, game_id, turn_number, movement_path)
                 VALUES ($1, $2, $3, $4)`,
                [playerId, gameId, 3, JSON.stringify([
                    { from: { row: 5, col: 5 }, to: { row: 6, col: 6 }, cost: 2 }
                ])]
            );

            const players = await PlayerService.getPlayers(gameId, userId);
            const player = players.find(p => p.id === playerId);

            expect(player).toBeDefined();
            // Should only count turn 3's cost (2), not turn 1 (5) or turn 2 (7)
            expect(player!.trainState.remainingMovement).toBe(7); // 9 - 2 = 7
            expect(player!.trainState.movementHistory).toHaveLength(1);
        });
    });

    describe('Restart (reset) - mercy rule', () => {
        it('should restart the active player: reset money/train/loads/position, replace hand, and clear track (without ending turn)', async () => {
            demandDeckService.reset();

            const userId1 = uuidv4();
            const userId2 = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId1, `user_${userId1.slice(0, 8)}`, `user_${userId1.slice(0, 8)}@test.local`, 'hash']
            );
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId2, `user_${userId2.slice(0, 8)}`, `user_${userId2.slice(0, 8)}@test.local`, 'hash']
            );

            const playerId1 = uuidv4();
            const playerId2 = uuidv4();
            await PlayerService.createPlayer(gameId, {
                id: playerId1,
                userId: userId1,
                name: 'Restarter',
                color: '#AA0000',
                money: 50,
                trainType: TrainType.FastFreight,
                turnNumber: 1,
                trainState: {
                    position: { x: 10, y: 20, row: 1, col: 2 },
                    movementHistory: [],
                    remainingMovement: 12,
                    loads: [LoadType.Wheat, LoadType.Coal] as LoadType[]
                },
                hand: []
            } as any);
            await PlayerService.createPlayer(gameId, {
                id: playerId2,
                userId: userId2,
                name: 'Other',
                color: '#00AA00',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: {
                    position: { x: 0, y: 0, row: 0, col: 0 },
                    movementHistory: [],
                    remainingMovement: 9,
                    loads: [] as LoadType[]
                },
                hand: []
            } as any);

            // Mutate player 1 to a non-default state in DB to ensure restart really resets it.
            await db.query(
                `UPDATE players
                 SET money = 123,
                     train_type = $1,
                     loads = $2,
                     position_x = 999,
                     position_y = 888,
                     position_row = 77,
                     position_col = 66
                 WHERE id = $3`,
                [TrainType.Superfreight, [LoadType.Oil, LoadType.Coal], playerId1]
            );

            // Give player 1 track to clear
            await db.query(
                `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
                 VALUES ($1, $2, $3, $4, $5, NOW())
                 ON CONFLICT (game_id, player_id)
                 DO UPDATE SET segments = EXCLUDED.segments, total_cost = EXCLUDED.total_cost, turn_build_cost = EXCLUDED.turn_build_cost, last_build_timestamp = EXCLUDED.last_build_timestamp`,
                [gameId, playerId1, JSON.stringify([{ from: { row: 0, col: 0 }, to: { row: 0, col: 1 } }]), 42, 0]
            );

            const before = await db.query(
                'SELECT hand, current_turn_number FROM players WHERE id = $1',
                [playerId1]
            );
            const oldHand: number[] = before.rows[0].hand;
            const oldTurnNumber: number = before.rows[0].current_turn_number;
            expect(oldHand).toHaveLength(3);

            const gameBefore = await db.query('SELECT current_player_index FROM games WHERE id = $1', [gameId]);
            expect(gameBefore.rows[0].current_player_index).toBe(0);

            const restarted = await PlayerService.restartForUser(gameId, userId1);
            expect(restarted.money).toBe(50);
            expect(restarted.trainType).toBe(TrainType.Freight);
            expect(Array.isArray(restarted.trainState?.loads) ? restarted.trainState.loads : []).toEqual([]);
            expect(restarted.trainState?.position).toBeUndefined();
            expect(restarted.hand).toHaveLength(3);

            const after = await db.query(
                'SELECT money, train_type, loads, position_x, position_y, position_row, position_col, hand, current_turn_number FROM players WHERE id = $1',
                [playerId1]
            );
            expect(after.rows[0].money).toBe(50);
            expect(after.rows[0].train_type).toBe(TrainType.Freight);
            expect(after.rows[0].loads).toEqual([]);
            expect(after.rows[0].position_x).toBeNull();
            expect(after.rows[0].position_y).toBeNull();
            expect(after.rows[0].position_row).toBeNull();
            expect(after.rows[0].position_col).toBeNull();
            expect(after.rows[0].hand).toHaveLength(3);
            expect(after.rows[0].current_turn_number).toBe(oldTurnNumber);

            const trackAfter = await db.query(
                'SELECT segments, total_cost, turn_build_cost FROM player_tracks WHERE game_id = $1 AND player_id = $2',
                [gameId, playerId1]
            );
            expect(trackAfter.rows.length).toBe(1);
            const segs = typeof trackAfter.rows[0].segments === 'string'
                ? JSON.parse(trackAfter.rows[0].segments || '[]')
                : (trackAfter.rows[0].segments || []);
            expect(segs).toEqual([]);
            expect(Number(trackAfter.rows[0].total_cost)).toBe(0);
            expect(Number(trackAfter.rows[0].turn_build_cost)).toBe(0);

            const gameAfter = await db.query('SELECT current_player_index FROM games WHERE id = $1', [gameId]);
            expect(gameAfter.rows[0].current_player_index).toBe(0);

            // Old hand should have been discarded; enforce that at least one card differs.
            const newHand: number[] = after.rows[0].hand;
            const overlap = newHand.filter((id) => oldHand.includes(id));
            expect(overlap.length).toBeLessThan(3);
        });

        it('should reject restart when it is not your turn', async () => {
            demandDeckService.reset();

            const userId1 = uuidv4();
            const userId2 = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId1, `user_${userId1.slice(0, 8)}`, `user_${userId1.slice(0, 8)}@test.local`, 'hash']
            );
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId2, `user_${userId2.slice(0, 8)}`, `user_${userId2.slice(0, 8)}@test.local`, 'hash']
            );

            const playerId1 = uuidv4();
            const playerId2 = uuidv4();
            await PlayerService.createPlayer(gameId, {
                id: playerId1,
                userId: userId1,
                name: 'P1',
                color: '#111111',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: { position: { x: 0, y: 0, row: 0, col: 0 }, movementHistory: [], remainingMovement: 9, loads: [] as LoadType[] },
                hand: []
            } as any);
            await PlayerService.createPlayer(gameId, {
                id: playerId2,
                userId: userId2,
                name: 'P2',
                color: '#222222',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: { position: { x: 0, y: 0, row: 0, col: 0 }, movementHistory: [], remainingMovement: 9, loads: [] as LoadType[] },
                hand: []
            } as any);

            // Force current player index to 1 (P2's turn)
            await db.query('UPDATE games SET current_player_index = 1 WHERE id = $1', [gameId]);

            await expect(
                PlayerService.restartForUser(gameId, userId1)
            ).rejects.toThrow('Not your turn');
        });

        it('should reject restart when turn_build_cost > 0', async () => {
            demandDeckService.reset();

            const userId1 = uuidv4();
            const userId2 = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId1, `user_${userId1.slice(0, 8)}`, `user_${userId1.slice(0, 8)}@test.local`, 'hash']
            );
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId2, `user_${userId2.slice(0, 8)}`, `user_${userId2.slice(0, 8)}@test.local`, 'hash']
            );

            const playerId1 = uuidv4();
            const playerId2 = uuidv4();
            await PlayerService.createPlayer(gameId, {
                id: playerId1,
                userId: userId1,
                name: 'P1',
                color: '#111111',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: { position: { x: 0, y: 0, row: 0, col: 0 }, movementHistory: [], remainingMovement: 9, loads: [] as LoadType[] },
                hand: []
            } as any);
            await PlayerService.createPlayer(gameId, {
                id: playerId2,
                userId: userId2,
                name: 'P2',
                color: '#222222',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: { position: { x: 0, y: 0, row: 0, col: 0 }, movementHistory: [], remainingMovement: 9, loads: [] as LoadType[] },
                hand: []
            } as any);

            // Simulate track spend this turn for P1
            await db.query(
                `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [gameId, playerId1, JSON.stringify([]), 0, 1]
            );

            await expect(
                PlayerService.restartForUser(gameId, userId1)
            ).rejects.toThrow('Cannot restart after building track this turn');
        });

        it('should reject restart when server-tracked actions exist this turn', async () => {
            demandDeckService.reset();

            const userId1 = uuidv4();
            const userId2 = uuidv4();
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId1, `user_${userId1.slice(0, 8)}`, `user_${userId1.slice(0, 8)}@test.local`, 'hash']
            );
            await db.query(
                'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
                [userId2, `user_${userId2.slice(0, 8)}`, `user_${userId2.slice(0, 8)}@test.local`, 'hash']
            );

            const playerId1 = uuidv4();
            const playerId2 = uuidv4();
            await PlayerService.createPlayer(gameId, {
                id: playerId1,
                userId: userId1,
                name: 'P1',
                color: '#111111',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: { position: { x: 0, y: 0, row: 0, col: 0 }, movementHistory: [], remainingMovement: 9, loads: [] as LoadType[] },
                hand: []
            } as any);
            await PlayerService.createPlayer(gameId, {
                id: playerId2,
                userId: userId2,
                name: 'P2',
                color: '#222222',
                money: 50,
                trainType: TrainType.Freight,
                turnNumber: 1,
                trainState: { position: { x: 0, y: 0, row: 0, col: 0 }, movementHistory: [], remainingMovement: 9, loads: [] as LoadType[] },
                hand: []
            } as any);

            const row = await db.query('SELECT current_turn_number FROM players WHERE id = $1', [playerId1]);
            const turnNumber: number = row.rows[0].current_turn_number;
            await db.query(
                `INSERT INTO turn_actions (player_id, game_id, turn_number, actions)
                 VALUES ($1, $2, $3, $4::jsonb)`,
                [playerId1, gameId, turnNumber, JSON.stringify([{ kind: 'deliver', payment: 0 }])]
            );

            await expect(
                PlayerService.restartForUser(gameId, userId1)
            ).rejects.toThrow('Cannot restart after performing actions this turn');
        });
    });
}); 