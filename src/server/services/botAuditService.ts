import { db } from '../db';
import type { StrategyAudit } from '../ai/types';

export class BotAuditService {
  /**
   * Save a bot turn audit to the database.
   */
  static async saveTurnAudit(
    gameId: string,
    playerId: string,
    audit: StrategyAudit,
  ): Promise<void> {
    await db.query(
      `INSERT INTO bot_turn_audits
        (game_id, player_id, turn_number, archetype_name, skill_level,
         snapshot_hash, current_plan, archetype_rationale,
         feasible_options, rejected_options, selected_plan, execution_result,
         bot_status, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        gameId,
        playerId,
        audit.turnNumber,
        audit.archetypeName,
        audit.skillLevel,
        audit.snapshotHash,
        audit.currentPlan,
        audit.archetypeRationale,
        JSON.stringify(audit.feasibleOptions),
        JSON.stringify(audit.rejectedOptions),
        JSON.stringify(audit.selectedPlan),
        JSON.stringify(audit.executionResult),
        JSON.stringify(audit.botStatus),
        audit.durationMs,
      ],
    );
  }

  /**
   * Get the latest audit for a bot player in a game.
   */
  static async getLatestAudit(
    gameId: string,
    playerId: string,
  ): Promise<StrategyAudit | null> {
    const result = await db.query(
      `SELECT turn_number, archetype_name, skill_level, snapshot_hash,
              current_plan, archetype_rationale, feasible_options, rejected_options,
              selected_plan, execution_result, bot_status, duration_ms
       FROM bot_turn_audits
       WHERE game_id = $1 AND player_id = $2
       ORDER BY turn_number DESC
       LIMIT 1`,
      [gameId, playerId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return BotAuditService.rowToStrategyAudit(result.rows[0]);
  }

  /**
   * Transform a database row into a StrategyAudit object.
   */
  private static rowToStrategyAudit(row: Record<string, unknown>): StrategyAudit {
    return {
      turnNumber: row.turn_number as number,
      archetypeName: row.archetype_name as string,
      skillLevel: row.skill_level as StrategyAudit['skillLevel'],
      snapshotHash: row.snapshot_hash as string,
      currentPlan: row.current_plan as string,
      archetypeRationale: row.archetype_rationale as string,
      feasibleOptions: row.feasible_options as StrategyAudit['feasibleOptions'],
      rejectedOptions: row.rejected_options as StrategyAudit['rejectedOptions'],
      selectedPlan: row.selected_plan as StrategyAudit['selectedPlan'],
      executionResult: row.execution_result as StrategyAudit['executionResult'],
      botStatus: row.bot_status as StrategyAudit['botStatus'],
      durationMs: row.duration_ms as number,
    };
  }
}
