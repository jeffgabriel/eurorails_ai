/**
 * InitialBuildService — manages the two-round initialBuild phase.
 *
 * Per the rules:
 *   Round 1: Players build clockwise (player 0 → 1 → 2 → …).
 *   Round 2: Players build counter-clockwise (last player → … → 1 → 0).
 *   After round 2 completes, the game transitions to 'active' and the
 *   last player from round 2 (player 0) becomes the first active player.
 *
 * Each player may spend up to ECU 20M per build turn.
 *
 * DB columns used (from migration 031):
 *   games.initial_build_round   — 1 or 2 (0 = not started / already finished)
 *   games.initial_build_order   — JSONB array of player IDs in current-round order
 *   games.current_player_index  — index into initial_build_order during initialBuild
 */

import { db } from '../db/index';

/** Max spend per initialBuild turn (ECU millions). */
export const INITIAL_BUILD_MAX_SPEND = 20;

export interface InitialBuildState {
  round: number;            // 1 or 2
  order: string[];          // player IDs in turn order for current round
  currentIndex: number;     // index into `order`
}

export class InitialBuildService {
  /**
   * Initialize the initialBuild phase for a game that is transitioning
   * from 'setup' to 'initialBuild'.
   *
   * Sets round = 1, builds clockwise order (created_at ASC), and sets
   * current_player_index = 0.
   *
   * Must be called within an existing transaction (uses the provided client).
   */
  static async initPhase(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
    gameId: string,
  ): Promise<void> {
    // Get players in clockwise order (created_at ASC — same as getPlayers)
    const playersResult = await client.query(
      `SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC`,
      [gameId],
    );
    const playerIds = playersResult.rows.map((r: any) => r.id as string);

    if (playerIds.length < 2) {
      throw new Error('Need at least 2 players to start initialBuild');
    }

    // Round 1: clockwise order
    const round1Order = playerIds;

    await client.query(
      `UPDATE games
       SET status = 'initialBuild',
           initial_build_round = 1,
           initial_build_order = $1,
           current_player_index = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [JSON.stringify(round1Order), gameId],
    );
  }

  /**
   * Advance to the next player in the initialBuild phase.
   *
   * When a player finishes their build turn, this method:
   * 1. Increments current_player_index
   * 2. If the round is complete, transitions to round 2 (reverse order)
   * 3. If round 2 is also complete, transitions the game to 'active'
   *
   * Returns the new game state info for socket emission.
   */
  static async advanceTurn(
    gameId: string,
  ): Promise<{
    phase: 'initialBuild' | 'active';
    currentPlayerIndex: number;
    currentPlayerId: string;
  }> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const gameResult = await client.query(
        `SELECT initial_build_round, initial_build_order, current_player_index
         FROM games
         WHERE id = $1
         FOR UPDATE`,
        [gameId],
      );
      if (gameResult.rows.length === 0) {
        throw new Error('Game not found');
      }

      const round: number = gameResult.rows[0].initial_build_round;
      const order: string[] = gameResult.rows[0].initial_build_order || [];
      const currentIndex: number = Number(gameResult.rows[0].current_player_index ?? 0);
      const nextIndex = currentIndex + 1;

      if (nextIndex < order.length) {
        // Still players left in this round
        await client.query(
          `UPDATE games
           SET current_player_index = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [nextIndex, gameId],
        );

        await client.query('COMMIT');

        const nextPlayerId = order[nextIndex];
        // Emit turn change
        try {
          const { emitTurnChange } = await import('./socketService');
          emitTurnChange(gameId, nextIndex, nextPlayerId);
        } catch { /* best-effort */ }

        return { phase: 'initialBuild', currentPlayerIndex: nextIndex, currentPlayerId: nextPlayerId };
      }

      // Round complete
      if (round === 1) {
        // Transition to round 2: reverse order
        const round2Order = [...order].reverse();
        await client.query(
          `UPDATE games
           SET initial_build_round = 2,
               initial_build_order = $1,
               current_player_index = 0,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [JSON.stringify(round2Order), gameId],
        );

        await client.query('COMMIT');

        const firstPlayerId = round2Order[0];
        try {
          const { emitTurnChange } = await import('./socketService');
          emitTurnChange(gameId, 0, firstPlayerId);
        } catch { /* best-effort */ }

        return { phase: 'initialBuild', currentPlayerIndex: 0, currentPlayerId: firstPlayerId };
      }

      // Round 2 complete — transition to active phase
      // The last player of round 2 (index order.length - 1) is player 0 in clockwise order.
      // Per rules: "last player from second building turn becomes first player for the rest of the game."
      // Round 2 is reversed, so the last to play is order[order.length - 1] = original first player (index 0).
      // The "first player for the rest of the game" is the last player of round 2.
      // Since round 2 reverses: [P2, P1, P0] for 3 players, last to play = P0.
      // P0 becomes the first active player. We need to find their position in the original (clockwise) ordering.

      // Get clockwise player order for active phase
      const playersResult = await client.query(
        `SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC`,
        [gameId],
      );
      const clockwiseIds = playersResult.rows.map((r: any) => r.id as string);

      // Last player in round 2 order is order[order.length - 1]
      const firstActivePlayerId = order[order.length - 1];
      const firstActiveIndex = clockwiseIds.indexOf(firstActivePlayerId);

      await client.query(
        `UPDATE games
         SET status = 'active',
             initial_build_round = 0,
             initial_build_order = NULL,
             current_player_index = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [firstActiveIndex, gameId],
      );

      await client.query('COMMIT');

      try {
        const { emitTurnChange, emitStatePatch } = await import('./socketService');
        emitTurnChange(gameId, firstActiveIndex, firstActivePlayerId);
        await emitStatePatch(gameId, { status: 'active', currentPlayerIndex: firstActiveIndex } as any);
      } catch { /* best-effort */ }

      return { phase: 'active', currentPlayerIndex: firstActiveIndex, currentPlayerId: firstActivePlayerId };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get the current initialBuild state for a game.
   * Returns null if the game is not in initialBuild phase.
   */
  static async getState(gameId: string): Promise<InitialBuildState | null> {
    const result = await db.query(
      `SELECT status, initial_build_round, initial_build_order, current_player_index
       FROM games WHERE id = $1`,
      [gameId],
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    if (row.status !== 'initialBuild') return null;

    return {
      round: row.initial_build_round,
      order: row.initial_build_order || [],
      currentIndex: Number(row.current_player_index ?? 0),
    };
  }

  /**
   * Get the current active player ID during initialBuild.
   * Uses initial_build_order[current_player_index] (not the created_at offset approach).
   */
  static async getCurrentPlayerId(gameId: string): Promise<string | null> {
    const state = await this.getState(gameId);
    if (!state) return null;
    return state.order[state.currentIndex] || null;
  }
}
