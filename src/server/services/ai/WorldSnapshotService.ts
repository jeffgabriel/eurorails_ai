/**
 * WorldSnapshotService — Captures a frozen game state for AI bot evaluation.
 *
 * Performs an optimized SQL query joining games, players, and player_tracks
 * to build a WorldSnapshot that the AI pipeline uses for decision-making.
 */

import { db } from '../../db/index';
import { WorldSnapshot, TrackSegment, GameStatus } from '../../../shared/types/GameTypes';

/**
 * Capture a frozen snapshot of the game world for AI evaluation.
 *
 * @param gameId - The game to snapshot
 * @param botPlayerId - The bot player making a decision
 * @returns A WorldSnapshot with all data needed for the AI pipeline
 */
export async function capture(gameId: string, botPlayerId: string): Promise<WorldSnapshot> {
  // Single query joining games, players, and player_tracks
  const result = await db.query(
    `
    SELECT
      g.status        AS game_status,
      p.id            AS player_id,
      p.money,
      p.position_row,
      p.position_col,
      p.train_type,
      p.hand,
      p.loads,
      p.is_bot,
      p.bot_config,
      p.current_turn_number,
      COALESCE(pt.segments, '[]'::jsonb) AS segments
    FROM games g
    JOIN players p ON p.game_id = g.id
    LEFT JOIN player_tracks pt ON pt.game_id = g.id AND pt.player_id = p.id
    WHERE g.id = $1
    ORDER BY p.created_at ASC
    `,
    [gameId],
  );

  if (result.rows.length === 0) {
    throw new Error(`No game found with id ${gameId}`);
  }

  const gameStatus = result.rows[0].game_status as GameStatus;

  // Find the bot player row
  const botRow = result.rows.find((r) => r.player_id === botPlayerId);
  if (!botRow) {
    throw new Error(`Bot player ${botPlayerId} not found in game ${gameId}`);
  }

  // Parse bot segments
  const botSegments = parseSegments(botRow.segments);

  // Parse bot config
  const rawConfig = typeof botRow.bot_config === 'string'
    ? JSON.parse(botRow.bot_config)
    : botRow.bot_config;

  const botConfig = rawConfig
    ? {
        skillLevel: rawConfig.skillLevel ?? 'medium',
        archetype: rawConfig.archetype ?? 'balanced',
        name: rawConfig.name,
      }
    : null;

  // Build all player tracks
  const allPlayerTracks = result.rows.map((row) => ({
    playerId: row.player_id as string,
    segments: parseSegments(row.segments),
  }));

  return {
    gameId,
    gameStatus,
    turnNumber: botRow.current_turn_number ?? 0,
    bot: {
      playerId: botPlayerId,
      money: botRow.money ?? 50,
      position:
        botRow.position_row != null && botRow.position_col != null
          ? { row: botRow.position_row, col: botRow.position_col }
          : null,
      existingSegments: botSegments,
      demandCards: Array.isArray(botRow.hand) ? botRow.hand : [],
      trainType: botRow.train_type ?? 'Freight',
      loads: Array.isArray(botRow.loads) ? botRow.loads : [],
      botConfig,
    },
    allPlayerTracks,
  };
}

/** Parse JSONB segments — handles both string and object forms from pg */
function parseSegments(raw: unknown): TrackSegment[] {
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as TrackSegment[];
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) return raw as TrackSegment[];
  return [];
}
