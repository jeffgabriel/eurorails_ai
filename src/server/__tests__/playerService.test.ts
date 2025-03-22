import { PlayerService } from '../db/playerService';
import { v4 as uuidv4 } from 'uuid';
import '@jest/globals';

describe('PlayerService Integration Tests', () => {
    const testGameId = uuidv4();
    
    describe('Game Operations', () => {
        it('should create a new game', async () => {
            await PlayerService.createGame(testGameId);
            const exists = await PlayerService.gameExists(testGameId);
            expect(exists).toBe(true);
        });

        it('should not throw when creating duplicate game', async () => {
            const gameId = uuidv4();
            await PlayerService.createGame(gameId);
            await PlayerService.createGame(gameId); // Should not throw
            const exists = await PlayerService.gameExists(gameId);
            expect(exists).toBe(true);
        });
    });

    describe('Player Operations', () => {
        const testPlayer = {
            id: uuidv4(),
            name: 'Test Player',
            color: '#ff0000',
            money: 50,
            trainType: 'Freight'
        };

        it('should create a new player', async () => {
            const gameId = uuidv4();
            await PlayerService.createGame(gameId);
            await PlayerService.createPlayer(gameId, testPlayer);
            const exists = await PlayerService.playerExists(gameId, testPlayer.id);
            expect(exists).toBe(true);
        });

        it('should update an existing player', async () => {
            const gameId = uuidv4();
            // Create initial player
            await PlayerService.createGame(gameId);
            await PlayerService.createPlayer(gameId, testPlayer);

            // Update player
            const updatedPlayer = {
                ...testPlayer,
                name: 'Updated Name',
                color: '#00ff00',
                money: 100,
                trainType: 'Fast Freight'
            };

            await PlayerService.updatePlayer(gameId, updatedPlayer);

            // Get players and verify update
            const players = await PlayerService.getPlayers(gameId);
            const player = players.find(p => p.id === testPlayer.id);
            
            expect(player).toBeDefined();
            expect(player?.name).toBe('Updated Name');
            expect(player?.color).toBe('#00ff00');
            expect(player?.money).toBe(100);
            expect(player?.trainType).toBe('Fast Freight');
        });

        it('should prevent duplicate colors in the same game', async () => {
            const gameId = uuidv4();
            // Create first player
            await PlayerService.createGame(gameId);
            await PlayerService.createPlayer(gameId, testPlayer);

            // Try to create second player with same color
            const player2 = {
                id: uuidv4(),
                name: 'Test Player 2',
                color: '#ff0000', // Same color as testPlayer
                money: 50,
                trainType: 'Freight'
            };

            await expect(PlayerService.createPlayer(gameId, player2))
                .rejects
                .toThrow('Color already taken by another player');
        });

        it('should validate color format', async () => {
            const gameId = uuidv4();
            const invalidPlayer = {
                ...testPlayer,
                id: uuidv4(),
                color: 'red' // Invalid color format
            };

            await expect(PlayerService.createPlayer(gameId, invalidPlayer))
                .rejects
                .toThrow('Invalid color format');
        });

        it('should delete a player', async () => {
            const gameId = uuidv4();
            // Create player
            await PlayerService.createGame(gameId);
            await PlayerService.createPlayer(gameId, testPlayer);

            // Delete player
            await PlayerService.deletePlayer(gameId, testPlayer.id);

            // Verify deletion
            const exists = await PlayerService.playerExists(gameId, testPlayer.id);
            expect(exists).toBe(false);
        });
    });

    describe('Default Game', () => {
        it('should initialize default game with correct values', async () => {
            const gameId = await PlayerService.initializeDefaultGame();
            
            const exists = await PlayerService.gameExists(gameId);
            expect(exists).toBe(true);

            const players = await PlayerService.getPlayers(gameId);
            expect(players).toHaveLength(1);
            expect(players[0]).toMatchObject({
                name: 'Player 1',
                color: '#ff0000',
                money: 50,
                trainType: 'Freight'
            });
        });
    });
}); 