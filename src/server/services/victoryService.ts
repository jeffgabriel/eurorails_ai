import { db } from '../db';
import { VictoryState, VICTORY_INITIAL_THRESHOLD, VICTORY_TIE_THRESHOLD, VICTORY_CITY_COUNT } from '../../shared/types/GameTypes';
import { TrackService } from './trackService';
import { TrackSegment } from '../../shared/types/TrackTypes';
import { cleanupGameState } from './gameCleanupService';
import { WinConditionsService, UnmetWinCondition } from './winConditionsService';
import type { MajorCityCoordinate } from './winConditionsService';

export type { MajorCityCoordinate } from './winConditionsService';

export interface DeclareVictoryResult {
  success: boolean;
  error?: string;
  victoryState?: VictoryState;
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
   * Declare victory for a player
   * Validates conditions and triggers victory state if valid
   */
  static async declareVictory(
    gameId: string,
    playerId: string,
    _claimedCities: MajorCityCoordinate[]
  ): Promise<DeclareVictoryResult> {
    // Get game state
    const gameResult = await db.query(
      `SELECT current_player_index, victory_triggered, victory_threshold,
              (SELECT COUNT(*) FROM players WHERE game_id = $1 AND is_deleted = false) as player_count
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
    const playerResult = await db.query(
      `SELECT p.id, p.money, p.debt_owed, p.name,
              (SELECT array_position(
                array(SELECT id FROM players WHERE game_id = $1 AND is_deleted = false ORDER BY created_at),
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
    await db.query(
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

    return { success: true, victoryState };
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
   * Resolve the game after final turn
   * Determines winner or extends threshold on tie
   */
  static async resolveVictory(gameId: string): Promise<ResolveVictoryResult> {
    const playersResult = await db.query<{
      id: string;
      name: string;
      money: number;
      debt_owed: number | null;
      net_worth: number;
    }>(
      `SELECT p.id, p.name, p.money, p.debt_owed,
              (p.money - COALESCE(p.debt_owed, 0)) as net_worth
       FROM players p
       WHERE p.game_id = $1 AND p.is_deleted = false
       ORDER BY net_worth DESC`,
      [gameId]
    );

    const gameResult = await db.query(
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
      await db.query(
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
      await db.query(
        `UPDATE games SET status = 'completed', winner_id = $2 WHERE id = $1`,
        [gameId, winner.id]
      );

      // Game is over — release per-game in-memory state.
      await cleanupGameState(gameId);

      return {
        gameOver: true,
        winnerId: winner.id,
        winnerName: winner.name,
      };
    }

    // Tie - extend threshold to 300M
    if (threshold < VICTORY_TIE_THRESHOLD) {
      await db.query(
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
    await db.query(
      `UPDATE games SET status = 'completed', winner_id = $2 WHERE id = $1`,
      [gameId, winner.id]
    );

    // Game is over — release per-game in-memory state.
    await cleanupGameState(gameId);

    return {
      gameOver: true,
      winnerId: winner.id,
      winnerName: winner.name,
    };
  }
}
