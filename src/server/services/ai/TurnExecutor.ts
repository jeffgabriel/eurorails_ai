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
} from '../../../shared/types/GameTypes';
import { emitToGame, emitStatePatch } from '../socketService';

export interface ExecutionResult {
  success: boolean;
  action: AIActionType;
  cost: number;
  segmentsBuilt: number;
  remainingMoney: number;
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
        return TurnExecutor.handleBuildTrack(plan, snapshot, startTime);
      case AIActionType.PassTurn:
        return TurnExecutor.handlePassTurn(snapshot, startTime);
      default:
        return {
          success: true,
          action: plan.action,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: snapshot.bot.money,
          durationMs: Date.now() - startTime,
        };
    }
  }

  /**
   * BuildTrack: save track, deduct money, insert audit — all in one transaction.
   * Emit socket events only after successful commit.
   */
  private static async handleBuildTrack(
    plan: FeasibleOption,
    snapshot: WorldSnapshot,
    startTime: number,
  ): Promise<ExecutionResult> {
    const newSegments = plan.segments ?? [];
    const cost = plan.estimatedCost ?? newSegments.reduce((s, seg) => s + seg.cost, 0);
    const allSegments = [...snapshot.bot.existingSegments, ...newSegments];
    const totalCost = allSegments.reduce((s, seg) => s + seg.cost, 0);

    const client = await db.connect();
    let remainingMoney = snapshot.bot.money - cost;

    try {
      await client.query('BEGIN');

      // 1. Save track state (UPSERT directly — avoids TrackService's separate transaction)
      await client.query(
        `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost, last_build_timestamp)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (game_id, player_id)
         DO UPDATE SET segments = $3, total_cost = $4, turn_build_cost = $5, last_build_timestamp = NOW()`,
        [snapshot.gameId, snapshot.bot.playerId, JSON.stringify(allSegments), totalCost, cost],
      );

      // 2. Deduct money from bot player
      const moneyResult = await client.query(
        'UPDATE players SET money = money - $1 WHERE id = $2 RETURNING money',
        [cost, snapshot.bot.playerId],
      );
      remainingMoney = moneyResult.rows[0]?.money ?? remainingMoney;

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
          JSON.stringify(newSegments),
          cost,
          remainingMoney,
          durationMs,
        ],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // 4. Emit socket events AFTER successful commit
    emitToGame(snapshot.gameId, 'track:updated', {
      gameId: snapshot.gameId,
      playerId: snapshot.bot.playerId,
      timestamp: Date.now(),
    });

    await emitStatePatch(snapshot.gameId, {
      players: [{ id: snapshot.bot.playerId, money: remainingMoney } as any],
    });

    const durationMs = Date.now() - startTime;
    return {
      success: true,
      action: AIActionType.BuildTrack,
      cost,
      segmentsBuilt: newSegments.length,
      remainingMoney,
      durationMs,
    };
  }

  /**
   * PassTurn: insert audit record only, no track or money changes.
   */
  private static async handlePassTurn(
    snapshot: WorldSnapshot,
    startTime: number,
  ): Promise<ExecutionResult> {
    const durationMs = Date.now() - startTime;

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
      remainingMoney: snapshot.bot.money,
      durationMs,
    };
  }
}
