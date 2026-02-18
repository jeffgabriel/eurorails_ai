/**
 * AIStrategyEngine — Top-level orchestrator for a bot's turn.
 *
 * Thin orchestrator that delegates to focused services:
 *   WorldSnapshotService → OptionGenerator → LLMStrategyBrain → PlanValidator → TurnExecutor
 *
 * Turn phases:
 *   Phase 0: Immediate delivery/pickup at current position (heuristic via Scorer)
 *   LLM Decision Point: single call selects both movement and build options
 *   Phase 1: Movement (LLM-selected or heuristic fallback)
 *   Phase 1.5: Post-movement delivery/pickup (heuristic via Scorer)
 *   Phase 2: Building (LLM-selected or heuristic fallback)
 *
 * Includes 3 retries with PassTurn fallback on failure.
 */

import { capture } from './WorldSnapshotService';
import { OptionGenerator, DemandChain } from './OptionGenerator';
import { Scorer } from './Scorer';
import { validate } from './PlanValidator';
import { TurnExecutor } from './TurnExecutor';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { PlanExecutor } from './PlanExecutor';
import { GameStateSerializer } from './GameStateSerializer';
import { ResponseParser } from './ResponseParser';
import { getPlanSelectionPrompt } from './prompts/systemPrompts';
import {
  WorldSnapshot,
  FeasibleOption,
  AIActionType,
  BotConfig,
  LLMProvider,
  BotSkillLevel,
  BotArchetype,
  LLMSelectionResult,
  DeliveryPlan,
  BotMemoryState,
} from '../../../shared/types/GameTypes';
import { db } from '../../db/index';
import { getMajorCityGroups, getFerryEdges } from '../../../shared/services/majorCityGroups';
import { gridToPixel, loadGridPoints } from './MapTopology';
import { getMemory, updateMemory } from './BotMemory';
import { initTurnLog, logPhase, flushTurnLog, LLMPhaseFields } from './DecisionLogger';

const MAX_RETRIES = 3;

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
}

