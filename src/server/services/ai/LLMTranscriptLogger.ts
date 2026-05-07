/**
 * LLMTranscriptLogger — Append-only NDJSON writer for LLM call/response data.
 *
 * Writes one JSON line per LLM invocation to `logs/llm-{gameId}.ndjson`.
 * Best-effort: errors are logged but never thrown.
 */

import { mkdirSync, appendFile } from 'fs';
import { join } from 'path';

const LOGS_DIR = join(process.cwd(), 'logs');

/** Ensure logs directory exists (idempotent, sync is fine — runs once). */
function ensureDir(): void {
  mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * JIRA-210B: TripPlanner selection diagnostic for short-circuit paths only.
 * The multi-candidate selection branches (chosen_*, llm_rejected_validated,
 * no_affordable_candidate) were removed by JIRA-210B. This diagnostic now fires
 * ONLY when one of the two JIRA-207B short-circuit paths is taken:
 *   - 'no_actionable_options': no affordable demand options to plan from.
 *   - 'keep_current_plan': existing plan is still valid; no replan needed.
 */
export interface TripPlannerSelectionDiagnostic {
  /**
   * Why the short-circuit path was taken (JIRA-207B R10c values, narrowed by JIRA-210B).
   */
  fallbackReason: 'no_actionable_options' | 'keep_current_plan';
}

/** Shape of a single LLM call transcript entry. */
export interface LLMTranscriptEntry {
  callId: string;
  gameId: string;
  playerId: string;
  playerName?: string;
  turn: number;
  timestamp: string;
  caller: string;
  method: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  responseText: string;
  status: 'success' | 'error' | 'timeout' | 'validation_error';
  error?: string;
  latencyMs: number;
  tokenUsage?: { input: number; output: number };
  attemptNumber: number;
  totalAttempts: number;
  /** JIRA-210B: TripPlanner short-circuit diagnostic. Only present when no_actionable_options or keep_current_plan fired. */
  tripPlannerSelection?: TripPlannerSelectionDiagnostic;
}

/**
 * Append an LLM call transcript entry to the game's LLM NDJSON file.
 * Best-effort: errors are logged but never thrown.
 */
export function appendLLMCall(gameId: string, entry: LLMTranscriptEntry): void {
  try {
    ensureDir();
    const filePath = join(LOGS_DIR, `llm-${gameId}.ndjson`);
    const line = JSON.stringify(entry) + '\n';
    appendFile(filePath, line, 'utf8', (err) => {
      if (err) {
        console.error(`[LLMTranscriptLogger] Failed to write LLM transcript for game ${gameId}:`, err.message);
      }
    });
  } catch (err) {
    console.error(`[LLMTranscriptLogger] Failed to write LLM transcript for game ${gameId}:`, err instanceof Error ? err.message : err);
  }
}
