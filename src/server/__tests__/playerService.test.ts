import { db } from '../db';
import { PlayerService } from '../db/playerService';
import { v4 as uuidv4 } from 'uuid';
import '@jest/globals';

describe('PlayerService Integration Tests', () => {
    let gameId: string;

    beforeEach(async () => {
        gameId = uuidv4();
        // Create the game before running player tests
        await PlayerService.createGame(gameId);
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
                trainType: 'Freight'
            };
            await PlayerService.createPlayer(gameId, player);
            const result = await db.query('SELECT * FROM players WHERE id = $1', [player.id]);
            expect(result.rows.length).toBe(1);
        });

        it('should update an existing player', async () => {
            const playerId = uuidv4();
            const player = {
                id: playerId,
                name: 'Test Player',
                color: '#FF0000',
                money: 50,
                trainType: 'Freight'
            };
            await PlayerService.createPlayer(gameId, player);

            const updatedPlayer = {
                ...player,
                name: 'Updated Name',
                money: 100
            };
            await PlayerService.updatePlayer(gameId, updatedPlayer);

            const result = await db.query('SELECT * FROM players WHERE id = $1', [playerId]);
            expect(result.rows[0].name).toBe('Updated Name');
            expect(result.rows[0].money).toBe(100);
        });

        it('should prevent duplicate colors in the same game', async () => {
            const player1 = {
                id: uuidv4(),
                name: 'Player 1',
                color: '#FF0000',
                money: 50,
                trainType: 'Freight'
            };
            await PlayerService.createPlayer(gameId, player1);

            const player2 = {
                id: uuidv4(),
                name: 'Player 2',
                color: '#FF0000',
                money: 50,
                trainType: 'Freight'
            };
            await expect(PlayerService.createPlayer(gameId, player2)).rejects.toThrow('Color already taken by another player');
        });

        it('should validate color format', async () => {
            const player = {
                id: uuidv4(),
                name: 'Test Player',
                color: 'invalid-color',
                money: 50,
                trainType: 'Freight'
            };
            await expect(PlayerService.createPlayer(gameId, player)).rejects.toThrow('Invalid color format');
        });

        it('should delete a player', async () => {
            const playerId = uuidv4();
            const player = {
                id: playerId,
                name: 'Test Player',
                color: '#FF0000',
                money: 50,
                trainType: 'Freight'
            };
            await PlayerService.createPlayer(gameId, player);
            await PlayerService.deletePlayer(gameId, playerId);

            const result = await db.query('SELECT * FROM players WHERE id = $1', [playerId]);
            expect(result.rows.length).toBe(0);
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