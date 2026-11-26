import { db } from '../db';
import { VictoryState, VICTORY_INITIAL_THRESHOLD, VICTORY_TIE_THRESHOLD, VICTORY_CITY_COUNT } from '../../shared/types/GameTypes';
import { TrackService } from './trackService';
import { TrackSegment } from '../../shared/types/TrackTypes';
import { cleanupGameState } from './gameCleanupService';
import { WinConditionsService, UnmetWinCondition } from './winConditionsService';
import { lockPlayerForUserTurn } from './turnGuard';
import { PlayerService } from './playerService';
import type { MajorCityCoordinate } from './winConditionsService';

export type { MajorCityCoordinate } from './winConditionsService';

export interface DeclareVictoryResult {
  success: boolean;
  error?: string;
  victoryState?: VictoryState;
  /** Name of the declaring player; set on success. */
  playerName?: string;
}

/** The pool or a transaction client; whichever the caller is running on. */
interface Queryable {
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
}

/**
 * Thrown by `resolveVictoryForUser` when no final round is pending, or the
 * caller is not the player whose turn closes it.
 */
export class VictoryNotFinalTurnError extends Error {
  constructor() {
    super('Victory can only be resolved after the final turn');
    this.name = 'VictoryNotFinalTurnError';
  }
}

export interface ResolveVictoryResult {
  gameOver: boolean;
  winnerId?: string;
  winnerName?: string;
  tieExtended?: boolean;
  newThreshold?: number;
  /** Present when no player qualifies and normal play resumes. */
  victoryState?: VictoryState;
}

