import type { StrategyAudit, TurnPlan, TurnPlanAction, FeasibleOption, ExecutionResult } from '../../../shared/types/AITypes';
import { AIActionType } from '../../../shared/types/AITypes';
import type { AIDifficulty, AIArchetype } from '../../../shared/types/AITypes';
import { WorldSnapshotService, PathCache } from './WorldSnapshotService';
import { OptionGenerator } from './OptionGenerator';
import { Scorer, ScoredOption } from './Scorer';
import { PlanValidator } from './PlanValidator';
import { TurnExecutor, TurnExecutionResult } from './TurnExecutor';
import { getSkillProfile } from './config/skillProfiles';
import { getArchetypeProfile } from './config/archetypeProfiles';
import { db } from '../../db/index';
import { emitToGame } from '../socketService';

const MAX_RETRIES = 3;

/**
 * Top-level orchestrator for the AI turn pipeline.
 *
 * Coordinates: Snapshot → OptionGeneration → Scoring → PlanValidation → Execution
 * with retry logic and safe fallback on failure.
 */
export class AIStrategyEngine {
  /**
   * Execute a full AI turn for the given bot player.
   *
   * 1. Retrieves bot config (difficulty, archetype) from DB
   * 2. Captures a WorldSnapshot
   * 3. Generates feasible options
   * 4. Scores and selects the best plan
   * 5. Validates the plan
   * 6. Executes the plan (with up to 3 retries on failure)
   * 7. Falls back to PassTurn if all retries fail
   * 8. Logs a StrategyAudit to the ai_turn_audits table
   *
   * @param gameId - The game ID
   * @param playerId - The bot's player ID
   * @returns A StrategyAudit with full decision record
   */
  static async executeTurn(
    gameId: string,
    playerId: string,
  ): Promise<StrategyAudit> {
    const turnStart = Date.now();

    // Emit thinking event
    emitToGame(gameId, 'ai:thinking', { playerId, timestamp: Date.now() });

    // 1. Get bot config from DB
    const { difficulty, archetype, turnNumber } = await this.getBotConfig(gameId, playerId);
    const skillProfile = getSkillProfile(difficulty);
    const archetypeProfile = getArchetypeProfile(archetype);

    // 2. Capture snapshot
    const snapshotStart = Date.now();
    const snapshot = await WorldSnapshotService.capture(gameId, playerId);
    const pathCache = new PathCache();
    const snapshotMs = Date.now() - snapshotStart;
    console.log(
      `[BOT:DEBUG] Snapshot captured for ${playerId} | Hash: ${snapshot.snapshotHash} | Duration: ${snapshotMs}ms`,
    );

    // 3. Generate options (with path cache for efficient reachability)
    const optionStart = Date.now();
    const allOptions = OptionGenerator.generate(snapshot, pathCache);
    const optionGenerationMs = Date.now() - optionStart;
    console.log(
      `[BOT:DEBUG] Options generated | Total: ${allOptions.length} | Cache hits: ${pathCache.size} entries | Duration: ${optionGenerationMs}ms`,
    );

    const feasibleOptions = allOptions.filter(o => o.feasible);
    const infeasibleOptions = allOptions.filter(o => !o.feasible);

    // 4. Score feasible options
    const scoringStart = Date.now();
    const scored = Scorer.score(feasibleOptions, snapshot, skillProfile, archetypeProfile);
    const scoringMs = Date.now() - scoringStart;
    console.log(
      `[BOT:DEBUG] Scoring complete | Scored: ${scored.length} options | Top score: ${scored[0]?.finalScore ?? 0} | Duration: ${scoringMs}ms`,
    );

    // 5-6. Plan, validate, execute with retries
    const executionStart = Date.now();
    let executionResults: ExecutionResult[] = [];
    let selectedPlan: TurnPlan | null = null;
    let finalResult: 'success' | 'retry' | 'fallback' | 'timeout' = 'success';
    let excludedOptionIds = new Set<string>();

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Filter out previously excluded options and re-select
      const availableScored = scored.filter(s => !excludedOptionIds.has(s.id));
      const bestOption = Scorer.selectBest(availableScored);

      if (!bestOption) {
        // No options left to try, go to fallback
        finalResult = 'retry';
        break;
      }

      // Build a TurnPlan from the selected option
      selectedPlan = this.buildPlan(bestOption, difficulty, archetype);

      // Validate the plan
      const validation = PlanValidator.validate(selectedPlan, snapshot);
      if (!validation.ok) {
        console.warn(
          `[BOT:WARN] Plan validation failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${validation.reason}`,
        );
        excludedOptionIds.add(bestOption.id);
        finalResult = 'retry';
        continue;
      }

      // Execute the plan
      const execResult = await TurnExecutor.execute(selectedPlan, gameId, playerId);

      executionResults = selectedPlan.actions.map((action, i) => {
        const actionResult = execResult.actionResults[i];
        return {
          actionType: action.type,
          success: actionResult?.success ?? false,
          error: actionResult?.error,
          durationMs: actionResult?.durationMs ?? 0,
        };
      });

      if (execResult.success) {
        finalResult = 'success';
        break;
      }

      // Execution failed — exclude this option and retry
      console.warn(
        `[BOT:WARN] Execution failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${execResult.error}`,
      );
      excludedOptionIds.add(bestOption.id);
      finalResult = 'retry';
    }

