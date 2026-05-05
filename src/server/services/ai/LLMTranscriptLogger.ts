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
 * JIRA-217: Extended with optimizer/selector diagnostic fields.
 *
 * Fires when short-circuit paths fire:
 *   - 'no_actionable_options': no affordable demand options to plan from.
 *   - 'keep_current_plan': existing plan is still valid; no replan needed.
 * Also populated by JIRA-217 optimizer+selector path with source/candidateCount etc.
 */
export interface TripPlannerSelectionDiagnostic {
  /**
   * Short-circuit or selector fallback reason (JIRA-207B R10c + JIRA-217).
   */
  fallbackReason?: 'no_actionable_options' | 'keep_current_plan' | 'invalid_id' | 'llm_failure' | 'single_candidate';
  /** JIRA-217: Which path produced the result. */
  source?: 'selector' | 'single_candidate' | 'fallback_top_ev' | 'legacy_generator';
  /** JIRA-217: Number of optimizer candidates. */
  candidateCount?: number;
  /** JIRA-217: ID of the chosen candidate. */
  chosenCandidateId?: number;
  /** JIRA-217: LLM rationale for the selection. */
  rationale?: string;
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
