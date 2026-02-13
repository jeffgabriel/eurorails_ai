/**
 * AIStrategyEngine — Top-level orchestrator for a bot's turn.
 *
 * Thin orchestrator that delegates to focused services:
 *   WorldSnapshotService → OptionGenerator → Scorer → PlanValidator → TurnExecutor
 *
 * Includes 3 retries with PassTurn fallback on failure.
 */

import { capture } from './WorldSnapshotService';
import { OptionGenerator } from './OptionGenerator';
import { Scorer } from './Scorer';
import { validate } from './PlanValidator';
import { TurnExecutor, ExecutionResult } from './TurnExecutor';
import {
  WorldSnapshot,
  FeasibleOption,
  AIActionType,
  BotConfig,
} from '../../../shared/types/GameTypes';
import { emitToGame } from '../socketService';
import { db } from '../../db/index';
import { getMajorCityGroups } from '../../../shared/services/majorCityGroups';
import { gridToPixel } from './MapTopology';

const MAX_RETRIES = 3;

export interface BotTurnResult {
  action: AIActionType;
  segmentsBuilt: number;
  cost: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export class AIStrategyEngine {
  /**
   * Execute a complete bot turn: snapshot → generate → score → validate → execute.
   * Falls back to PassTurn after MAX_RETRIES failures.
   */
  static async takeTurn(gameId: string, botPlayerId: string): Promise<BotTurnResult> {
    const startTime = Date.now();

    try {
      // 1. Capture world snapshot
      const snapshot = await capture(gameId, botPlayerId);

      // 2. Auto-place bot if no position and has track
      if (!snapshot.bot.position && snapshot.bot.existingSegments.length > 0) {
        await AIStrategyEngine.autoPlaceBot(snapshot);
      }

      // 3. Generate, score, validate, and execute with retries
      const botConfig = snapshot.bot.botConfig as BotConfig | null;
      const options = OptionGenerator.generate(snapshot);
      const scored = Scorer.score(options, snapshot, botConfig);

      // Try each option in score order
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const candidate = scored[attempt] ?? null;
        if (!candidate || !candidate.feasible) break;

        const validation = validate(candidate, snapshot);
        if (!validation.valid) continue;

        try {
          const result = await TurnExecutor.execute(candidate, snapshot);
          if (result.success) {
            const durationMs = Date.now() - startTime;
            return {
              action: result.action,
              segmentsBuilt: result.segmentsBuilt,
              cost: result.cost,
              durationMs,
              success: true,
            };
          }
        } catch {
          // Execution threw — try next option
        }
      }

      // All retries exhausted: fall back to PassTurn
      const passPlan: FeasibleOption = {
        action: AIActionType.PassTurn,
        feasible: true,
        reason: 'Fallback after retries',
      };
      const passResult = await TurnExecutor.execute(passPlan, snapshot);
      const durationMs = Date.now() - startTime;

      return {
        action: AIActionType.PassTurn,
        segmentsBuilt: 0,
        cost: 0,
        durationMs,
        success: passResult.success,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      return {
        action: AIActionType.PassTurn,
        segmentsBuilt: 0,
        cost: 0,
        durationMs,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Auto-place bot at the best major city when it has track but no position.
   * Picks the major city closest to the bot's existing track network.
   */
  static async autoPlaceBot(snapshot: WorldSnapshot): Promise<void> {
    const groups = getMajorCityGroups();
    if (groups.length === 0) return;

    // Find the major city closest to any existing track endpoint
    let bestCity = groups[0].center;
    let bestDist = Infinity;

    for (const group of groups) {
      for (const seg of snapshot.bot.existingSegments) {
        const dr = group.center.row - seg.to.row;
        const dc = group.center.col - seg.to.col;
        const dist = dr * dr + dc * dc;
        if (dist < bestDist) {
          bestDist = dist;
          bestCity = group.center;
        }
      }
    }

    const pixel = gridToPixel(bestCity.row, bestCity.col);

    await db.query(
      'UPDATE players SET position_row = $1, position_col = $2, position_x = $3, position_y = $4 WHERE id = $5',
      [bestCity.row, bestCity.col, pixel.x, pixel.y, snapshot.bot.playerId],
    );

    snapshot.bot.position = { row: bestCity.row, col: bestCity.col };
  }
}
