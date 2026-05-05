/**
 * TripPlanner — Multi-stop trip planning service (JIRA-126).
 *
 * Replaces serial single-delivery planning with multi-stop trip planning.
 * Returns a single best route per turn via LLM, validates it, and converts
 * it into a StrategicRoute. Falls back to planRoute on repeated failure.
 *
 * JIRA-210B: Collapsed from multi-candidate selection to single-route output.
 * JIRA-217: Layers MultiDemandTripOptimizer + TripCandidateSelector in front
 *           of the existing LLM-as-generator path (now called legacyLLMGenerate).
 */

import {
  BotSkillLevel,
  BotMemoryState,
  DemandOption,
  GameContext,
  GridPoint,
  LlmAttempt,
  RouteStop,
  StrategicRoute,
  TrainType,
  TRAIN_PROPERTIES,
  WorldSnapshot,
} from '../../../shared/types/GameTypes';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { estimateHopDistance, loadGridPoints } from './MapTopology';
import { computeTrackUsageFees } from '../../../shared/services/computeTrackUsageFees';
import { RouteValidator } from './RouteValidator';
import { RouteOptimizer } from './RouteOptimizer';
import { ResponseParser } from './ResponseParser';
import { TRIP_PLAN_SCHEMA } from './schemas';
import { getTripPlanningPrompt } from './prompts/systemPrompts';
import type { TripPlannerSelectionDiagnostic } from './LLMTranscriptLogger';
import { generateCandidates, OptimizerResult } from './MultiDemandTripOptimizer';
import { TripCandidateSelector, SelectorResult } from './TripCandidateSelector';

// ── Types ────────────────────────────────────────────────────────────

/** Internal-only scored route used during validation/scoring within planTrip. Not exported. */
interface ScoredRoute {
  stops: RouteStop[];
  score: number;
  netValue: number;
  estimatedTurns: number;
  buildCostEstimate: number;
  usageFeeEstimate: number;
  reasoning: string;
}

export interface TripPlanResult {
  route: StrategicRoute | null;
  llmLatencyMs: number;
  llmTokens: { input: number; output: number };
  llmLog: LlmAttempt[];
  systemPrompt?: string;
  userPrompt?: string;
  /**
   * JIRA-210B: Short-circuit paths + JIRA-217: optimizer/selector diagnostic.
   * - 'no_actionable_options' — no affordable demand options to plan from.
   * - 'keep_current_plan'     — existing plan is still valid; no replan needed.
   * - 'selector'              — JIRA-217: LLM selector picked among ≥2 optimizer candidates.
   * - 'single_candidate'      — JIRA-217: only 1 optimizer candidate; returned directly.
   * - 'fallback_top_ev'       — JIRA-217: selector returned top-by-EV due to fallback.
   * - 'legacy_generator'      — JIRA-217: optimizer returned 0 candidates; legacy LLM path ran.
   */
  selection?: {
    fallbackReason?: 'no_actionable_options' | 'keep_current_plan' | SelectorResult['fallbackReason'];
    source?: 'selector' | 'single_candidate' | 'fallback_top_ev' | 'legacy_generator';
    optimizerStats?: OptimizerResult['enumerationStats'];
    candidateCount?: number;
    chosenCandidateId?: number;
    rationale?: string;
  };
}

/** Raw LLM output matching TRIP_PLAN_SCHEMA (JIRA-190: renamed fields; JIRA-210B: single-route) */
type LLMTripPlanStop =
  | { action: 'PICKUP'; load: string; supplyCity: string }
  | { action: 'DELIVER'; load: string; deliveryCity: string; demandCardId: number; payment: number };

interface LLMTripPlanResponse {
  stops: Array<LLMTripPlanStop>;
  reasoning: string;
  upgradeOnRoute?: string;
}

// ── Token budgets (same scale as route planning) ─────────────────────

const TRIP_MAX_TOKENS: Record<BotSkillLevel, number> = {
  [BotSkillLevel.Easy]: 8192,
  [BotSkillLevel.Medium]: 12288,
  [BotSkillLevel.Hard]: 16384,
};

