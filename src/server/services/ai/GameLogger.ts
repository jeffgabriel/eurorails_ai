/**
 * GameLogger — Append-only NDJSON writer for bot turn debugging.
 *
 * Writes one JSON line per bot turn to `logs/game-{gameId}.ndjson`.
 * Designed for fast offline analysis: `Read` the file, `Grep` for fields.
 */

import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

const LOGS_DIR = join(process.cwd(), 'logs');

/** Ensure logs directory exists (idempotent). */
let dirCreated = false;
function ensureDir(): void {
  if (dirCreated) return;
  mkdirSync(LOGS_DIR, { recursive: true });
  dirCreated = true;
}

/** Shape of a single turn log entry. */
export interface GameTurnLogEntry {
  turn: number;
  playerId: string;
  timestamp: string;

  // LLM Decision
  action: string;
  reasoning?: string;
  planHorizon?: string;
  model?: string;
  llmLatencyMs?: number;
  tokenUsage?: { input: number; output: number };
  llmLog?: Array<{
    attemptNumber: number;
    status: string;
    responseText: string;
    error?: string;
    latencyMs: number;
  }>;

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
  };

  // Demand Ranking (enriched)
  demandRanking?: Array<{
    loadType: string;
    supplyCity: string;
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
  handQuality?: { score: number; staleCards: number; assessment: string };
  gamePhase?: string;
  cash?: number;
  train?: string;
  upgradeAdvice?: string;
  guardrailOverride?: boolean;
  guardrailReason?: string;

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
    appendFileSync(filePath, line, 'utf8');
  } catch (err) {
    console.error(`[GameLogger] Failed to write turn log for game ${gameId}:`, err instanceof Error ? err.message : err);
  }
}