export class AIStrategyEngine {
  /**
   * Execute a complete bot turn with multi-action sequencing:
   *   Phase 0: immediate deliver/pickup at current position
   *   Phase 1: movement
   *   Phase 1.5: post-movement deliver/pickup at new position
   *   Phase 2: building
   * Falls back to PassTurn after MAX_RETRIES failures.
   */
  static async takeTurn(gameId: string, botPlayerId: string): Promise<BotTurnResult> {
    const startTime = Date.now();
    const tag = `[AIStrategy ${gameId.slice(0, 8)}]`;

    // Accumulators for load actions across all phases
    const loadsPickedUp: Array<{ loadType: string; city: string }> = [];
    const loadsDelivered: Array<{ loadType: string; city: string; payment: number; cardId: number }> = [];

    // Load bot memory for state continuity across turns
    const memory = getMemory(gameId, botPlayerId);

    // Initialize decision logging for this turn
    initTurnLog(gameId, botPlayerId, memory.turnNumber + 1);

    try {
      // 1. Capture world snapshot
      let snapshot = await capture(gameId, botPlayerId);
      console.log(`${tag} Snapshot: status=${snapshot.gameStatus}, money=${snapshot.bot.money}, segments=${snapshot.bot.existingSegments.length}, position=${snapshot.bot.position ? `${snapshot.bot.position.row},${snapshot.bot.position.col}` : 'none'}, loads=[${snapshot.bot.loads.join(',')}]`);

      // 2. Auto-place bot if no position and has track
      if (!snapshot.bot.position && snapshot.bot.existingSegments.length > 0) {
        await AIStrategyEngine.autoPlaceBot(snapshot);
        const placed = snapshot.bot.position as { row: number; col: number } | null;
        console.log(`${tag} Auto-placed bot at ${placed ? `${placed.row},${placed.col}` : 'failed'}`);
      }

      const botConfig = snapshot.bot.botConfig as BotConfig | null;

      // ── Ferry crossing: if bot is at a ferry port, cross if beneficial ──
      if (snapshot.bot.position && snapshot.gameStatus === 'active') {
        const ferryCrossed = await AIStrategyEngine.handleFerryCrossing(snapshot, tag);
        if (ferryCrossed) {
          snapshot = await capture(gameId, botPlayerId);
          snapshot.bot.ferryHalfSpeed = true;
          console.log(`${tag} Ferry crossed — now at ${snapshot.bot.position?.row},${snapshot.bot.position?.col}, half speed this turn`);
        }
      }

      // ── Phase 0: Immediate delivery/pickup/drop at current position ──
      if (snapshot.bot.position && snapshot.gameStatus === 'active') {
        const phase0Result = await AIStrategyEngine.executeLoadActions(
          snapshot, botConfig, tag, 'Phase 0',
        );
        loadsDelivered.push(...phase0Result.delivered);
        loadsPickedUp.push(...phase0Result.pickedUp);

        // Re-capture snapshot if any state-mutating actions occurred
        if (phase0Result.stateChanged) {
          snapshot = await capture(gameId, botPlayerId);
        }

        logPhase('Phase 0', [], null, null);
      }

      // ── Plan Resolution: check active plan or consult LLM for new plan ──
      const moveActions = new Set([AIActionType.MoveTrain]);
      const buildActions = new Set([AIActionType.BuildTrack, AIActionType.UpgradeTrain, AIActionType.DiscardHand, AIActionType.PassTurn]);

      const moveOptions = (snapshot.bot.position && snapshot.gameStatus === 'active')
        ? OptionGenerator.generate(snapshot, moveActions).filter(o => o.feasible)
        : [];
      const buildOptions = OptionGenerator.generate(snapshot, buildActions, memory);

      let llmResult: LLMSelectionResult | null = null;
      let llmFields: LLMPhaseFields | undefined;
      const hasLLMConfig = AIStrategyEngine.hasLLMApiKey(botConfig);

      // Plan-then-execute: check if we have a valid active plan
      let planMoveChoice: FeasibleOption | null = null;
      let planBuildChoice: FeasibleOption | null = null;
      let usedPlan = false;

      if (snapshot.gameStatus === 'active' && memory.activePlan) {
        const planValid = AIStrategyEngine.validatePlan(memory.activePlan, snapshot, memory);
        if (planValid) {
          console.log(`${tag} Executing active plan: ${memory.activePlan.loadType} ${memory.activePlan.pickupCity}→${memory.activePlan.deliveryCity} (phase=${memory.activePlan.phase}, turn ${memory.turnsOnPlan})`);
          const planResult = PlanExecutor.executePlan(
            memory.activePlan, snapshot, moveOptions, buildOptions, memory,
          );

          // Update plan in memory
          if (planResult.planComplete) {
            console.log(`${tag} Plan completed: ${memory.activePlan.loadType}→${memory.activePlan.deliveryCity}`);
            updateMemory(gameId, botPlayerId, {
              activePlan: null,
              turnsOnPlan: 0,
              planHistory: [...memory.planHistory, {
                plan: memory.activePlan,
                outcome: 'delivered',
                turns: memory.turnsOnPlan,
              }],
            });
          } else {
            updateMemory(gameId, botPlayerId, {
              activePlan: planResult.updatedPlan,
              turnsOnPlan: memory.turnsOnPlan + 1,
              currentBuildTarget: planResult.updatedPlan.phase.startsWith('build')
                ? (planResult.updatedPlan.phase.includes('pickup') ? planResult.updatedPlan.pickupCity : planResult.updatedPlan.deliveryCity)
                : memory.currentBuildTarget,
            });
          }

          planMoveChoice = planResult.moveChoice;
          planBuildChoice = planResult.buildChoice;
          usedPlan = !planResult.planComplete;

          llmFields = { llmReasoning: `[plan] ${memory.activePlan.reasoning}` };
        } else {
          // Plan invalid — abandon and re-plan
          console.log(`${tag} Plan invalidated, abandoning: ${memory.activePlan.loadType}→${memory.activePlan.deliveryCity}`);
          updateMemory(gameId, botPlayerId, {
            activePlan: null,
            turnsOnPlan: 0,
            planHistory: [...memory.planHistory, {
              plan: memory.activePlan,
              outcome: 'abandoned',
              turns: memory.turnsOnPlan,
            }],
          });
        }
      }

      // If no valid plan and LLM is available, try to create a new plan via LLM
      if (!usedPlan && hasLLMConfig && snapshot.gameStatus === 'active') {
        try {
          const newPlan = await AIStrategyEngine.selectNewPlan(snapshot, memory, botConfig!, tag);
          if (newPlan) {
            console.log(`${tag} New plan created: ${newPlan.loadType} ${newPlan.pickupCity}→${newPlan.deliveryCity} (${newPlan.payment}M)`);
            const updatedMemory = getMemory(gameId, botPlayerId);
            updateMemory(gameId, botPlayerId, {
              activePlan: newPlan,
              turnsOnPlan: 0,
              currentBuildTarget: newPlan.pickupCity,
            });

            // Execute the new plan immediately
            const planResult = PlanExecutor.executePlan(
              newPlan, snapshot, moveOptions, buildOptions, { ...updatedMemory, activePlan: newPlan, turnsOnPlan: 0 },
            );
            planMoveChoice = planResult.moveChoice;
            planBuildChoice = planResult.buildChoice;
            usedPlan = true;

            updateMemory(gameId, botPlayerId, {
              activePlan: planResult.planComplete ? null : planResult.updatedPlan,
              turnsOnPlan: planResult.planComplete ? 0 : 1,
            });

            llmFields = { llmReasoning: `[new plan] ${newPlan.reasoning}` };
          }
        } catch (planError) {
          console.warn(`${tag} Plan selection failed, falling back to per-turn LLM:`, planError instanceof Error ? planError.message : planError);
        }
      }

      // Fallback: per-turn LLM selection (initialBuild, or plan creation failed)
      if (!usedPlan && hasLLMConfig && (snapshot.gameStatus === 'active' || snapshot.gameStatus === 'initialBuild')) {
        try {
          const brain = AIStrategyEngine.createBrain(botConfig!);
          llmResult = await brain.selectOptions(snapshot, moveOptions, buildOptions, memory);
          console.log(`${tag} LLM decision: move=${llmResult.moveOptionIndex}, build=${llmResult.buildOptionIndex}, model=${llmResult.model}, latency=${llmResult.latencyMs}ms, guardrail=${llmResult.wasGuardrailOverride}`);

          llmFields = {
            llmModel: llmResult.model,
            llmLatencyMs: llmResult.latencyMs,
            llmTokenUsage: llmResult.tokenUsage,
            llmReasoning: llmResult.reasoning,
            llmPlanHorizon: llmResult.planHorizon,
            wasGuardrailOverride: llmResult.wasGuardrailOverride,
            guardrailReason: llmResult.guardrailReason,
          };
        } catch (llmError) {
          console.warn(`${tag} LLM decision failed, falling back to heuristic:`, llmError instanceof Error ? llmError.message : llmError);
          llmFields = { wasFallback: true, fallbackReason: llmError instanceof Error ? llmError.message : 'Unknown error' };
        }
      }

      // ── Phase 1: Movement ──────────────────────────────────────────────
      let moveResult: { movedTo?: { row: number; col: number }; milepostsMoved?: number; trackUsageFee?: number } = {};
      let phase1Chosen: FeasibleOption | null = null;

      if (snapshot.bot.position && snapshot.gameStatus === 'active' && moveOptions.length > 0) {
        try {
          // Build ordered candidate list: plan choice or LLM choice first, then heuristic-scored fallbacks
          let moveCandidates: FeasibleOption[];
          if (usedPlan && planMoveChoice) {
            // Plan-selected move first, then heuristic fallbacks
            const scored = Scorer.score([...moveOptions], snapshot, botConfig);
            moveCandidates = [planMoveChoice, ...scored.filter(o => o !== planMoveChoice)];
          } else {
            moveCandidates = AIStrategyEngine.buildOrderedCandidates(
              moveOptions, llmResult?.moveOptionIndex ?? -1, snapshot, botConfig,
            );
          }

          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const candidate = moveCandidates[attempt] ?? null;
            if (!candidate || !candidate.feasible) break;

            const validation = validate(candidate, snapshot);
            if (!validation.valid) continue;

            try {
              const result = await TurnExecutor.execute(candidate, snapshot);
              if (result.success) {
                phase1Chosen = candidate;
                const dest = candidate.movementPath?.[candidate.movementPath.length - 1];
                if (dest) {
                  snapshot.bot.position = { row: dest.row, col: dest.col };
                }
                snapshot.bot.money = result.remainingMoney;
                moveResult = {
                  movedTo: dest,
                  milepostsMoved: candidate.mileposts,
                  trackUsageFee: result.cost,
                };
                logPhase('Phase 1', moveOptions, phase1Chosen, result, llmFields);
                break;
              }
            } catch (execError) {
              console.error(`${tag} Move attempt ${attempt} threw:`, execError instanceof Error ? execError.message : execError);
            }
          }

          if (!phase1Chosen) {
            logPhase('Phase 1', moveOptions, null, null, llmFields);
          }
        } catch (moveError) {
          console.warn(`${tag} Phase 1 failed (continuing to building):`, moveError instanceof Error ? moveError.message : moveError);
          logPhase('Phase 1', moveOptions, null, null, llmFields);
        }
      }

      // ── Phase 1.5: Post-movement delivery/pickup/drop at new position
      if (moveResult.movedTo && snapshot.gameStatus === 'active') {
        snapshot = await capture(gameId, botPlayerId);

        const phase15Result = await AIStrategyEngine.executeLoadActions(
          snapshot, botConfig, tag, 'Phase 1.5',
        );
        loadsDelivered.push(...phase15Result.delivered);
        loadsPickedUp.push(...phase15Result.pickedUp);

        if (phase15Result.stateChanged) {
          snapshot = await capture(gameId, botPlayerId);
        }

        logPhase('Phase 1.5', [], null, null);
      }

      // ── Phase 2: Building ──────────────────────────────────────────────
      let buildCandidates: FeasibleOption[];
      if (usedPlan && planBuildChoice) {
        // Plan-selected build first, then heuristic fallbacks
        const scored = Scorer.score([...buildOptions], snapshot, botConfig, memory);
        buildCandidates = [planBuildChoice, ...scored.filter(o => o !== planBuildChoice)];
      } else {
        // Convert LLM's feasible-space build index to unfiltered-space index.
        let llmBuildIndex = llmResult?.buildOptionIndex ?? -1;
        if (llmBuildIndex >= 0) {
          const feasibleBuilds = buildOptions.filter(o => o.feasible);
          const chosen = feasibleBuilds[llmBuildIndex];
          llmBuildIndex = chosen ? buildOptions.indexOf(chosen) : -1;
        }
        buildCandidates = AIStrategyEngine.buildOrderedCandidates(
          buildOptions, llmBuildIndex, snapshot, botConfig, memory,
        );
      }

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const candidate = buildCandidates[attempt] ?? null;
        if (!candidate || !candidate.feasible) break;

        const validation = validate(candidate, snapshot);
        if (!validation.valid) continue;

        try {
          const result = await TurnExecutor.execute(candidate, snapshot);
          if (result.success) {
            const durationMs = Date.now() - startTime;

            // Concise turn summary
            const parts: string[] = [];
            if (moveResult.movedTo) parts.push(`Move→${moveResult.movedTo.row},${moveResult.movedTo.col}(${moveResult.milepostsMoved}mi)`);
            for (const d of loadsDelivered) parts.push(`Deliver→${d.loadType}@${d.city}/$${d.payment}M`);
            for (const p of loadsPickedUp) parts.push(`Pickup→${p.loadType}@${p.city}`);
            if (result.action === AIActionType.BuildTrack) parts.push(`Build→${result.segmentsBuilt}seg/$${result.cost}M→${candidate.targetCity ?? '?'}`);
            else if (result.action === AIActionType.UpgradeTrain) parts.push(`Upgrade→${candidate.targetTrainType}`);
            console.log(`${tag} Turn complete: ${parts.join(', ') || 'PassTurn'} | money=${snapshot.bot.money}→${result.remainingMoney}`);

            // Update bot memory after successful Phase 2
            const deliveryEarnings = loadsDelivered.reduce((sum, d) => sum + d.payment, 0);
            const currentMemory = getMemory(gameId, botPlayerId);
            const buildTarget = result.action === AIActionType.BuildTrack ? (candidate.targetCity ?? null) : currentMemory.currentBuildTarget;

            // Check if a delivery completed a plan
            if (currentMemory.activePlan && loadsDelivered.some(d =>
              d.cardId === currentMemory.activePlan!.demandCardId ||
              (d.loadType === currentMemory.activePlan!.loadType && d.city === currentMemory.activePlan!.deliveryCity),
            )) {
              console.log(`${tag} Plan delivery completed: ${currentMemory.activePlan.loadType}→${currentMemory.activePlan.deliveryCity}`);
              updateMemory(gameId, botPlayerId, {
                activePlan: null,
                turnsOnPlan: 0,
                planHistory: [...currentMemory.planHistory, {
                  plan: currentMemory.activePlan,
                  outcome: 'delivered',
                  turns: currentMemory.turnsOnPlan,
                }],
              });
            }

            // Check if discard hand invalidated the plan's demand card
            if (result.action === AIActionType.DiscardHand && currentMemory.activePlan) {
              console.log(`${tag} Hand discarded — abandoning plan`);
              updateMemory(gameId, botPlayerId, {
                activePlan: null,
                turnsOnPlan: 0,
                planHistory: [...currentMemory.planHistory, {
                  plan: currentMemory.activePlan,
                  outcome: 'abandoned',
                  turns: currentMemory.turnsOnPlan,
                }],
              });
            }

            updateMemory(gameId, botPlayerId, {
              lastAction: result.action,
              consecutivePassTurns: 0,
              consecutiveDiscards: result.action === AIActionType.DiscardHand
                ? currentMemory.consecutiveDiscards + 1 : 0,
              deliveryCount: currentMemory.deliveryCount + loadsDelivered.length,
              totalEarnings: currentMemory.totalEarnings + deliveryEarnings,
              turnNumber: snapshot.turnNumber,
              currentBuildTarget: buildTarget,
              turnsOnTarget: buildTarget === currentMemory.currentBuildTarget
                ? currentMemory.turnsOnTarget + 1
                : (buildTarget ? 1 : 0),
            });

            logPhase('Phase 2', buildOptions, candidate, result, llmFields);
            flushTurnLog();

            return {
              action: result.action,
              segmentsBuilt: result.segmentsBuilt,
              cost: result.cost,
              durationMs,
              success: true,
              ...moveResult,
              loadsPickedUp: loadsPickedUp.length > 0 ? loadsPickedUp : undefined,
              loadsDelivered: loadsDelivered.length > 0 ? loadsDelivered : undefined,
              buildTargetCity: candidate.targetCity,
            };
          }
        } catch (execError) {
          console.error(`${tag} Build attempt ${attempt} threw:`, execError instanceof Error ? execError.message : execError);
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

      const parts: string[] = [];
      if (moveResult.movedTo) parts.push(`Move→${moveResult.movedTo.row},${moveResult.movedTo.col}(${moveResult.milepostsMoved}mi)`);
      for (const d of loadsDelivered) parts.push(`Deliver→${d.loadType}@${d.city}/$${d.payment}M`);
      for (const p of loadsPickedUp) parts.push(`Pickup→${p.loadType}@${p.city}`);
      parts.push('PassTurn(fallback)');
      console.log(`${tag} Turn complete: ${parts.join(', ')} | money=${snapshot.bot.money}`);

      const ptDeliveryEarnings = loadsDelivered.reduce((sum, d) => sum + d.payment, 0);
      updateMemory(gameId, botPlayerId, {
        lastAction: AIActionType.PassTurn,
        consecutivePassTurns: memory.consecutivePassTurns + 1,
        consecutiveDiscards: 0,
        deliveryCount: memory.deliveryCount + loadsDelivered.length,
        totalEarnings: memory.totalEarnings + ptDeliveryEarnings,
        turnNumber: snapshot.turnNumber,
      });

      logPhase('Phase 2', buildOptions, passPlan, passResult, llmFields);
      flushTurnLog();

      return {
        action: AIActionType.PassTurn,
        segmentsBuilt: 0,
        cost: 0,
        durationMs,
        success: passResult.success,
        ...moveResult,
        loadsPickedUp: loadsPickedUp.length > 0 ? loadsPickedUp : undefined,
        loadsDelivered: loadsDelivered.length > 0 ? loadsDelivered : undefined,
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
        loadsPickedUp: loadsPickedUp.length > 0 ? loadsPickedUp : undefined,
        loadsDelivered: loadsDelivered.length > 0 ? loadsDelivered : undefined,
      };
    }
  }