export class VictoryService {
  /**
   * Get the current victory state for a game
   */
  static async getVictoryState(gameId: string): Promise<VictoryState | null> {
    const result = await db.query(
      `SELECT victory_triggered, victory_trigger_player_index,
              victory_threshold, final_turn_player_index
       FROM games WHERE id = $1`,
      [gameId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      triggered: row.victory_triggered || false,
      triggerPlayerIndex: row.victory_trigger_player_index ?? -1,
      victoryThreshold: row.victory_threshold ?? VICTORY_INITIAL_THRESHOLD,
      finalTurnPlayerIndex: row.final_turn_player_index ?? -1,
    };
  }

  /**
   * Validate that the claimed major city coordinates exist in the player's track
   */
  static validateCitiesInTrack(
    segments: TrackSegment[],
    claimedCities: MajorCityCoordinate[]
  ): boolean {
    // Build a set of all coordinates in the player's track
    const trackCoords = new Set<string>();
    for (const segment of segments) {
      trackCoords.add(`${segment.from.row},${segment.from.col}`);
      trackCoords.add(`${segment.to.row},${segment.to.col}`);
    }

    // Verify each claimed city coordinate exists in the track
    for (const city of claimedCities) {
      const key = `${city.row},${city.col}`;
      if (!trackCoords.has(key)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Declare victory for a player. Trusted entry point for server-side callers
   * (bots), which name the player themselves. HTTP callers must go through
   * `declareVictoryForUser`.
   */
  static async declareVictory(
    gameId: string,
    playerId: string,
    _claimedCities: MajorCityCoordinate[]
  ): Promise<DeclareVictoryResult> {
    return VictoryService.declareVictoryWith(db, gameId, playerId);
  }

  /**
   * Declare victory for the calling user's player (issue #306).
   *
   * In ONE transaction: confirms the game is active and it is the user's turn
   * (`lockPlayerForUserTurn`, which also holds the game row FOR UPDATE so two
   * declarations cannot race), charges any unsettled build cost so eligibility
   * is judged on post-build money, then validates and records the declaration.
   * A rejected declaration rolls back and changes nothing.
   *
   * @throws TurnGuardError when the user may not act right now.
   */
  static async declareVictoryForUser(
    gameId: string,
    userId: string,
  ): Promise<DeclareVictoryResult> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { player } = await lockPlayerForUserTurn(client, gameId, userId);
      await PlayerService.settleTurnBuildCost(client, gameId, player.id);
      const result = await VictoryService.declareVictoryWith(client, gameId, player.id);
      await client.query(result.success ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Validate win conditions against persisted money and track, and record the
   * victory state if they hold.
   *
   * Player indexes count ALL of the game's players in `created_at` order,
   * soft-deleted included — the indexing `games.current_player_index` is
   * written with (see `lockPlayerForUserTurn`).
   */
  private static async declareVictoryWith(
    q: Queryable,
    gameId: string,
    playerId: string,
  ): Promise<DeclareVictoryResult> {
    // Get game state
    const gameResult = await q.query(
      `SELECT current_player_index, victory_triggered, victory_threshold,
              (SELECT COUNT(*) FROM players WHERE game_id = $1) as player_count
       FROM games WHERE id = $1`,
      [gameId]
    );

    if (gameResult.rows.length === 0) {
      return { success: false, error: 'Game not found' };
    }

    const game = gameResult.rows[0];

    // Check if victory already triggered
    if (game.victory_triggered) {
      return { success: false, error: 'Victory already declared' };
    }

    // Get player info
    const playerResult = await q.query(
      `SELECT p.id, p.money, p.debt_owed, p.name,
              (SELECT array_position(
                array(SELECT id FROM players WHERE game_id = $1 ORDER BY created_at),
                p.id
              ) - 1) as player_index
       FROM players p WHERE p.id = $2 AND p.game_id = $1 AND p.is_deleted = false`,
      [gameId, playerId]
    );

    if (playerResult.rows.length === 0) {
      return { success: false, error: 'Player not found' };
    }

    const player = playerResult.rows[0];
    const threshold = game.victory_threshold || VICTORY_INITIAL_THRESHOLD;
    // Claims are retained in the API for compatibility; only persisted data
    // establishes eligibility.
    const trackState = await TrackService.getTrackState(gameId, playerId);
    const evaluation = WinConditionsService.evaluate(
      player.money, player.debt_owed ?? 0, trackState?.segments ?? [], threshold,
    );
    const { netWorth } = evaluation;

    // Validate money threshold (net of debt)
    if (evaluation.unmetCondition === UnmetWinCondition.InsufficientFunds) {
      const debtInfo = player.debt_owed > 0 ? ` (${player.money}M cash - ${player.debt_owed}M debt)` : '';
      return {
        success: false,
        error: `Insufficient funds: ${netWorth}M${debtInfo} < ${threshold}M required`
      };
    }

    if (!evaluation.eligible) {
      return {
        success: false,
        error: `Only ${evaluation.connectedCities.length} connected major cities, need ${VICTORY_CITY_COUNT}`,
      };
    }

    // Calculate final turn player index (player before the one who triggered)
    const playerCount = parseInt(game.player_count);
    const triggerIndex = player.player_index;
    const finalTurnIndex = (triggerIndex - 1 + playerCount) % playerCount;

    // Update game with victory state
    await q.query(
      `UPDATE games
       SET victory_triggered = true,
           victory_trigger_player_index = $2,
           final_turn_player_index = $3
       WHERE id = $1`,
      [gameId, triggerIndex, finalTurnIndex]
    );

    const victoryState: VictoryState = {
      triggered: true,
      triggerPlayerIndex: triggerIndex,
      victoryThreshold: threshold,
      finalTurnPlayerIndex: finalTurnIndex,
    };

    return { success: true, victoryState, playerName: player.name };
  }

  /**
   * Check if the current turn is the final turn
   */
  static async isFinalTurn(gameId: string): Promise<boolean> {
    const result = await db.query(
      `SELECT current_player_index, victory_triggered, final_turn_player_index
       FROM games WHERE id = $1`,
      [gameId]
    );

    if (result.rows.length === 0) {
      return false;
    }

    const game = result.rows[0];
    return game.victory_triggered &&
           game.current_player_index === game.final_turn_player_index;
  }

  /**
   * Resolve the game after the final turn. Trusted entry point for server-side
   * callers (bots). HTTP callers must go through `resolveVictoryForUser`.
   */
  static async resolveVictory(gameId: string): Promise<ResolveVictoryResult> {
    const result = await VictoryService.resolveVictoryWith(db, gameId);
    if (result.gameOver) {
      // Game is over — release per-game in-memory state.
      await cleanupGameState(gameId);
    }
    return result;
  }

  /**
   * Resolve the final round on behalf of the calling user (issue #306).
   *
   * Only the player whose turn closes the final round may resolve it, and only
   * during that turn. In ONE transaction: confirms the game is active and it is
   * the user's turn (`lockPlayerForUserTurn`, game row held FOR UPDATE),
   * confirms a declaration is pending and this is the final turn, charges the
   * caller's unsettled build cost so their money is final, then resolves.
   *
   * @throws TurnGuardError when the user may not act right now.
   * @throws VictoryNotFinalTurnError when there is no final turn to resolve.
   */
  static async resolveVictoryForUser(
    gameId: string,
    userId: string,
  ): Promise<ResolveVictoryResult> {
    const client = await db.connect();
    let result: ResolveVictoryResult;
    try {
      await client.query('BEGIN');
      const { player, currentPlayerIndex } = await lockPlayerForUserTurn(client, gameId, userId);

      const flags = await client.query(
        'SELECT victory_triggered, final_turn_player_index FROM games WHERE id = $1',
        [gameId],
      );
      const game = flags.rows[0];
      if (
        game?.victory_triggered !== true ||
        Number(game.final_turn_player_index) !== currentPlayerIndex
      ) {
        throw new VictoryNotFinalTurnError();
      }

      await PlayerService.settleTurnBuildCost(client, gameId, player.id);
      result = await VictoryService.resolveVictoryWith(client, gameId);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    if (result.gameOver) {
      // Game is over — release per-game in-memory state (after the commit).
      await cleanupGameState(gameId);
    }
    return result;
  }

  /**
   * Determine the winner, extend the threshold on a tie, or resume normal play
   * when nobody qualifies. Does not release in-memory game state; the caller
   * does that once the result is durable.
   */
  private static async resolveVictoryWith(
    q: Queryable,
    gameId: string,
  ): Promise<ResolveVictoryResult> {
    const playersResult: {
      rows: Array<{
        id: string;
        name: string;
        money: number;
        debt_owed: number | null;
        net_worth: number;
      }>;
    } = await q.query(
      `SELECT p.id, p.name, p.money, p.debt_owed,
              (p.money - COALESCE(p.debt_owed, 0)) as net_worth
       FROM players p
       WHERE p.game_id = $1 AND p.is_deleted = false
       ORDER BY net_worth DESC`,
      [gameId]
    );

    const gameResult = await q.query(
      `SELECT victory_threshold FROM games WHERE id = $1`,
      [gameId]
    );

    const threshold = gameResult.rows[0]?.victory_threshold || VICTORY_INITIAL_THRESHOLD;

    // Preserve monetary ordering, but only admit players whose current track
    // also qualifies. Complete all reads before mutating the game.
    const candidates = playersResult.rows.filter(p => p.net_worth >= threshold);
    const evaluations = await Promise.all(candidates.map(async (player) => {
      const trackState = await TrackService.getTrackState(gameId, player.id);
      return WinConditionsService.evaluate(
        player.money, player.debt_owed ?? 0, trackState?.segments ?? [], threshold,
      );
    }));
    const eligiblePlayers = candidates.filter((_, index) => evaluations[index].eligible);

    if (eligiblePlayers.length === 0) {
      // Eligibility can be lost to events during the final round.
      await q.query(
        `UPDATE games
         SET victory_triggered = false,
             victory_trigger_player_index = -1,
             final_turn_player_index = -1
         WHERE id = $1`,
        [gameId],
      );
      return {
        gameOver: false,
        victoryState: {
          triggered: false,
          triggerPlayerIndex: -1,
          finalTurnPlayerIndex: -1,
          victoryThreshold: threshold,
        },
      };
    }

    // Check for ties at the top (by net worth)
    const topNetWorth = eligiblePlayers[0].net_worth;
    const tiedPlayers = eligiblePlayers.filter(p => p.net_worth === topNetWorth);

    if (tiedPlayers.length === 1) {
      // Clear winner
      const winner = tiedPlayers[0];
      await q.query(
        `UPDATE games SET status = 'completed', winner_id = $2 WHERE id = $1`,
        [gameId, winner.id]
      );

      return {
        gameOver: true,
        winnerId: winner.id,
        winnerName: winner.name,
      };
    }

    // Tie - extend threshold to 300M
    if (threshold < VICTORY_TIE_THRESHOLD) {
      await q.query(
        `UPDATE games
         SET victory_triggered = false,
             victory_trigger_player_index = -1,
             final_turn_player_index = -1,
             victory_threshold = $2
         WHERE id = $1`,
        [gameId, VICTORY_TIE_THRESHOLD]
      );

      return {
        gameOver: false,
        tieExtended: true,
        newThreshold: VICTORY_TIE_THRESHOLD,
      };
    }

    // Already at 300M threshold and still tied - most money wins anyway
    // (rare edge case - pick first in sorted order)
    const winner = tiedPlayers[0];
    await q.query(
      `UPDATE games SET status = 'completed', winner_id = $2 WHERE id = $1`,
      [gameId, winner.id]
    );

    return {
      gameOver: true,
      winnerId: winner.id,
      winnerName: winner.name,
    };
  }
}
