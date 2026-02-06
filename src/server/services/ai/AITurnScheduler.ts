import { db } from '../../db/index';
import { AIStrategyEngine } from './AIStrategyEngine';
import { emitToGame } from '../socketService';

const AI_TURN_TIMEOUT_MS = 30_000;

/**
 * Schedules and executes AI turns when it's a bot player's turn.
 *
 * Called after the current player index is updated. If the new current
 * player is an AI, triggers the AI pipeline asynchronously with a
 * 30-second timeout. After the AI turn completes (or times out),
 * advances to the next player automatically.
 */
export class AITurnScheduler {
  /**
   * Check if the current player at the given index is an AI player.
   * If so, schedule their turn asynchronously and return true.
   * Returns false if the player is human (no action taken).
   */
  static async triggerIfAI(gameId: string, currentPlayerIndex: number): Promise<boolean> {
    // Look up the player at this index
    const playerResult = await db.query(
      `SELECT id, is_ai
       FROM players
       WHERE game_id = $1
       ORDER BY created_at ASC
       LIMIT 1 OFFSET $2`,
      [gameId, currentPlayerIndex],
    );

    if (playerResult.rows.length === 0) {
      return false;
    }

    const player = playerResult.rows[0];
    if (!player.is_ai) {
      return false;
    }

    // Fire and forget — the AI turn runs asynchronously
    this.executeAITurn(gameId, player.id, currentPlayerIndex).catch(error => {
      console.error(
        `[BOT:ERROR] Unhandled error in AI turn for player ${player.id} in game ${gameId}:`,
        error,
      );
    });

    return true;
  }

  /**
   * Execute a single AI turn with a timeout, then advance to the next player.
   * If multiple consecutive AI players exist, this will chain through them.
   */
  private static async executeAITurn(
    gameId: string,
    playerId: string,
    currentPlayerIndex: number,
  ): Promise<void> {
    let timedOut = false;

    try {
      // Race the AI turn against a timeout
      const result = await Promise.race([
        AIStrategyEngine.executeTurn(gameId, playerId),
        this.timeout(AI_TURN_TIMEOUT_MS).then(() => {
          timedOut = true;
          return null;
        }),
      ]);

      if (timedOut) {
        console.warn(
          `[BOT:WARN] AI turn timed out after ${AI_TURN_TIMEOUT_MS}ms for player ${playerId} in game ${gameId}. Forcing pass.`,
        );
        emitToGame(gameId, 'ai:turn-complete', {
          playerId,
          result: 'timeout',
          totalMs: AI_TURN_TIMEOUT_MS,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      console.error(
        `[BOT:ERROR] AI turn failed for player ${playerId} in game ${gameId}:`,
        error,
      );
      // The AIStrategyEngine should have already handled fallback,
      // but if something unexpected happens, emit a turn-complete so
      // the game doesn't hang.
      emitToGame(gameId, 'ai:turn-complete', {
        playerId,
        result: 'error',
        totalMs: 0,
        timestamp: Date.now(),
      });
    }

    // Advance to the next player
    await this.advanceToNextPlayer(gameId, currentPlayerIndex);
  }

  /**
   * Advance to the next player after an AI turn completes.
   * If the next player is also an AI, this triggers their turn too.
   */
  private static async advanceToNextPlayer(
    gameId: string,
    currentPlayerIndex: number,
  ): Promise<void> {
    // Get total player count to wrap around
    const countResult = await db.query(
      'SELECT COUNT(*)::int AS count FROM players WHERE game_id = $1',
      [gameId],
    );
    const playerCount = countResult.rows[0].count;
    if (playerCount === 0) return;

    const nextIndex = (currentPlayerIndex + 1) % playerCount;

    // Update the game's current player index
    await db.query(
      'UPDATE games SET current_player_index = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [nextIndex, gameId],
    );

    // Get the next player's ID for socket events
    const nextPlayerResult = await db.query(
      `SELECT id, is_ai
       FROM players
       WHERE game_id = $1
       ORDER BY created_at ASC
       LIMIT 1 OFFSET $2`,
      [gameId, nextIndex],
    );

    if (nextPlayerResult.rows.length === 0) return;

    const nextPlayer = nextPlayerResult.rows[0];

    // Emit turn change via socket
    const { emitTurnChange, emitStatePatch } = await import('../socketService');
    emitTurnChange(gameId, nextIndex, nextPlayer.id);
    await emitStatePatch(gameId, { currentPlayerIndex: nextIndex });

    // If the next player is also AI, trigger their turn
    if (nextPlayer.is_ai) {
      this.executeAITurn(gameId, nextPlayer.id, nextIndex).catch(error => {
        console.error(
          `[BOT:ERROR] Unhandled error in chained AI turn for player ${nextPlayer.id} in game ${gameId}:`,
          error,
        );
      });
    }
  }

  private static timeout(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