const TRIP_EFFORT: Record<BotSkillLevel, string> = {
  [BotSkillLevel.Easy]: 'low',
  [BotSkillLevel.Medium]: 'medium',
  [BotSkillLevel.Hard]: 'medium',
};

const TEMPERATURE_BY_SKILL: Record<BotSkillLevel, number> = {
  [BotSkillLevel.Easy]: 0.7,
  [BotSkillLevel.Medium]: 0.4,
  [BotSkillLevel.Hard]: 0.2,
};

const MAX_RETRIES = 2;

// ── TripPlanner ──────────────────────────────────────────────────────

export class TripPlanner {
  private readonly brain: LLMStrategyBrain;

  constructor(brain: LLMStrategyBrain) {
    this.brain = brain;
  }

  /**
   * Plan a multi-stop trip. On total failure (LLM + fallback both fail),
   * returns a failure result with route=null and the llmLog preserved for diagnostics.
   *
   * JIRA-217: Layers MultiDemandTripOptimizer + TripCandidateSelector in front of
   * the existing LLM-as-generator path. Existing pre-LLM short-circuits unchanged.
   */
  async planTrip(
    snapshot: WorldSnapshot,
    context: GameContext,
    gridPoints: GridPoint[],
    memory: BotMemoryState,
    userPromptOverride?: string,
  ): Promise<TripPlanResult> {
    // ── JIRA-207B (R10c): Pre-LLM short-circuit — evaluate NEW OPTIONS filter ──
    // If every demand card is either unaffordable or already a carry-load commitment, the
    // LLM has nothing to choose from. Skip the call and return a mechanically-determined result.
    if (!userPromptOverride) {
      const hasNewOptions = context.demands.some(d => d.isAffordable && !d.isLoadOnTrain);
      if (!hasNewOptions) {
        const activeRoute = memory.activeRoute;
        const hasRemainingStops = activeRoute != null && activeRoute.currentStopIndex < activeRoute.stops.length;
        const hasCarriedLoads = context.loads.length > 0;
        const commitmentExists = hasRemainingStops || hasCarriedLoads;

        if (commitmentExists) {
          // Keep current plan — no new options available but bot has existing commitment
          console.log(`[TripPlanner] keep_current_plan: no OPTIONS available; existing route/loads preserved`);
          return {
            route: null,
            llmLatencyMs: 0,
            llmTokens: { input: 0, output: 0 },
            llmLog: [],
            selection: { fallbackReason: 'keep_current_plan' },
          };
        } else {
          // No options, no commitment — let heuristic fallback produce DiscardHand
          console.log(`[TripPlanner] no_actionable_options: no OPTIONS and no current plan; heuristic fallback`);
          return {
            route: null,
            llmLatencyMs: 0,
            llmTokens: { input: 0, output: 0 },
            llmLog: [],
            selection: { fallbackReason: 'no_actionable_options' },
          };
        }
      }
    }

    // ── JIRA-217: Stage 1 — deterministic optimizer ───────────────────────────
    const optimizerResult = generateCandidates(snapshot, context, gridPoints);

    // ── JIRA-217: Stage 2 — selector (or legacy fallback) ────────────────────
    if (optimizerResult.candidates.length >= 1) {
      const selector = new TripCandidateSelector(this.brain);
      const selectorResult = await selector.select(
        optimizerResult.candidates,
        snapshot,
        context,
        memory,
      );

      const source =
        optimizerResult.candidates.length === 1 ? 'single_candidate' as const :
        selectorResult.fallbackReason === 'invalid_id' || selectorResult.fallbackReason === 'llm_failure'
          ? 'fallback_top_ev' as const
          : 'selector' as const;

      return {
        route: selectorResult.chosenCandidate.route,
        llmLatencyMs: selectorResult.llmLatencyMs,
        llmTokens: selectorResult.llmTokens,
        llmLog: selectorResult.llmLog,
        selection: {
          source,
          optimizerStats: optimizerResult.enumerationStats,
          candidateCount: optimizerResult.candidates.length,
          chosenCandidateId: selectorResult.chosenCandidate.candidateId,
          rationale: selectorResult.rationale,
          fallbackReason: selectorResult.fallbackReason,
        },
      };
    }

    // Optimizer returned 0 candidates — fall through to legacy LLM-as-generator path.
    const legacyResult = await this.legacyLLMGenerate(snapshot, context, gridPoints, memory, userPromptOverride);
    return {
      ...legacyResult,
      selection: {
        ...(legacyResult.selection ?? {}),
        source: 'legacy_generator' as const,
        optimizerStats: optimizerResult.enumerationStats,
        candidateCount: 0,
      },
    };
  }

