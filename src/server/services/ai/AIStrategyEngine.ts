/**
 * AIStrategyEngine — Top-level orchestrator for a bot's turn.
 *
 * Thin orchestrator that delegates to focused services in a 6-stage pipeline:
 *   1. WorldSnapshotService.capture()  — frozen game state
 *   2. ContextBuilder.build()          — decision-relevant context for LLM
 *   3. LLMStrategyBrain.decideAction() — LLM intent → ActionResolver → TurnPlan
 *   4. GuardrailEnforcer.checkPlan()   — hard safety rules
 *   5. TurnExecutor.executePlan()      — execute against DB
 *
 * LLMStrategyBrain handles retry loop + heuristic fallback internally.
 * AIStrategyEngine just orchestrates the stages and manages memory/logging.
 */

import { capture } from './WorldSnapshotService';
import { ContextBuilder } from './ContextBuilder';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { GuardrailEnforcer } from './GuardrailEnforcer';
import { TurnExecutor } from './TurnExecutor';
import { ActionResolver } from './ActionResolver';
import {
  WorldSnapshot,
  AIActionType,
  BotConfig,
  LLMProvider,
  BotSkillLevel,
  BotArchetype,
  LLMDecisionResult,
  TurnPlan,
} from '../../../shared/types/GameTypes';
import { db } from '../../db/index';
import { getMajorCityGroups, getMajorCityLookup } from '../../../shared/services/majorCityGroups';
import { gridToPixel } from './MapTopology';
import { getMemory, updateMemory } from './BotMemory';
import { initTurnLog, logPhase, flushTurnLog, LLMPhaseFields } from './DecisionLogger';

export interface BotTurnResult {
  action: AIActionType;
  segmentsBuilt: number;
  cost: number;
  durationMs: number;
  success: boolean;
  error?: string;
  movedTo?: { row: number; col: number };
  milepostsMoved?: number;
  trackUsageFee?: number;
  loadsPickedUp?: Array<{ loadType: string; city: string }>;
  loadsDelivered?: Array<{ loadType: string; city: string; payment: number; cardId: number }>;
  buildTargetCity?: string;
  // v6.3 fields
  reasoning?: string;
  planHorizon?: string;
  guardrailOverride?: boolean;
  guardrailReason?: string;
}

