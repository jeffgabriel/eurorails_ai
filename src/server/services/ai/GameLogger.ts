/**
 * GameLogger — Append-only NDJSON writer for bot turn debugging.
 *
 * Writes one JSON line per bot turn to `logs/game-{gameId}.ndjson`.
 * Designed for fast offline analysis: `Read` the file, `Grep` for fields.
 */

import { mkdirSync, appendFile } from 'fs';
import { join } from 'path';
import { AIActionType, GameState, TimelineStep } from '../../../shared/types/GameTypes';
import { VictoryCheckResult } from './BotTurnTrigger';
import type { EndGameTrace } from './victoryRules';

const LOGS_DIR = join(process.cwd(), 'logs');

/** Ensure logs directory exists (idempotent, sync is fine — runs once). */
function ensureDir(): void {
  mkdirSync(LOGS_DIR, { recursive: true });
}

/** Shape of a single turn log entry. */
export interface GameTurnLogEntry {
  turn: number;
  playerId: string;
  playerName?: string;
  timestamp: string;

  // Position & Movement
  positionStart?: { row: number; col: number; cityName?: string } | null;
  positionEnd?: { row: number; col: number; cityName?: string } | null;
  carriedLoads?: string[];
  movementPath?: { row: number; col: number }[];

  // Train details
  trainSpeed?: number;
  trainCapacity?: number;

  // Strategic state
  connectedMajorCities?: string[];
  activeRoute?: { stops: Array<{ action: string; loadType: string; city: string }>; currentStopIndex: number } | null;
  demandCards?: Array<{ loadType: string; supplyCity: string | null; deliveryCity: string; payout: number; cardIndex: number }>;
  /** JIRA-241: Persistent bot game phase for post-game traceability. */
  gameState?: GameState;

  // LLM Decision
  action: string;
  reasoning?: string;
  planHorizon?: string;
  llmLatencyMs?: number;
  tokenUsage?: { input: number; output: number };

  // Turn Composition Trace (JIRA-32 pass 2)
  composition?: {
    inputPlan: string[];
    outputPlan: string[];
    moveBudget: { total: number; used: number; wasted: number };
    a1: { citiesScanned: number; opportunitiesFound: number };
    a2: { iterations: number; terminationReason: string };
    a3: { movePreprended: boolean };
    build: { target: string | null; cost: number; skipped: boolean; upgradeConsidered: boolean };
    pickups: Array<{ load: string; city: string }>;
    deliveries: Array<{ load: string; city: string }>;
    // JIRA-179: Build Route Resolver — only present when ENABLE_BUILD_RESOLVER=true
    buildResolver?: {
      enabled: true;
      targetCity: string;
      budget: number;
      candidates: Array<{
        id: string;
        cost: number;
        segmentCount: number;
        reachesTarget: boolean;
        endpointDistance: number;
        anchorsHit: string[];
        segmentCompact: Array<[number, number, number, number]>;
      }>;
      selected: string;
      ruleBranch: string;
      reasonText: string;
      costDelta: number;
      anchorClassification: Array<{ coord: [number, number]; namedCity: string | null; kept: boolean }>;
    };
  };

  // Demand Ranking (enriched)
  demandRanking?: Array<{
    loadType: string;
    supplyCity: string | null;
    deliveryCity: string;
    payout: number;
    score: number;
    rank: number;
    efficiencyPerTurn?: number;
    estimatedTurns?: number;
    trackCostToSupply?: number;
    trackCostToDelivery?: number;
    supplyRarity?: string;
    isStale?: boolean;
  }>;

  // Strategic Context
  gamePhase?: string;
  cash?: number;
  train?: string;
  upgradeAdvice?: string;
  guardrailOverride?: boolean;
  guardrailReason?: string;

  // JIRA-89: Secondary delivery planning
  secondaryDelivery?: {
    action: string;
    reasoning: string;
    pickupCity?: string;
    loadType?: string;
    deliveryCity?: string;
    deadLoadsDropped?: string[];
  };

  // Trip Planning (JIRA-126, JIRA-210B: single-route shape)
  tripPlanning?: {
    trigger: string;
    /** Single-route stops rendered as action(load@city) strings. */
    stops?: string[];
    llmLatencyMs: number;
    llmTokens: { input: number; output: number };
    llmReasoning: string;
    /** JIRA-210B: Why the short-circuit path was taken. Only present when no_actionable_options or keep_current_plan fired. */
    fallbackReason?: 'no_actionable_options' | 'keep_current_plan' | 'single_option_shortcircuit';
  };

  // Turn Validation (JIRA-126)
  turnValidation?: {
    hardGates: Array<{ gate: string; passed: boolean; detail?: string }>;
    outcome: 'passed' | 'hard_reject';
    recomposeCount: number;
    firstViolation?: string;
    firstHardGates?: Array<{ gate: string; passed: boolean; detail?: string }>;
    phaseBStripped?: boolean;
  };