  /**
   * Execute all feasible delivery and pickup actions at the bot's current position.
   * Deliveries are tried first (higher value), then pickups.
   * Returns what was delivered/picked up and whether snapshot needs refresh.
   */
  private static async executeLoadActions(
    snapshot: WorldSnapshot,
    botConfig: BotConfig | null,
    tag: string,
    phase: string,
  ): Promise<{
    delivered: Array<{ loadType: string; city: string; payment: number; cardId: number }>;
    pickedUp: Array<{ loadType: string; city: string }>;
    stateChanged: boolean;
  }> {
    const delivered: Array<{ loadType: string; city: string; payment: number; cardId: number }> = [];
    const pickedUp: Array<{ loadType: string; city: string }> = [];
    let stateChanged = false;

    // Try deliveries first (highest priority — immediate income)
    const loadActions = new Set([AIActionType.DeliverLoad, AIActionType.PickupLoad, AIActionType.DropLoad]);
    const deliveryOptions = OptionGenerator.generate(snapshot, loadActions)
      .filter(o => o.action === AIActionType.DeliverLoad && o.feasible);

    if (deliveryOptions.length > 0) {
      const scoredDeliveries = Scorer.score(deliveryOptions, snapshot, botConfig);
      for (const candidate of scoredDeliveries) {
        if (!candidate.feasible) continue;
        const validation = validate(candidate, snapshot);
        if (!validation.valid) {
          console.log(`${tag} ${phase} delivery validation failed: ${validation.reason}`);
          continue;
        }
        try {
          console.log(`${tag} ${phase}: executing DeliverLoad ${candidate.loadType} to ${candidate.targetCity} (card=${candidate.cardId}, payment=${candidate.payment})`);
          const result = await TurnExecutor.execute(candidate, snapshot);
          if (result.success) {
            delivered.push({
              loadType: candidate.loadType!,
              city: candidate.targetCity!,
              payment: result.payment ?? candidate.payment ?? 0,
              cardId: candidate.cardId!,
            });
            // Update snapshot inline for subsequent actions in same phase
            snapshot.bot.money = result.remainingMoney;
            snapshot.bot.loads = snapshot.bot.loads.filter(l => l !== candidate.loadType);
            snapshot.bot.demandCards = snapshot.bot.demandCards.filter(c => c !== candidate.cardId);
            if (result.newCardId != null) {
              snapshot.bot.demandCards.push(result.newCardId);
            }
            stateChanged = true;
            console.log(`${tag} ${phase}: delivered ${candidate.loadType}, payment=${result.payment}, money=${result.remainingMoney}`);
          }
        } catch (execError) {
          console.error(`${tag} ${phase} delivery execution threw:`, execError instanceof Error ? execError.message : execError);
        }
      }
    }

    // Try drop loads (escape valve — drop truly orphaned loads before pickups)
    const dropOptions = OptionGenerator.generate(snapshot, loadActions)
      .filter(o => o.action === AIActionType.DropLoad && o.feasible);

    if (dropOptions.length > 0) {
      const scoredDrops = Scorer.score(dropOptions, snapshot, botConfig);
      for (const candidate of scoredDrops) {
        if (!candidate.feasible) continue;
        // Score gate: only drop if the Scorer thinks it's clearly beneficial.
        // Prevents marginal drops that create oscillation loops.
        if ((candidate.score ?? 0) <= 0) {
          console.log(`${tag} ${phase}: skipping DropLoad ${candidate.loadType} (score=${candidate.score} ≤ 0)`);
          continue;
        }
        const validation = validate(candidate, snapshot);
        if (!validation.valid) continue;
        try {
          console.log(`${tag} ${phase}: executing DropLoad ${candidate.loadType} at ${candidate.targetCity} (score=${candidate.score})`);
          const result = await TurnExecutor.execute(candidate, snapshot);
          if (result.success) {
            snapshot.bot.loads = snapshot.bot.loads.filter(l => l !== candidate.loadType);
            stateChanged = true;
            console.log(`${tag} ${phase}: dropped ${candidate.loadType}, loads=[${snapshot.bot.loads.join(',')}]`);
          }
        } catch (execError) {
          console.error(`${tag} ${phase} drop execution threw:`, execError instanceof Error ? execError.message : execError);
        }
      }
    }

    // Try pickups (only after deliveries/drops — may have freed capacity)
    // Re-generate options before each pickup to respect train capacity limits
    let pickupAttempts = 0;
    const maxPickupAttempts = 3; // safety bound
    while (pickupAttempts < maxPickupAttempts) {
      pickupAttempts++;
      const pickupOptions = OptionGenerator.generate(snapshot, loadActions)
        .filter(o => o.action === AIActionType.PickupLoad && o.feasible);

      if (pickupOptions.length === 0) break;

      const scoredPickups = Scorer.score(pickupOptions, snapshot, botConfig);
      const candidate = scoredPickups.find(o => o.feasible);
      if (!candidate) break;

      // Score gate: only skip pickups that are truly useless (no demand match at all).
      // Previously threshold was 15 which blocked demand-matching pickups when the
      // delivery city was unreachable (score=2.65 for 0.05x unaffordable penalty).
      // This caused the bot to sit on top of Steel at Ruhr and refuse to pick it up
      // because Bruxelles wasn't on the network yet. Lowered to 1 so only zero-value
      // speculative pickups (no matching demand card) are filtered.
      if ((candidate.score ?? 0) < 1) {
        console.log(`${tag} ${phase}: skipping PickupLoad ${candidate.loadType} (score=${candidate.score} < 1, below threshold)`);
        break;
      }

      const validation = validate(candidate, snapshot);
      if (!validation.valid) break;
      try {
        console.log(`${tag} ${phase}: executing PickupLoad ${candidate.loadType} at ${candidate.targetCity}`);
        const result = await TurnExecutor.execute(candidate, snapshot);
        if (result.success) {
          pickedUp.push({
            loadType: candidate.loadType!,
            city: candidate.targetCity!,
          });
          // Update snapshot inline
          snapshot.bot.loads.push(candidate.loadType!);
          stateChanged = true;
          console.log(`${tag} ${phase}: picked up ${candidate.loadType}, loads=[${snapshot.bot.loads.join(',')}]`);
        } else {
          break;
        }
      } catch (execError) {
        console.error(`${tag} ${phase} pickup execution threw:`, execError instanceof Error ? execError.message : execError);
        break;
      }
    }

    return { delivered, pickedUp, stateChanged };
  }