  /**
   * JIRA-217: Extraction of original planTrip LLM-as-generator body.
   * Unchanged behavior — single-route LLM call with retry loop.
   * Called when the optimizer returns 0 candidates (rare safety-net path).
   */
  private async legacyLLMGenerate(
    snapshot: WorldSnapshot,
    context: GameContext,
    gridPoints: GridPoint[],
    memory: BotMemoryState,
    userPromptOverride?: string,
  ): Promise<TripPlanResult> {
    const config = this.brain.strategyConfig;
    const adapter = this.brain.providerAdapter;
    const model = this.brain.modelName;
    const skillLevel = config.skillLevel;

    const { system: systemPrompt, user: baseUserPrompt } = getTripPlanningPrompt(skillLevel, context, memory);
    const userPrompt = userPromptOverride ?? baseUserPrompt;

    const llmLog: LlmAttempt[] = [];
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Append error to user prompt only — system stays byte-stable across retries (R9)
      const promptWithError = lastError
        ? `${userPrompt}\n\nPREVIOUS ATTEMPT FAILED: ${lastError}\nPlease fix the issue and try again.`
        : userPrompt;

      const startMs = Date.now();
      try {
        adapter.setContext({ gameId: snapshot.gameId, playerId: snapshot.bot.playerId, playerName: snapshot.bot.botConfig?.name, turn: snapshot.turnNumber, caller: 'trip-planner', method: 'planTrip' });
        const response = await adapter.chat({
          model,
          maxTokens: TRIP_MAX_TOKENS[skillLevel],
          temperature: TEMPERATURE_BY_SKILL[skillLevel],
          systemPrompt,
          userPrompt: promptWithError,
          outputSchema: TRIP_PLAN_SCHEMA,
          timeoutMs: 60000,
          ...(skillLevel !== BotSkillLevel.Easy && {
            thinking: { type: 'adaptive' },
            effort: TRIP_EFFORT[skillLevel],
          }),
        });
        const latencyMs = Date.now() - startMs;

        // Parse LLM response
        let parsed: LLMTripPlanResponse;
        let recoveredFromTruncation = false;
        try {
          parsed = typeof response.text === 'string'
            ? JSON.parse(response.text)
            : response.text as unknown as LLMTripPlanResponse;
        } catch {
          // Attempt truncated JSON recovery before declaring parse_error (ADR-1, ADR-2)
          const recovered = typeof response.text === 'string'
            ? ResponseParser.recoverTruncatedJson(response.text)
            : null;
          if (recovered !== null) {
            console.warn('[TripPlanner] Recovered truncated JSON response');
            parsed = recovered as unknown as LLMTripPlanResponse;
            recoveredFromTruncation = true;
          } else {
            const err = `JSON parse error: ${response.text.substring(0, 200)}`;
            llmLog.push({ attemptNumber: attempt + 1, status: 'parse_error', responseText: response.text.substring(0, 500), error: err, latencyMs });
            lastError = err;
            continue;
          }
        }

        // Validate basic structure — single route must have stops array
        if (!parsed.stops || parsed.stops.length === 0) {
          const err = 'LLM returned no stops';
          llmLog.push({ attemptNumber: attempt + 1, status: 'validation_error', responseText: response.text.substring(0, 500), error: err, latencyMs });
          lastError = err;
          continue;
        }

        // Convert and validate the single route
        const { validCandidates: candidates, rejections } = this.scoreCandidates(parsed, context, snapshot, gridPoints);

        if (candidates.length === 0 || candidates[0].stops.length === 0) {
          // Route failed validation — build single-route error feedback for retry
          const rej = rejections[0];
          const failedRule = rej ? this.classifyValidationError(rej.errors) : 'missing_pickup';
          const detail = rej ? rej.errors.join('; ') : 'route was pruned to zero stops';
          const err = `Your previous route failed: ${failedRule}: ${detail}`;
          llmLog.push({
            attemptNumber: attempt + 1,
            status: 'validation_error',
            responseText: response.text.substring(0, 500),
            error: err,
            latencyMs,
          });
          lastError = err;
          continue;
        }

        // Normalize upgrade label and compute upgrade cost for affordability check
        const UPGRADE_LABEL_TO_TRAIN: Record<string, TrainType> = {
          FastFreight: TrainType.FastFreight,
          HeavyFreight: TrainType.HeavyFreight,
          Superfreight: TrainType.Superfreight,
        };
        const rawUpgrade = parsed.upgradeOnRoute ? String(parsed.upgradeOnRoute) : undefined;
        const normalizedUpgrade = rawUpgrade
          ? (UPGRADE_LABEL_TO_TRAIN[rawUpgrade] ?? rawUpgrade)
          : undefined;
        const upgradeCost = this.computeUpgradeCost(
          typeof normalizedUpgrade === 'string' && Object.values(TrainType).includes(normalizedUpgrade as TrainType)
            ? normalizedUpgrade as TrainType
            : undefined,
        );
        const availableCash = snapshot.bot.money - upgradeCost;
        const validatedRoute = candidates[0];
        const totalCost = validatedRoute.buildCostEstimate + validatedRoute.usageFeeEstimate;
        if (totalCost > availableCash) {
          const gapMsg = `Your previous route failed: cost_exceeds_budget: route costs ${totalCost}M but only ${availableCash}M available (cash=${snapshot.bot.money}M - upgrade=${upgradeCost}M). Propose a route fundable from ${availableCash}M (omit upgradeOnRoute if needed).`;
          console.log(`[TripPlanner] Affordability check failed — retrying with hint`);
          llmLog.push({ attemptNumber: attempt + 1, status: 'validation_error', responseText: response.text.substring(0, 500), error: gapMsg, latencyMs });
          lastError = gapMsg;
          continue;
        }

        // Convert validated route to StrategicRoute
        const route: StrategicRoute = {
          stops: validatedRoute.stops,
          currentStopIndex: 0,
          phase: 'build',
          createdAtTurn: context.turnNumber,
          reasoning: validatedRoute.reasoning,
          upgradeOnRoute: normalizedUpgrade,
        };

        // Build success llmLog entry (recoveredFromTruncation flag when applicable)
        const successLogEntry: LlmAttempt = {
          attemptNumber: attempt + 1,
          status: 'success',
          responseText: response.text.substring(0, 500),
          latencyMs,
          ...(recoveredFromTruncation ? { recoveredFromTruncation: true } : {}),
        };
        llmLog.push(successLogEntry);

        return {
          route,
          llmLatencyMs: latencyMs,
          llmTokens: response.usage,
          llmLog,
          systemPrompt,
          userPrompt,
        };
      } catch (error) {
        const latencyMs = Date.now() - startMs;
        const err = error instanceof Error ? error.message : String(error);
        llmLog.push({ attemptNumber: attempt + 1, status: 'api_error', responseText: '', error: err, latencyMs });
        lastError = err;
      }
    }