  // Build Advisor (JIRA-129)
  advisorAction?: string;
  advisorWaypoints?: [number, number][];
  advisorReasoning?: string;
  advisorLatencyMs?: number;
  solvencyRetries?: number;

  // Decision source — the pipeline component that produced this turn's action
  decisionSource?: string;

  // Actor & LLM Metadata (populated by Project 2)
  actor?: 'llm' | 'system' | 'heuristic' | 'guardrail' | 'error';
  actorDetail?: string;
  llmModel?: string;
  actionBreakdown?: Array<{ action: AIActionType; actor: 'llm' | 'system' | 'heuristic'; detail?: string }>;
  llmCallIds?: string[];
  llmSummary?: { callCount: number; totalLatencyMs: number; totalTokens: { input: number; output: number }; callers: string[] };
  actionTimeline?: TimelineStep[];
  originalPlan?: { action: string; reasoning: string };
  advisorUsedFallback?: boolean;
  // JIRA-148: Initial build planner evaluated options (only on initial build turns)
  initialBuildOptions?: Array<{
    rank: number; loadType: string; supplyCity: string; deliveryCity: string;
    startingCity: string; payout: number; totalBuildCost: number;
    buildCostToSupply: number; buildCostSupplyToDelivery: number;
    estimatedTurns: number; efficiency: number;
  }>;
  // Double delivery pairings evaluated during initial build
  initialBuildPairings?: Array<{
    rank: number; firstLoad: string; firstRoute: string;
    secondLoad: string; secondRoute: string; sharedHub: string | null;
    chainDistance: number; totalBuildCost: number; totalPayout: number;
    estimatedTurns: number; efficiency: number; pairingScore: number;
  }>;

  // JIRA-212: Structured victory check outcome for this turn (R4, R5)
  // Populated on every bot turn that runs checkBotVictory; omitted when check was skipped.
  victoryCheck?: VictoryCheckResult;

  /**
   * JIRA-265: Per-turn end-game state. Populated on every turn where
   * `gameState === 'end'`; absent when the bot is not in end-game state.
   *
   * Subsumes the prior dead fields `endGameLocked` / `fullWinCost` /
   * `winCompleterCount` (never written by any producer) with a single
   * structured object whose fields a reader can grep on:
   *   - `cashGapM` / `majorsGap` / `fullWinCostM` — what's left to win
   *   - `cheapestConnectors` — the unconnected majors needed to close the city condition
   *   - `victoryRouteProjection` — the per-turn fire-or-skip outcome of findFinalVictoryRoute
   *   - `endGameLocked` — current state of the planner's ranking carve-out flag
   *   - `activePlanProjection` — whether the current activeRoute will clinch, when, with what cash
   */
  endGame?: EndGameTrace;

  // Execution Results
  success: boolean;
  error?: string;
  segmentsBuilt: number;
  cost: number;
  durationMs: number;
  buildTargetCity?: string;
  loadsPickedUp?: Array<{ loadType: string; city: string }>;
  loadsDelivered?: Array<{ loadType: string; city: string; payment: number; cardId: number }>;
  milepostsMoved?: number;
  trackUsageFee?: number;
  /** Populated when an action was rejected by an event card restriction */
  rejectionReason?: { code: string; message: string };
  /**
   * JIRA-262: Per-turn snapshot of active event cards (Strike / Snow / Flood /
   * Derailment) at the moment the bot executed this turn. Includes restriction
   * zones, pendingLostTurns per player, expiry turn, drawing player. Undefined
   * or omitted when no events are active. Companion to the parallel
   * `logs/events-<gameId>.ndjson` event-lifecycle log.
   */
  activeEffects?: import('../../../shared/types/EventCard').ActiveEffect[];
  /**
   * JIRA-262: Per-turn snapshot of the bot's pending Flood-rebuild segments
   * (track erased by an active Flood event that this bot has not yet rebuilt).
   */
  pendingFloodRebuilds?: import('../../../shared/types/GameTypes').TrackSegment[];
}

/**
 * Append a turn log entry to the game's NDJSON file.
 * Best-effort: errors are logged but never thrown.
 */
export function appendTurn(gameId: string, entry: GameTurnLogEntry): void {
  try {
    ensureDir();
    const filePath = join(LOGS_DIR, `game-${gameId}.ndjson`);
    const line = JSON.stringify(entry) + '\n';
    appendFile(filePath, line, 'utf8', (err) => {
      if (err) {
        console.error(`[GameLogger] Failed to write turn log for game ${gameId}:`, err.message);
      }
    });
  } catch (err) {
    console.error(`[GameLogger] Failed to write turn log for game ${gameId}:`, err instanceof Error ? err.message : err);
  }
}