export class AIStrategyEngine {
  /**
   * Execute a complete bot turn via the 6-stage pipeline:
   *   1. WorldSnapshot.capture()
   *   2. ContextBuilder.build()
   *   3. LLMStrategyBrain.decideAction() (includes retry + heuristic fallback)
   *   4. GuardrailEnforcer.checkPlan()
   *   5. TurnExecutor.executePlan()
   *
   * Falls back to PassTurn on pipeline error.
   */
  static async takeTurn(gameId: string, botPlayerId: string): Promise<BotTurnResult> {
    const startTime = Date.now();
    const tag = `[AIStrategy ${gameId.slice(0, 8)}]`;

    // Load bot memory for state continuity across turns
    const memory = getMemory(gameId, botPlayerId);

    // Initialize decision logging for this turn
    initTurnLog(gameId, botPlayerId, memory.turnNumber + 1);

    try {
      // ── Stage 1: Capture world snapshot ──
      const snapshot = await capture(gameId, botPlayerId);
      console.log(`${tag} Snapshot: status=${snapshot.gameStatus}, money=${snapshot.bot.money}, segments=${snapshot.bot.existingSegments.length}, position=${snapshot.bot.position ? `${snapshot.bot.position.row},${snapshot.bot.position.col}` : 'none'}, loads=[${snapshot.bot.loads.join(',')}]`);

      // Auto-place bot if no position and has track
      if (!snapshot.bot.position && snapshot.bot.existingSegments.length > 0) {
        await AIStrategyEngine.autoPlaceBot(snapshot);
        const placed = snapshot.bot.position as { row: number; col: number } | null;
        console.log(`${tag} Auto-placed bot at ${placed ? `${placed.row},${placed.col}` : 'failed'}`);
      }

      const botConfig = snapshot.bot.botConfig as BotConfig | null;
      const skillLevel = (botConfig?.skillLevel as BotSkillLevel) ?? BotSkillLevel.Medium;
      const gridPoints = snapshot.hexGrid ?? [];

      // ── Stage 2: Build game context ──
      const context = await ContextBuilder.build(snapshot, skillLevel, gridPoints);
      console.log(`${tag} Context: canDeliver=${context.canDeliver.length}, canBuild=${context.canBuild}, canUpgrade=${context.canUpgrade}, reachable=${context.reachableCities.length} cities`);

      // ── Stage 3: LLM decides action ──
      // LLMStrategyBrain handles: prompt serialization → LLM call → parse →
      // ActionResolver.resolve → retry on failure → heuristic fallback
      let decision: LLMDecisionResult;
      if (AIStrategyEngine.hasLLMApiKey(botConfig)) {
        const brain = AIStrategyEngine.createBrain(botConfig!);
        decision = await brain.decideAction(snapshot, context);
      } else {
        // No LLM key — use heuristic fallback directly
        const fallback = await ActionResolver.heuristicFallback(context, snapshot);
        decision = {
          plan: fallback.plan ?? { type: AIActionType.PassTurn },
          reasoning: '[no API key] ' + (fallback.error || 'Heuristic fallback'),
          planHorizon: 'Immediate',
          model: 'heuristic',
          latencyMs: 0,
          retried: false,
        };
      }

      console.log(`${tag} Decision: plan=${decision.plan.type}, model=${decision.model}, latency=${decision.latencyMs}ms, retried=${decision.retried}`);

      // ── Stage 4: Apply guardrails ──
      const guardrailResult = GuardrailEnforcer.checkPlan(decision.plan, context, snapshot);
      const finalPlan: TurnPlan = guardrailResult.plan;

      if (guardrailResult.overridden) {
        console.log(`${tag} Guardrail override: ${guardrailResult.reason}`);
        decision.guardrailOverride = true;
      }

      // Log LLM decision phase
      const llmFields: LLMPhaseFields = {
        llmModel: decision.model,
        llmLatencyMs: decision.latencyMs,
        llmTokenUsage: decision.tokenUsage,
        llmReasoning: decision.reasoning,
        llmPlanHorizon: decision.planHorizon,
        wasGuardrailOverride: guardrailResult.overridden,
        guardrailReason: guardrailResult.reason,
      };
      logPhase('LLM Decision', [], null, null, llmFields);

      // ── Stage 5: Execute the plan ──
      const result = await TurnExecutor.executePlan(finalPlan, snapshot);

      // Log execution phase
      logPhase('Execution', [], null, result);

      const durationMs = Date.now() - startTime;

      // Determine action for result
      const executedAction = finalPlan.type === 'MultiAction'
        ? (finalPlan.steps[0]?.type as AIActionType ?? AIActionType.PassTurn)
        : (finalPlan.type as AIActionType);

      // Concise turn summary
      console.log(`${tag} Turn complete: ${finalPlan.type}${finalPlan.type === AIActionType.BuildTrack ? ` (${result.segmentsBuilt}seg/$${result.cost}M)` : ''} | success=${result.success} | money=${result.remainingMoney} | ${durationMs}ms`);

      // Update bot memory
      updateMemory(gameId, botPlayerId, {
        lastAction: executedAction,
        consecutivePassTurns: executedAction === AIActionType.PassTurn
          ? memory.consecutivePassTurns + 1 : 0,
        consecutiveDiscards: executedAction === AIActionType.DiscardHand
          ? memory.consecutiveDiscards + 1 : 0,
        turnNumber: snapshot.turnNumber,
      });

      flushTurnLog();

      return {
        action: result.action,
        segmentsBuilt: result.segmentsBuilt,
        cost: result.cost,
        durationMs,
        success: result.success,
        error: result.error,
        reasoning: decision.reasoning,
        planHorizon: decision.planHorizon,
        guardrailOverride: guardrailResult.overridden || undefined,
        guardrailReason: guardrailResult.reason,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      console.error(`${tag} PIPELINE ERROR (${durationMs}ms):`, error instanceof Error ? error.stack : error);

      // Update bot memory even on pipeline error
      updateMemory(gameId, botPlayerId, {
        lastAction: AIActionType.PassTurn,
        consecutivePassTurns: memory.consecutivePassTurns + 1,
        consecutiveDiscards: 0,
        turnNumber: memory.turnNumber + 1,
      });

      flushTurnLog();

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
   * Auto-place bot at a track endpoint that's at a major city milepost.
   * Prefers positions that are both on the track network AND at a city,
   * so the bot sprite doesn't appear at a disconnected city center.
   * Falls back to closest major city outpost if no track endpoint is at a city.
   */
  static async autoPlaceBot(snapshot: WorldSnapshot): Promise<void> {
    const majorCityLookup = getMajorCityLookup();

    // Prefer a track endpoint that's at a major city milepost (on the network)
    for (const seg of snapshot.bot.existingSegments) {
      for (const end of [seg.from, seg.to]) {
        const key = `${end.row},${end.col}`;
        if (majorCityLookup.has(key)) {
          const pixel = gridToPixel(end.row, end.col);
          await db.query(
            'UPDATE players SET position_row = $1, position_col = $2, position_x = $3, position_y = $4 WHERE id = $5',
            [end.row, end.col, pixel.x, pixel.y, snapshot.bot.playerId],
          );
          snapshot.bot.position = { row: end.row, col: end.col };
          return;
        }
      }
    }

    // Fallback: closest major city outpost to any track endpoint
    const groups = getMajorCityGroups();
    if (groups.length === 0) return;

    let bestPoint = groups[0].outposts[0] ?? groups[0].center;
    let bestDist = Infinity;

    for (const group of groups) {
      for (const point of [...group.outposts, group.center]) {
        for (const seg of snapshot.bot.existingSegments) {
          for (const end of [seg.from, seg.to]) {
            const dr = point.row - end.row;
            const dc = point.col - end.col;
            const dist = dr * dr + dc * dc;
            if (dist < bestDist) {
              bestDist = dist;
              bestPoint = point;
            }
          }
        }
      }
    }

    const pixel = gridToPixel(bestPoint.row, bestPoint.col);

    await db.query(
      'UPDATE players SET position_row = $1, position_col = $2, position_x = $3, position_y = $4 WHERE id = $5',
      [bestPoint.row, bestPoint.col, pixel.x, pixel.y, snapshot.bot.playerId],
    );

    snapshot.bot.position = { row: bestPoint.row, col: bestPoint.col };
  }

  /**
   * Check if the bot has LLM API key configured.
   * Returns false if no provider or no matching env var — falls back to heuristic.
   */
  private static hasLLMApiKey(botConfig: BotConfig | null): boolean {
    if (!botConfig) return false;
    const provider = (botConfig.provider as LLMProvider) ?? LLMProvider.Anthropic;
    const envKey = provider === LLMProvider.Google ? 'GOOGLE_AI_API_KEY' : 'ANTHROPIC_API_KEY';
    return !!process.env[envKey];
  }

  /**
   * Create an LLMStrategyBrain instance from bot config.
   */
  private static createBrain(botConfig: BotConfig): LLMStrategyBrain {
    const provider = (botConfig.provider as LLMProvider) ?? LLMProvider.Anthropic;
    const skillLevel = (botConfig.skillLevel as BotSkillLevel) ?? BotSkillLevel.Medium;
    const archetype = (botConfig.archetype as BotArchetype) ?? BotArchetype.Balanced;
    const envKey = provider === LLMProvider.Google ? 'GOOGLE_AI_API_KEY' : 'ANTHROPIC_API_KEY';
    const apiKey = process.env[envKey] ?? '';

    return new LLMStrategyBrain({
      archetype,
      skillLevel,
      provider,
      model: botConfig.model,
      apiKey,
      timeoutMs: skillLevel === BotSkillLevel.Easy ? 10000 : 15000,
      maxRetries: 1,
    });
  }
}