    // All retries failed — try fallback via planRoute() (ADR-5: unchanged safety net)
    console.warn(`[TripPlanner] All ${MAX_RETRIES + 1} attempts failed, falling back to planRoute()`);
    try {
      const fallback = await this.brain.planRoute(
        snapshot,
        context,
        gridPoints,
        memory.lastAbandonedRouteKey,
        memory.previousRouteStops,
      );
      if (fallback.route) {
        const successResult = fallback as { route: StrategicRoute; model: string; latencyMs: number; tokenUsage?: { input: number; output: number }; llmLog: LlmAttempt[]; systemPrompt?: string; userPrompt?: string };
        return {
          route: successResult.route,
          llmLatencyMs: successResult.latencyMs,
          llmTokens: successResult.tokenUsage ?? { input: 0, output: 0 },
          llmLog: [...llmLog, ...successResult.llmLog],
          systemPrompt: successResult.systemPrompt,
          userPrompt: successResult.userPrompt,
        };
      }
    } catch (fallbackErr) {
      const errMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      console.warn(`[TripPlanner] planRoute() fallback also failed: ${errMsg}`);
    }

    // Return failure with preserved llmLog for diagnostics
    return { route: null, llmLatencyMs: 0, llmTokens: { input: 0, output: 0 }, llmLog };
  }

  /**
   * JIRA-206 (R3): Compute the ECU cost of a same-turn upgrade signalled by upgradeOnRoute.
   * Returns 20 for any valid tier upgrade (base→fast/heavy or fast/heavy→superfreight).
   * Returns 0 when target is undefined.
   * Reuses UPGRADE_LABEL_TO_TRAIN for label normalization.
   */
  private computeUpgradeCost(
    target: TrainType | undefined,
  ): number {
    if (target === undefined) return 0;
    // Any valid train upgrade costs 20M per game rules
    const validTargets: TrainType[] = [TrainType.FastFreight, TrainType.HeavyFreight, TrainType.Superfreight];
    if (validTargets.includes(target)) return 20;
    return 0;
  }

  /**
   * Score and validate the single-route LLM response (JIRA-210B: collapsed from multi-candidate).
   * Returns the validated route (if valid) as the first element of validCandidates, plus
   * per-rejection error info for retry feedback.
   *
   * Uses chain-aware sequential turn estimation for multi-stop trips:
   * - First deliver stop: uses existing estimatedTurns from DemandContext (bot→supply→delivery)
   * - Subsequent deliver stops: computes fresh legs via estimateHopDistance
   *   (prevDelivery→nextSupply + supply→delivery + build turns)
   */
  private scoreCandidates(
    parsed: LLMTripPlanResponse,
    context: GameContext,
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
  ): { validCandidates: ScoredRoute[]; rejections: Array<{ llmIndex: number; errors: string[]; prunedToZero: boolean }> } {
    const trainSpeed = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9;
    const validCandidates: ScoredRoute[] = [];
    const rejections: Array<{ llmIndex: number; errors: string[]; prunedToZero: boolean }> = [];

    // Single-route: treat as llmIdx=0
    const llmIdx = 0;
    const rawStops = parsed.stops;
    const rawReasoning = parsed.reasoning;

    // Convert LLM stops to RouteStop format
    // JIRA-164: Filter out sentinel city names that LLMs may hallucinate from context serialization
    // JIRA-190: Read supplyCity (PICKUP) / deliveryCity (DELIVER) — no DROP in LLM schema
    const stops: RouteStop[] = rawStops
      .filter(s => {
        // Only PICKUP and DELIVER are valid — any other action (e.g. DROP) is filtered out (ADR-2)
        const actionUpper = s.action.toUpperCase();
        if (actionUpper !== 'PICKUP' && actionUpper !== 'DELIVER') return false;
        const cityField = actionUpper === 'PICKUP'
          ? (s as { action: string; load: string; supplyCity?: string }).supplyCity
          : (s as { action: string; load: string; deliveryCity?: string }).deliveryCity;
        // Filter out missing city fields and sentinel city names (JIRA-164)
        return !!cityField && cityField !== 'OnTrain' && cityField !== '(already carried)';
      })
      .map(s => {
        const actionUpper = s.action.toUpperCase();
        const cityField = actionUpper === 'PICKUP'
          ? (s as { action: string; load: string; supplyCity?: string }).supplyCity!
          : (s as { action: string; load: string; deliveryCity?: string }).deliveryCity!;
        const deliverStop = actionUpper === 'DELIVER'
          ? s as { action: string; load: string; deliveryCity?: string; demandCardId?: number; payment?: number }
          : null;

        // Fill-in fallback for missing demandCardId on deliver stops (JIRA-193 R6):
        // When the LLM omits demandCardId, attempt to resolve it from context.demands
        // by matching loadType + deliveryCity. Only assign when exactly one card matches
        // (ambiguous matches are left undefined — the defensive isDeliveryComplete fix is safe).
        let resolvedDemandCardId = deliverStop?.demandCardId;
        if (deliverStop && resolvedDemandCardId == null) {
          const matches = context.demands.filter(
            d => d.loadType === s.load && d.deliveryCity === cityField,
          );
          if (matches.length === 1) {
            resolvedDemandCardId = matches[0].cardIndex;
          }
        }

        return {
          action: s.action.toLowerCase() as 'pickup' | 'deliver',
          loadType: s.load,
          city: cityField,
          demandCardId: resolvedDemandCardId,
          payment: deliverStop?.payment,
        };
      });

    // Build a temporary StrategicRoute for validation
    const tempRoute: StrategicRoute = {
      stops,
      currentStopIndex: 0,
      phase: 'build',
      createdAtTurn: context.turnNumber,
      reasoning: rawReasoning,
    };

    // Optimize stop order before validation (JIRA-184: explicit composition)
    // RouteValidator is now a pure predicate — it no longer reorders stops.
    const botPos = snapshot.bot.position;
    if (botPos && stops.length > 1) {
      const gridPoints = loadGridPoints();
      const reorderedStops = RouteOptimizer.orderStopsByProximity(
        stops,
        botPos,
        gridPoints,
        context.loads,
      );
      tempRoute.stops = reorderedStops;
    }

    // Validate via RouteValidator (pure predicate — no reorder side-effect)
    const validation = RouteValidator.validate(tempRoute, context, snapshot);
    if (!validation.valid && !validation.prunedRoute) {
      // Capture rejection errors for retry feedback
      const errors = validation.errors?.length ? validation.errors : ['RouteValidator: route is invalid'];
      rejections.push({ llmIndex: llmIdx, errors, prunedToZero: false });
      return { validCandidates, rejections };
    }

    // Use pruned route if available
    const finalStops = validation.prunedRoute?.stops ?? stops;

    // Track if the route survived validation but was pruned to zero stops
    if (finalStops.length === 0) {
      const errors = validation.errors?.length ? validation.errors : ['RouteValidator: all stops pruned'];
      rejections.push({ llmIndex: llmIdx, errors, prunedToZero: true });
      return { validCandidates, rejections };
    }

      // Calculate scoring metrics from demand context
      let totalPayout = 0;
      let totalBuildCost = 0;
      let totalEstimatedTurns = 0;
      // Track the last delivery city for chain-aware sequential estimation
      let lastDeliveryCity: string | null = null;

      for (const stop of finalStops) {
        if (stop.action === 'deliver' && stop.payment) {
          totalPayout += stop.payment;
        }
        // Estimate build costs from demand context data
        const matchingDemand = context.demands.find(
          d => d.loadType === stop.loadType && (
            (stop.action === 'pickup' && d.supplyCity === stop.city) ||
            (stop.action === 'deliver' && d.deliveryCity === stop.city)
          ),
        );
        if (matchingDemand) {
          if (stop.action === 'pickup') {
            totalBuildCost += matchingDemand.estimatedTrackCostToSupply;
          } else {
            // Deliver stop: accumulate build cost and chain-aware turn estimation
            totalBuildCost += matchingDemand.estimatedTrackCostToDelivery;

            if (lastDeliveryCity === null) {
              // First deliver stop: use pre-computed estimatedTurns (bot→supply→delivery + build + ferry)
              totalEstimatedTurns += matchingDemand.estimatedTurns;
            } else {
              // Subsequent deliver stop: compute fresh via estimateHopDistance
              // We need to find the supply city for this demand
              const supplyCity = matchingDemand.supplyCity ?? null;
              const chainTurns = this.computeChainLegTurns(
                lastDeliveryCity,
                supplyCity,
                stop.city,
                matchingDemand.estimatedTrackCostToDelivery,
                gridPoints,
                trainSpeed,
                matchingDemand.estimatedTurns,
              );
              totalEstimatedTurns += chainTurns;
            }

            lastDeliveryCity = stop.city;
          }
        }
      }

      // JIRA-187: Compute track-usage fees for capped delivery cities and fold into
      // payout so capped-city demands naturally rank lower without a special branch.
      let totalUsageFees = 0;
      for (const stop of finalStops) {
        if (stop.action === 'deliver' && stop.payment) {
          const matchingDemandForFee = context.demands.find(
            d => d.loadType === stop.loadType && d.deliveryCity === stop.city,
          );
          if (matchingDemandForFee) {
            const syntheticDemand: DemandOption = {
              cardId: matchingDemandForFee.cardIndex,
              demandIndex: 0,
              loadType: stop.loadType,
              supplyCity: matchingDemandForFee.supplyCity ?? '',
              deliveryCity: stop.city,
              payout: stop.payment,
              startingCity: '',
              buildCostToSupply: matchingDemandForFee.estimatedTrackCostToSupply,
              buildCostSupplyToDelivery: matchingDemandForFee.estimatedTrackCostToDelivery,
              totalBuildCost: matchingDemandForFee.estimatedTrackCostToSupply + matchingDemandForFee.estimatedTrackCostToDelivery,
              ferryRequired: matchingDemandForFee.ferryRequired,
              estimatedTurns: matchingDemandForFee.estimatedTurns,
              efficiency: 0,
            };
            totalUsageFees += computeTrackUsageFees(syntheticDemand, snapshot);
          }
        }
      }
      const effectivePayout = totalPayout - totalUsageFees;

      // Prevent division by zero
      const estimatedTurns = Math.max(totalEstimatedTurns, 1);
      const netValue = effectivePayout - totalBuildCost;
      const baseScore = netValue / estimatedTurns;

      // JIRA-166: Geographic distance penalty — penalize routes with high total travel
      // spread so compact routes score higher than cross-map zigzags with equal payout/turns.
      // Compute total hop distance across consecutive stops and apply a divisor penalty.
      // DISTANCE_NORMALIZATION = 20 hops ≈ ~2 turns of travel at Freight speed (9 mp/turn).
      const DISTANCE_NORMALIZATION = 20;
      let totalHopDistance = 0;
      for (let i = 0; i + 1 < finalStops.length; i++) {
        const fromStop = finalStops[i];
        const toStop = finalStops[i + 1];
        const fromPoints = gridPoints.filter(gp => gp.city?.name === fromStop.city);
        const toPoints = gridPoints.filter(gp => gp.city?.name === toStop.city);
        if (fromPoints.length > 0 && toPoints.length > 0) {
          let minHops = Infinity;
          for (const fp of fromPoints) {
            for (const tp of toPoints) {
              const d = estimateHopDistance(fp.row, fp.col, tp.row, tp.col);
              if (d > 0 && d < minHops) minHops = d;
            }
          }
          if (minHops < Infinity) totalHopDistance += minHops;
        }
      }
      const distancePenaltyDivisor = 1 + totalHopDistance / DISTANCE_NORMALIZATION;
      const score = baseScore / distancePenaltyDivisor;

    validCandidates.push({
      stops: finalStops,
      score,
      netValue,
      estimatedTurns,
      buildCostEstimate: totalBuildCost,
      usageFeeEstimate: totalUsageFees, // JIRA-187: opponent track-usage fees
      reasoning: rawReasoning,
    });

    return { validCandidates, rejections };
  }

  /**
   * Compute travel turns for a chain leg: prevDeliveryCity → supplyCity → deliveryCity.
   *
   * Uses estimateHopDistance (BFS over hex grid) for accurate hop counts.
   * Falls back to Euclidean distance when estimateHopDistance returns 0 (unreachable).
   * Falls back to existingEstimatedTurns when gridPoints are unavailable for either city.
   */
  private computeChainLegTurns(
    fromCity: string,
    supplyCity: string | null,
    deliveryCity: string,
    buildCostToDelivery: number,
    gridPoints: GridPoint[],
    trainSpeed: number,
    existingEstimatedTurns: number,
  ): number {
    const fromPoints = gridPoints.filter(gp => gp.city?.name === fromCity);
    const supplyPoints = supplyCity ? gridPoints.filter(gp => gp.city?.name === supplyCity) : [];
    const deliveryPoints = gridPoints.filter(gp => gp.city?.name === deliveryCity);

    // Fall back to existing estimatedTurns if we can't resolve any city
    if (fromPoints.length === 0 || supplyPoints.length === 0 || deliveryPoints.length === 0) {
      return existingEstimatedTurns;
    }

    // Leg 1: prevDelivery → nextSupply
    let hopFromToSupply = Infinity;
    for (const fp of fromPoints) {
      for (const sp of supplyPoints) {
        const d = estimateHopDistance(fp.row, fp.col, sp.row, sp.col);
        if (d > 0 && d < hopFromToSupply) hopFromToSupply = d;
      }
    }
    // Euclidean fallback when BFS can't reach
    if (hopFromToSupply === Infinity) {
      let minEuc = Infinity;
      for (const fp of fromPoints) {
        for (const sp of supplyPoints) {
          const d = Math.sqrt((sp.row - fp.row) ** 2 + (sp.col - fp.col) ** 2);
          if (d < minEuc) minEuc = d;
        }
      }
      if (minEuc < Infinity) hopFromToSupply = minEuc;
    }

    // Leg 2: supply → delivery
    let hopSupplyToDelivery = Infinity;
    for (const sp of supplyPoints) {
      for (const dp of deliveryPoints) {
        const d = estimateHopDistance(sp.row, sp.col, dp.row, dp.col);
        if (d > 0 && d < hopSupplyToDelivery) hopSupplyToDelivery = d;
      }
    }
    // Euclidean fallback when BFS can't reach
    if (hopSupplyToDelivery === Infinity) {
      let minEuc = Infinity;
      for (const sp of supplyPoints) {
        for (const dp of deliveryPoints) {
          const d = Math.sqrt((dp.row - sp.row) ** 2 + (dp.col - sp.col) ** 2);
          if (d < minEuc) minEuc = d;
        }
      }
      if (minEuc < Infinity) hopSupplyToDelivery = minEuc;
    }

    const travelHops = (hopFromToSupply < Infinity ? hopFromToSupply : 0)
      + (hopSupplyToDelivery < Infinity ? hopSupplyToDelivery : 0);
    const travelTurns = travelHops > 0 ? Math.ceil(travelHops / trainSpeed) : 1;
    const buildTurns = Math.ceil(buildCostToDelivery / 20);

    return travelTurns + buildTurns;
  }

  /**
   * Classify a set of validator error strings into a human-readable rule name.
   * Used to build single-route retry feedback in planTrip.
   */
  private classifyValidationError(
    errors: string[],
  ): string {
    const combined = errors.join(' ').toLowerCase();
    if (combined.includes('pickup') || combined.includes('missing') || combined.includes('not carried')) {
      return 'missing_pickup';
    }
    if (combined.includes('capacity') || combined.includes('exceed') || combined.includes('too many')) {
      return 'capacity_exceeded';
    }
    if (combined.includes('not on route') || combined.includes('city not') || combined.includes('not reachable')) {
      return 'city_not_on_route';
    }
    if (combined.includes('not at supply') || combined.includes('unavailable') || combined.includes('not available')) {
      return 'load_not_at_supply';
    }
    if (combined.includes('pruned') || combined.includes('zero stop') || combined.includes('all stops')) {
      return 'pruned_to_zero';
    }
    // Default to missing_pickup as the most common failure mode
    return 'missing_pickup';
  }

  /**
   * JIRA-207B (R2): Extract the missing load type from validator error strings.
   * Returns the load type mentioned in a "missing_pickup" error, or null if not found.
   */
  private extractMissingLoad(errors: string[]): string | null {
    for (const err of errors) {
      // Try to extract load type from patterns like "DELIVER Hops to ..." or "missing PICKUP for Hops"
      const deliverMatch = err.match(/DELIVER\s+(\w+)\s+to/i);
      if (deliverMatch) return deliverMatch[1];
      const pickupMatch = err.match(/(?:missing|requires?)\s+(?:PICKUP\s+for\s+)?(\w+)/i);
      if (pickupMatch) return pickupMatch[1];
    }
    return null;
  }
}