  /**
   * Validate whether the active plan is still viable.
   * Returns true if all conditions pass, false if any re-plan trigger fires.
   */
  private static validatePlan(
    plan: DeliveryPlan,
    snapshot: WorldSnapshot,
    memory: BotMemoryState,
  ): boolean {
    // 1. Demand card still in hand
    if (!snapshot.bot.demandCards.includes(plan.demandCardId)) {
      return false;
    }

    // 2. Load still available at pickup city (pre-pickup phases only)
    if (plan.phase === 'build_to_pickup' || plan.phase === 'travel_to_pickup') {
      const cityLoads = snapshot.loadAvailability[plan.pickupCity] ?? [];
      if (!cityLoads.includes(plan.loadType) && !snapshot.bot.loads.includes(plan.loadType)) {
        return false;
      }
    }

    // 3. Not stuck: turnsOnPlan < 15
    if (memory.turnsOnPlan >= 15) {
      return false;
    }

    // 4. Not stuck: consecutivePassTurns < 3
    if (memory.consecutivePassTurns >= 3) {
      return false;
    }

    // 5. Bot has enough money (rough estimate: > 8M for active game)
    if (snapshot.bot.money <= 8 && (plan.phase === 'build_to_pickup' || plan.phase === 'build_to_delivery')) {
      return false;
    }

    return true;
  }

