import { db } from '../../db/index';
import { capture } from './WorldSnapshotService';
import type { WhisperSubmitPayload, WhisperRecord, WhisperMetadata } from '../../../shared/types/WhisperTypes';

export class WhisperService {
  /**
   * Record a whisper advice entry from a human player about a bot's turn.
   * Captures the current WorldSnapshot and combines it with the client-provided
   * bot turn summary and human advice text.
   */
  static async recordWhisper(
    payload: WhisperSubmitPayload,
    humanPlayerId: string,
  ): Promise<WhisperRecord> {
    const { gameId, turnNumber, botPlayerId, advice, botTurnSummary } = payload;

    // Capture current game state snapshot for the bot
    const snapshot = await capture(gameId, botPlayerId);

    // Extract metadata from snapshot for reviewer convenience
    const metadata: WhisperMetadata = {
      gamePhase: snapshot.gameStatus,
      botSkillLevel: snapshot.bot.botConfig?.skillLevel ?? 'unknown',
      botProvider: snapshot.bot.botConfig?.provider ?? 'unknown',
      botModel: snapshot.bot.botConfig?.model ?? 'unknown',
      botMoney: snapshot.bot.money,
      botTrainType: snapshot.bot.trainType,
      botConnectedCities: snapshot.bot.connectedMajorCityCount,
    };

    const result = await db.query(
      `INSERT INTO whisper_advice (game_id, turn_number, bot_player_id, human_player_id, advice, bot_decision, game_state_snapshot, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [
        gameId,
        turnNumber,
        botPlayerId,
        humanPlayerId,
        advice,
        JSON.stringify(botTurnSummary),
        JSON.stringify(snapshot),
        JSON.stringify(metadata),
      ],
    );

    const row = result.rows[0];
    return {
      id: row.id,
      gameId,
      turnNumber,
      botPlayerId,
      humanPlayerId,
      advice,
      botDecision: botTurnSummary,
      gameStateSnapshot: snapshot,
      metadata,
      createdAt: row.created_at,
    };
  }

  /**
   * Retrieve whisper records for a game, optionally filtered by turn number
   * and/or bot player ID.
   */
  static async getWhispers(
    gameId: string,
    filters?: { turnNumber?: number; botPlayerId?: string },
  ): Promise<WhisperRecord[]> {
    const conditions = ['game_id = $1'];
    const params: (string | number)[] = [gameId];

    if (filters?.turnNumber !== undefined) {
      params.push(filters.turnNumber);
      conditions.push(`turn_number = $${params.length}`);
    }

    if (filters?.botPlayerId) {
      params.push(filters.botPlayerId);
      conditions.push(`bot_player_id = $${params.length}`);
    }

    const result = await db.query(
      `SELECT id, game_id, turn_number, bot_player_id, human_player_id,
              advice, bot_decision, game_state_snapshot, metadata, created_at
       FROM whisper_advice
       WHERE ${conditions.join(' AND ')}
       ORDER BY turn_number ASC, created_at ASC`,
      params,
    );

    return result.rows.map((row) => ({
      id: row.id,
      gameId: row.game_id,
      turnNumber: row.turn_number,
      botPlayerId: row.bot_player_id,
      humanPlayerId: row.human_player_id,
      advice: row.advice,
      botDecision: typeof row.bot_decision === 'string' ? JSON.parse(row.bot_decision) : row.bot_decision,
      gameStateSnapshot: typeof row.game_state_snapshot === 'string' ? JSON.parse(row.game_state_snapshot) : row.game_state_snapshot,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      createdAt: row.created_at,
    }));
  }
}
