/**
 * TurnExecutor — Executes a validated AI bot plan against the database.
 *
 * Handles BuildTrack (save segments, deduct money, audit) and PassTurn (audit only).
 * All DB writes happen inside a single transaction. Socket events emit post-commit.
 */

import { db } from '../../db/index';
import {
  FeasibleOption,
  WorldSnapshot,
  AIActionType,
  PlayerTrackState,
} from '../../../shared/types/GameTypes';
import { TrackService } from '../trackService';
import { emitToGame } from '../socketService';

export interface ExecutionResult {
  success: boolean;
  action: AIActionType;
  cost: number;
  segmentsBuilt: number;
  durationMs: number;
  error?: string;
}

export class TurnExecutor {
  /**
   * Execute the chosen plan for the bot's turn.
   * Runs all DB mutations in a transaction; emits socket events after commit.
   */
  static async execute(
    plan: FeasibleOption,
    snapshot: WorldSnapshot,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    switch (plan.action) {
      case AIActionType.BuildTrack:
        return TurnExecutor.executeBuildTrack(plan, snapshot, startTime);
      case AIActionType.PassTurn:
        return TurnExecutor.executePassTurn(plan, snapshot, startTime);
      default:
        return {
          success: true,
          action: plan.action,
          cost: 0,
          segmentsBuilt: 0,
          durationMs: Date.now() - startTime,
        };
    }
  }

  private static async executeBuildTrack(
    plan: FeasibleOption,
    snapshot: WorldSnapshot,
    startTime: number,
  ): Promise<ExecutionResult> {
    const segments = plan.segments ?? [];
    const cost = plan.estimatedCost ?? segments.reduce((s, seg) => s + seg.cost, 0);
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      // 1. Save new track segments (append to existing)
      const allSegments = [...snapshot.bot.existingSegments, ...segments];
      const totalCost = allSegments.reduce((s, seg) => s + seg.cost, 0);
      const trackState: PlayerTrackState = {
        playerId: snapshot.bot.playerId,
        gameId: snapshot.gameId,
        segments: allSegments,
        totalCost,
        turnBuildCost: cost,
        lastBuildTimestamp: new Date(),
      };

      await TrackService.saveTrackState(snapshot.gameId, snapshot.bot.playerId, trackState);

      // 2. Deduct money from bot player
      await client.query(
        'UPDATE players SET money = money - $1 WHERE game_id = $2 AND id = $3',
        [cost, snapshot.gameId, snapshot.bot.playerId],
      );

      // 3. Insert audit record
      const durationMs = Date.now() - startTime;
      await client.query(
        `INSERT INTO bot_turn_audits (game_id, player_id, turn_number, action, segments_built, cost, remaining_money, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          snapshot.gameId,
          snapshot.bot.playerId,
          snapshot.turnNumber,
          AIActionType.BuildTrack,
          JSON.stringify(segments),
          cost,
          snapshot.bot.money - cost,
          durationMs,
        ],
      );

      await client.query('COMMIT');

      // 4. Emit socket events post-commit
      emitToGame(snapshot.gameId, 'track:updated', {
        playerId: snapshot.bot.playerId,
        segments: allSegments,
        totalCost,
        turnBuildCost: cost,
      });

      return {
        success: true,
        action: AIActionType.BuildTrack,
        cost,
        segmentsBuilt: segments.length,
        durationMs,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      const durationMs = Date.now() - startTime;
      return {
        success: false,
        action: AIActionType.BuildTrack,
        cost: 0,
        segmentsBuilt: 0,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      client.release();
    }
  }

  private static async executePassTurn(
    _plan: FeasibleOption,
    snapshot: WorldSnapshot,
    startTime: number,
  ): Promise<ExecutionResult> {
    const durationMs = Date.now() - startTime;

    // Insert audit record (no transaction needed for single insert)
    await db.query(
      `INSERT INTO bot_turn_audits (game_id, player_id, turn_number, action, cost, remaining_money, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        snapshot.gameId,
        snapshot.bot.playerId,
        snapshot.turnNumber,
        AIActionType.PassTurn,
        0,
        snapshot.bot.money,
        durationMs,
      ],
    );

    return {
      success: true,
      action: AIActionType.PassTurn,
      cost: 0,
      segmentsBuilt: 0,
      durationMs,
    };
  }
}