  /**
   * Consult LLM to select a new delivery chain and create a DeliveryPlan.
   * Returns null if LLM fails or no viable chains exist.
   */
  private static async selectNewPlan(
    snapshot: WorldSnapshot,
    memory: BotMemoryState,
    botConfig: BotConfig,
    tag: string,
  ): Promise<DeliveryPlan | null> {
    const chains = OptionGenerator.getRankedChains(snapshot, memory);
    if (chains.length === 0) return null;

    const top5 = chains.slice(0, 5);
    const skillLevel = (botConfig.skillLevel as BotSkillLevel) ?? BotSkillLevel.Medium;
    const archetype = (botConfig.archetype as BotArchetype) ?? BotArchetype.Balanced;

    // Build plan selection prompt
    const userPrompt = GameStateSerializer.serializePlanSelectionPrompt(snapshot, memory, skillLevel);
    const systemPrompt = getPlanSelectionPrompt(archetype, skillLevel);

    // Create provider adapter and call LLM
    const provider = (botConfig.provider as LLMProvider) ?? LLMProvider.Anthropic;
    const envKey = provider === LLMProvider.Google ? 'GOOGLE_AI_API_KEY' : 'ANTHROPIC_API_KEY';
    const apiKey = process.env[envKey] ?? '';

    if (!apiKey) {
      // No API key — use heuristic: pick top chain
      const best = top5[0];
      const hasLoad = snapshot.bot.loads.includes(best.loadType);
      return {
        demandCardId: best.cardId,
        loadType: best.loadType,
        pickupCity: best.pickupCity,
        deliveryCity: best.deliveryCity,
        payment: best.payment,
        phase: hasLoad ? 'build_to_delivery' : 'build_to_pickup',
        createdAtTurn: snapshot.turnNumber,
        reasoning: `[heuristic] Best chain: ${best.loadType} ${best.pickupCity}→${best.deliveryCity} (${best.payment}M)`,
      };
    }

    try {
      const brain = AIStrategyEngine.createBrain(botConfig);
      // Use the brain's adapter to make the plan selection call
      const { AnthropicAdapter } = await import('./providers/AnthropicAdapter');
      const { GoogleAdapter } = await import('./providers/GoogleAdapter');
      const timeoutMs = skillLevel === BotSkillLevel.Easy ? 10000 : 15000;
      const adapter = provider === LLMProvider.Google
        ? new GoogleAdapter(apiKey, timeoutMs)
        : new AnthropicAdapter(apiKey, timeoutMs);

      const model = botConfig.model ?? (await import('../../../shared/types/GameTypes')).LLM_DEFAULT_MODELS[provider][skillLevel];

      const response = await adapter.chat({
        model,
        maxTokens: 200,
        temperature: 0.3,
        systemPrompt,
        userPrompt,
      });

      const parsed = ResponseParser.parsePlanSelection(response.text, top5.length);
      const chosen = top5[parsed.chainIndex];

      if (!chosen) return null;

      const hasLoad = snapshot.bot.loads.includes(chosen.loadType);

      // Determine initial phase based on current state
      let phase: DeliveryPlan['phase'];
      if (hasLoad) {
        // Already carrying the load
        const grid = loadGridPoints();
        const onNetwork = new Set<string>();
        for (const seg of snapshot.bot.existingSegments) {
          onNetwork.add(`${seg.from.row},${seg.from.col}`);
          onNetwork.add(`${seg.to.row},${seg.to.col}`);
        }
        const deliveryOnNetwork = chosen.deliveryTargets.some(
          t => onNetwork.has(`${t.row},${t.col}`),
        );
        phase = deliveryOnNetwork ? 'travel_to_delivery' : 'build_to_delivery';
      } else {
        const grid = loadGridPoints();
        const onNetwork = new Set<string>();
        for (const seg of snapshot.bot.existingSegments) {
          onNetwork.add(`${seg.from.row},${seg.from.col}`);
          onNetwork.add(`${seg.to.row},${seg.to.col}`);
        }
        const pickupOnNetwork = chosen.pickupTargets.some(
          t => onNetwork.has(`${t.row},${t.col}`),
        );
        phase = pickupOnNetwork ? 'travel_to_pickup' : 'build_to_pickup';
      }

      console.log(`${tag} LLM selected chain ${parsed.chainIndex}: ${chosen.loadType} ${chosen.pickupCity}→${chosen.deliveryCity} (${chosen.payment}M), phase=${phase}`);

      return {
        demandCardId: chosen.cardId,
        loadType: chosen.loadType,
        pickupCity: chosen.pickupCity,
        deliveryCity: chosen.deliveryCity,
        payment: chosen.payment,
        phase,
        createdAtTurn: snapshot.turnNumber,
        reasoning: parsed.reasoning,
      };
    } catch (err) {
      console.warn(`${tag} Plan selection LLM call failed:`, err instanceof Error ? err.message : err);

      // Fallback: pick top heuristic chain
      const best = top5[0];
      const hasLoad = snapshot.bot.loads.includes(best.loadType);
      return {
        demandCardId: best.cardId,
        loadType: best.loadType,
        pickupCity: best.pickupCity,
        deliveryCity: best.deliveryCity,
        payment: best.payment,
        phase: hasLoad ? 'build_to_delivery' : 'build_to_pickup',
        createdAtTurn: snapshot.turnNumber,
        reasoning: `[heuristic fallback] Best chain: ${best.loadType} ${best.pickupCity}→${best.deliveryCity} (${best.payment}M)`,
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

  /**
   * Handle ferry crossing when bot starts its turn at a ferry port.
   * Game rule: stop at port one turn, teleport to other side next turn at half speed.
   * Returns true if the bot crossed a ferry (caller should re-capture snapshot and set ferryHalfSpeed).
   */
  private static async handleFerryCrossing(
    snapshot: WorldSnapshot,
    tag: string,
  ): Promise<boolean> {
    if (!snapshot.bot.position) return false;

    const ferryEdges = getFerryEdges();
    const posKey = `${snapshot.bot.position.row},${snapshot.bot.position.col}`;

    // Find which ferry port (if any) the bot is at
    let otherSide: { row: number; col: number } | null = null;
    let ferryName = '';

    for (const ferry of ferryEdges) {
      const aKey = `${ferry.pointA.row},${ferry.pointA.col}`;
      const bKey = `${ferry.pointB.row},${ferry.pointB.col}`;
      if (posKey === aKey) {
        otherSide = ferry.pointB;
        ferryName = ferry.name;
        break;
      }
      if (posKey === bKey) {
        otherSide = ferry.pointA;
        ferryName = ferry.name;
        break;
      }
    }

    if (!otherSide) return false;

    // Bot is at a ferry port. Decide whether crossing is beneficial:
    // Cross if any demand city target is closer (Euclidean) from the other side.
    const grid = loadGridPoints();
    const curR = snapshot.bot.position.row;
    const curC = snapshot.bot.position.col;
    let shouldCross = false;

    for (const rd of snapshot.bot.resolvedDemands) {
      for (const demand of rd.demands) {
        for (const [, point] of grid) {
          if (point.name === demand.city) {
            const currentDist = (curR - point.row) ** 2 + (curC - point.col) ** 2;
            const otherDist = (otherSide.row - point.row) ** 2 + (otherSide.col - point.col) ** 2;
            if (otherDist < currentDist) {
              shouldCross = true;
              break;
            }
          }
        }
        if (shouldCross) break;
      }
      if (shouldCross) break;
    }

    if (!shouldCross) {
      console.log(`${tag} At ferry port ${ferryName} but no demand city closer from other side — staying`);
      return false;
    }

    // Cross the ferry: teleport to other side
    console.log(`${tag} Crossing ferry ${ferryName} to ${otherSide.row},${otherSide.col}`);
    const pixel = gridToPixel(otherSide.row, otherSide.col);

    await db.query(
      'UPDATE players SET position_row = $1, position_col = $2, position_x = $3, position_y = $4 WHERE id = $5',
      [otherSide.row, otherSide.col, pixel.x, pixel.y, snapshot.bot.playerId],
    );

    snapshot.bot.position = { row: otherSide.row, col: otherSide.col };
    return true;
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

  /**
   * Build an ordered candidate list: LLM choice first, then heuristic-scored
   * fallbacks (for when PlanValidator rejects the LLM's choice).
   */
  private static buildOrderedCandidates(
    options: FeasibleOption[],
    llmIndex: number,
    snapshot: WorldSnapshot,
    botConfig: BotConfig | null,
    memory?: import('../../../shared/types/GameTypes').BotMemoryState,
  ): FeasibleOption[] {
    // Score all options via heuristic as fallback ordering
    const scored = Scorer.score([...options], snapshot, botConfig, memory);

    if (llmIndex < 0 || llmIndex >= options.length) {
      // No LLM choice or skip — use heuristic order
      return scored;
    }

    // Put LLM choice first, then remaining options in heuristic score order
    const llmChoice = options[llmIndex];
    const rest = scored.filter((o) => o !== llmChoice);
    return [llmChoice, ...rest];
  }
}