    // If all retries failed, execute safe fallback (PassTurn)
    if (finalResult === 'retry') {
      console.warn('[BOT:WARN] All retries exhausted, executing safe fallback (PassTurn)');
      finalResult = 'fallback';
      selectedPlan = this.buildFallbackPlan(difficulty, archetype);
      const fallbackResult = await TurnExecutor.execute(selectedPlan, gameId, playerId);
      executionResults = [{
        actionType: AIActionType.PassTurn,
        success: fallbackResult.success,
        error: fallbackResult.error,
        durationMs: fallbackResult.totalDurationMs,
      }];
    }

    const executionMs = Date.now() - executionStart;
    const totalMs = Date.now() - turnStart;

    // Build audit
    const audit: StrategyAudit = {
      snapshotHash: snapshot.snapshotHash,
      allOptions,
      scores: scored.map(s => s.finalScore),
      selectedPlan: selectedPlan!,
      executionResults,
      timing: {
        snapshotMs,
        optionGenerationMs,
        scoringMs,
        executionMs,
        totalMs,
      },
    };

    // Log audit to database
    await this.logAudit(
      gameId,
      playerId,
      turnNumber,
      audit,
      feasibleOptions.length,
      infeasibleOptions.length,
      finalResult,
    );

    // Emit turn complete
    emitToGame(gameId, 'ai:turn-complete', {
      playerId,
      result: finalResult,
      totalMs,
      timestamp: Date.now(),
    });

    console.log(
      `[BOT:INFO] Turn ${turnNumber} complete for ${playerId} | ` +
      `Result: ${finalResult} | Duration: ${totalMs}ms | ` +
      `Options: ${feasibleOptions.length} feasible, ${infeasibleOptions.length} infeasible`,
    );

    return audit;
  }

  /**
   * Retrieve the bot's AI config from the database.
   */
  private static async getBotConfig(
    gameId: string,
    playerId: string,
  ): Promise<{ difficulty: AIDifficulty; archetype: AIArchetype; turnNumber: number }> {
    const result = await db.query(
      `SELECT ai_difficulty, ai_archetype, current_turn_number
       FROM players
       WHERE game_id = $1 AND id = $2 AND is_ai = true`,
      [gameId, playerId],
    );

    if (result.rows.length === 0) {
      throw new Error(`AI player ${playerId} not found in game ${gameId}`);
    }

    const row = result.rows[0];
    return {
      difficulty: row.ai_difficulty as AIDifficulty,
      archetype: row.ai_archetype as AIArchetype,
      turnNumber: Number(row.current_turn_number ?? 1),
    };
  }

  /**
   * Build a TurnPlan from a scored option.
   * Wraps the option into the TurnPlan structure.
   */
  private static buildPlan(
    option: ScoredOption,
    difficulty: AIDifficulty,
    archetype: AIArchetype,
  ): TurnPlan {
    const action: TurnPlanAction = {
      type: option.type,
      parameters: { ...option.parameters },
    };

    return {
      actions: [action],
      expectedOutcome: {
        cashChange: (option.parameters.payment as number) || 0,
        loadsDelivered: option.type === AIActionType.DeliverLoad ? 1 : 0,
        trackSegmentsBuilt: option.type === AIActionType.BuildTrack || option.type === AIActionType.BuildTowardMajorCity ? 1 : 0,
        newMajorCitiesConnected: 0,
      },
      totalScore: option.finalScore,
      archetype,
      skillLevel: difficulty,
    };
  }

  /**
   * Build a safe fallback plan (PassTurn).
   */
  private static buildFallbackPlan(
    difficulty: AIDifficulty,
    archetype: AIArchetype,
  ): TurnPlan {
    return {
      actions: [{ type: AIActionType.PassTurn, parameters: {} }],
      expectedOutcome: {
        cashChange: 0,
        loadsDelivered: 0,
        trackSegmentsBuilt: 0,
        newMajorCitiesConnected: 0,
      },
      totalScore: 0,
      archetype,
      skillLevel: difficulty,
    };
  }

  /**
   * Log a StrategyAudit to the ai_turn_audits table.
   */
  private static async logAudit(
    gameId: string,
    playerId: string,
    turnNumber: number,
    audit: StrategyAudit,
    feasibleCount: number,
    infeasibleCount: number,
    result: 'success' | 'retry' | 'fallback' | 'timeout',
  ): Promise<void> {
    try {
      const selectedType = audit.selectedPlan?.actions[0]?.type || 'PassTurn';
      const selectedScore = audit.selectedPlan?.totalScore ?? 0;

      await db.query(
        `INSERT INTO ai_turn_audits (
           game_id, player_id, turn_number, snapshot_hash,
           feasible_options_count, infeasible_options_count,
           selected_option_type, selected_option_score,
           execution_result, duration_ms, audit_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          gameId,
          playerId,
          turnNumber,
          audit.snapshotHash,
          feasibleCount,
          infeasibleCount,
          selectedType,
          selectedScore,
          result,
          audit.timing.totalMs,
          JSON.stringify(audit),
        ],
      );
    } catch (error) {
      // Log but don't fail the turn if audit logging fails
      console.error('[BOT:ERROR] Failed to log audit:', error);
    }
  }
}
