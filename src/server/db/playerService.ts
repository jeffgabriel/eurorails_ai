import { db } from './index';
import { Player } from '../../shared/types/GameTypes';
import { QueryResult } from 'pg';
import { v4 as uuidv4 } from 'uuid';

interface PlayerRow {
    id: string;
    name: string;
    color: string;
    money: number;
    train_type: string;
}

export class PlayerService {
    private static validateColor(color: string): string {
        // Ensure color is a valid hex code
        const hexColorRegex = /^#[0-9A-Fa-f]{6}$/;
        if (!hexColorRegex.test(color)) {
            throw new Error('Invalid color format. Must be a hex color code (e.g., #ff0000)');
        }
        return color.toLowerCase(); // Normalize to lowercase
    }

    static async gameExists(gameId: string): Promise<boolean> {
        const query = 'SELECT id FROM games WHERE id = $1';
        const result = await db.query(query, [gameId]);
        return result.rows.length > 0;
    }

    static async playerExists(gameId: string, playerId: string): Promise<boolean> {
        const query = 'SELECT id FROM players WHERE game_id = $1 AND id = $2';
        const result = await db.query(query, [gameId, playerId]);
        return result.rows.length > 0;
    }

    static async createGame(gameId: string): Promise<void> {
        const query = `
            INSERT INTO games (id, status)
            VALUES ($1, 'setup')
            ON CONFLICT (id) DO NOTHING
        `;
        await db.query(query, [gameId]);
    }

    static async createPlayer(gameId: string, player: Player): Promise<void> {
        // Validate and normalize color
        const normalizedColor = this.validateColor(player.color);

        const query = `
            INSERT INTO players (id, game_id, name, color, money, train_type)
            VALUES ($1, $2, $3, $4, $5, $6)
        `;
        const values = [
            player.id,
            gameId,
            player.name,
            normalizedColor,
            player.money || 50,
            player.trainType || 'Freight'
        ];
        try {
            await db.query(query, values);
        } catch (err: any) {
            if (err.code === '23505' && err.constraint === 'players_game_id_color_key') {
                throw new Error('Color already taken by another player');
            }
            throw err;
        }
    }

    static async updatePlayer(gameId: string, player: Player): Promise<void> {
        console.log('Starting database update for player:', { gameId, player });
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            console.log('Started transaction');

            // Validate and normalize color
            const normalizedColor = this.validateColor(player.color);

            // Check if game exists, create if it doesn't
            const gameExists = await this.gameExists(gameId);
            if (!gameExists) {
                console.log('Game does not exist, creating new game');
                await this.createGame(gameId);
            }

            // Check if player exists
            const exists = await this.playerExists(gameId, player.id);
            console.log('Player exists check:', { exists, gameId, playerId: player.id });

            if (!exists) {
                console.log('Player does not exist, creating new player');
                await this.createPlayer(gameId, player);
                await client.query('COMMIT');
                console.log('Successfully created new player');
                return;
            }

            // First check if another player already has this color
            const colorCheckQuery = `
                SELECT id FROM players 
                WHERE game_id = $1 AND color = $2 AND id != $3
            `;
            const colorCheckValues = [gameId, normalizedColor, player.id];
            const colorCheckResult: QueryResult<PlayerRow> = await client.query(colorCheckQuery, colorCheckValues);
            
            if (colorCheckResult.rows.length > 0) {
                throw new Error('Color already taken by another player');
            }

            // Normalize the train type to match database format
            const trainType = player.trainType || 'Freight';

            const query = `
                UPDATE players 
                SET name = $1, 
                    color = $2, 
                    money = $3, 
                    train_type = $4, 
                    updated_at = CURRENT_TIMESTAMP
                WHERE game_id = $5 AND id = $6
                RETURNING *
            `;
            const values = [
                player.name, 
                normalizedColor, 
                player.money || 50, 
                trainType, 
                gameId, 
                player.id
            ];
            console.log('Executing update query:', { query, values });

            const result: QueryResult<PlayerRow> = await client.query(query, values);
            console.log('Update result:', { rowCount: result.rowCount, row: result.rows[0] });

            if (result.rows.length === 0) {
                throw new Error('Player update failed');
            }

            await client.query('COMMIT');
            console.log('Transaction committed successfully');
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Database error during player update:', err);
            
            // Enhance error messages for common issues
            if (err instanceof Error) {
                if (err.message.includes('players_color_check')) {
                    throw new Error('Invalid color format. Must be a hex color code (e.g., #ff0000)');
                }
                if (err.message.includes('players_game_id_color_key')) {
                    throw new Error('Color already taken by another player');
                }
            }
            throw err;
        } finally {
            client.release();
            console.log('Database connection released');
        }
    }

    static async deletePlayer(gameId: string, playerId: string): Promise<void> {
        const query = 'DELETE FROM players WHERE game_id = $1 AND id = $2';
        await db.query(query, [gameId, playerId]);
    }

    static async getPlayers(gameId: string): Promise<Player[]> {
        console.log('Starting database query for players:', { gameId });
        const client = await db.connect();
        try {
            const query = `
                SELECT id, name, color, money, train_type as "trainType"
                FROM players 
                WHERE game_id = $1
                ORDER BY turn_order
            `;
            const values = [gameId];
            console.log('Executing select query:', { query, values });

            const result = await client.query(query, values);
            console.log('Query result:', { rowCount: result.rowCount });

            return result.rows;
        } catch (err) {
            console.error('Database error during players query:', err);
            throw err;
        } finally {
            client.release();
            console.log('Database connection released');
        }
    }

    static async initializeDefaultGame(): Promise<string> {
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            
            // Create a default game with UUID
            const gameId = uuidv4();
            const createGameQuery = `
                INSERT INTO games (id, status)
                VALUES ($1, 'setup')
                ON CONFLICT (id) DO NOTHING
                RETURNING id
            `;
            await client.query(createGameQuery, [gameId]);

            // Create a default player
            const defaultPlayer = {
                id: uuidv4(),
                name: 'Player 1',
                color: '#ff0000',
                money: 50,
                trainType: 'Freight'
            };

            const createPlayerQuery = `
                INSERT INTO players (id, game_id, name, color, money, train_type)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (id) DO NOTHING
            `;
            await client.query(createPlayerQuery, [
                defaultPlayer.id,
                gameId,
                defaultPlayer.name,
                defaultPlayer.color,
                defaultPlayer.money,
                defaultPlayer.trainType
            ]);

            await client.query('COMMIT');
            return gameId;
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Error initializing default game:', err);
            throw err;
        } finally {
            client.release();
        }
    }

    static async updateCurrentPlayerIndex(gameId: string, currentPlayerIndex: number): Promise<void> {
        const query = `
            UPDATE games 
            SET current_player_index = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
        `;
        await db.query(query, [currentPlayerIndex, gameId]);
    }

    static async getGameState(gameId: string): Promise<{ currentPlayerIndex: number }> {
        const query = `
            SELECT current_player_index
            FROM games
            WHERE id = $1
        `;
        const result = await db.query(query, [gameId]);
        if (result.rows.length === 0) {
            throw new Error('Game not found');
        }
        return {
            currentPlayerIndex: result.rows[0].current_player_index
        };
    }
} 