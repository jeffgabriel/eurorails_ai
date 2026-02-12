/**
 * InitialBuildService — Manages the two-round initial track building phase.
 *
 * Round 1: Players build in clockwise order (as seated).
 * Round 2: Reverse order (last player from round 1 goes first).
 * After round 2: Game transitions to 'active' status.
 *
 * Per game rules: "The last player from the second building turn
 * becomes the first player for the rest of the game."
 */

import { db } from '../db/index';

export class InitialBuildService {
  /**
   * Initialize the initial build phase when a game starts.
   * Sets game to 'initialBuild' status with round 1 and clockwise player order.
   *
   * @param gameId - The game UUID
   * @param playerIds - Player IDs in clockwise seating order
   */
  static async setupInitialBuild(
    gameId: string,
    playerIds: string[],
  ): Promise<void> {
    if (playerIds.length === 0) {
      throw new Error('Cannot setup initial build with no players');
    }

    // Find the index of the first player in the standard player ordering
    const playersResult = await db.query(
      'SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC',
      [gameId],
    );
    const standardOrder = playersResult.rows.map((r: { id: string }) => r.id);
    const firstPlayerId = playerIds[0];
    const firstPlayerIndex = standardOrder.indexOf(firstPlayerId);

    await db.query(
      `UPDATE games SET
        status = 'initialBuild',
        initial_build_round = 1,
        initial_build_order = $1,
        current_player_index = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3`,
      [JSON.stringify(playerIds), firstPlayerIndex, gameId],
    );

    const { emitTurnChange } = await import('./socketService');
    emitTurnChange(gameId, firstPlayerIndex, firstPlayerId);
  }

  /**
   * Advance to the next player in the initial build phase.
   * Handles within-round progression, round 1→2 transition (with order reversal),
   * and round 2→active transition.
   *
   * @param gameId - The game UUID
   */
  static async advanceTurn(gameId: string): Promise<void> {
    // Get current game state
    const gameResult = await db.query(
      'SELECT status, initial_build_round, initial_build_order, current_player_index FROM games WHERE id = $1',
      [gameId],
    );
    const game = gameResult.rows[0];
    if (!game) {
      throw new Error(`Game ${gameId} not found`);
    }
    if (game.status !== 'initialBuild') {
      throw new Error(`Game ${gameId} is not in initialBuild phase (status: ${game.status})`);
    }

    // Get standard player ordering
    const playersResult = await db.query(
      'SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC',
      [gameId],
    );
    const standardOrder = playersResult.rows.map((r: { id: string }) => r.id);

    const order: string[] = game.initial_build_order;
    const round: number = game.initial_build_round;
    const currentPlayerId = standardOrder[game.current_player_index];

    // Find current position within the initial build order
    const currentPosition = order.indexOf(currentPlayerId);

    if (currentPosition < order.length - 1) {
      // Not at end of round: advance to next player in order
      const nextPlayerId = order[currentPosition + 1];
      const nextPlayerIndex = standardOrder.indexOf(nextPlayerId);

      await db.query(
        `UPDATE games SET
          current_player_index = $1,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $2`,
        [nextPlayerIndex, gameId],
      );

      const { emitTurnChange } = await import('./socketService');
      emitTurnChange(gameId, nextPlayerIndex, nextPlayerId);
    } else if (round === 1) {
      // End of round 1: transition to round 2 with reversed order
      const reversedOrder = [...order].reverse();
      const firstPlayerId = reversedOrder[0];
      const firstPlayerIndex = standardOrder.indexOf(firstPlayerId);

      await db.query(
        `UPDATE games SET
          initial_build_round = 2,
          initial_build_order = $1,
          current_player_index = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $3`,
        [JSON.stringify(reversedOrder), firstPlayerIndex, gameId],
      );

      const { emitTurnChange } = await import('./socketService');
      emitTurnChange(gameId, firstPlayerIndex, firstPlayerId);
    } else if (round === 2) {
      // End of round 2: transition to active phase
      // Per rules: "The last player from the second building turn
      // becomes the first player for the rest of the game."
      const lastPlayerId = order[order.length - 1];
      const lastPlayerIndex = standardOrder.indexOf(lastPlayerId);

      await db.query(
        `UPDATE games SET
          status = 'active',
          initial_build_round = 0,
          initial_build_order = NULL,
          current_player_index = $1,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $2`,
        [lastPlayerIndex, gameId],
      );

      const { emitTurnChange, emitStatePatch } = await import('./socketService');
      emitTurnChange(gameId, lastPlayerIndex, lastPlayerId);
      await emitStatePatch(gameId, { status: 'active' } as any);
    }
  }
}
