import { Player } from '../../shared/types/GameTypes.js';
import { GameStatus } from '../types.js';
import { db } from '../db/index.js';

interface IDatabase {
    manyOrNone<T = any>(query: string, values?: any): Promise<T[]>;
    none(query: string, values?: any): Promise<null>;
    oneOrNone<T = any>(query: string, values?: any): Promise<T | null>;
}

interface GamePlayer extends Player {
    gameId: string;
}

export class PlayerService {
    private db: IDatabase;

    constructor() {
        this.db = db as unknown as IDatabase;
    }

    async getPlayers(gameId: string): Promise<Player[]> {
        return await this.db.manyOrNone<Player>('SELECT * FROM players WHERE game_id = $1', [gameId]);
    }

    async updatePlayer(player: GamePlayer): Promise<void> {
        await this.db.none(
            'INSERT INTO players (id, game_id, name, color, money, train_type) VALUES ($1, $2, $3, $4, $5, $6) ' +
            'ON CONFLICT (id) DO UPDATE SET name = $3, color = $4, money = $5, train_type = $6',
            [player.id, player.gameId, player.name, player.color, player.money, player.trainType]
        );
    }

    async updateCurrentPlayerIndex(gameId: string, currentPlayerIndex: number): Promise<void> {
        await this.db.none(
            'UPDATE games SET current_player_index = $1 WHERE id = $2',
            [currentPlayerIndex, gameId]
        );
    }

    async getActiveGame() {
        return await this.db.oneOrNone(
            'SELECT * FROM games WHERE status = $1 ORDER BY created_at DESC LIMIT 1',
            ['active']
        );
    }

    async updateGameStatus(gameId: string, status: GameStatus): Promise<void> {
        await this.db.none(
            'UPDATE games SET status = $1 WHERE id = $2',
            [status, gameId]
        );
    }

    async createGame(gameId: string): Promise<void> {
        await this.db.none(
            'INSERT INTO games (id, status, current_player_index) VALUES ($1, $2, $3)',
            [gameId, 'setup', 0]
        );
    }
} 