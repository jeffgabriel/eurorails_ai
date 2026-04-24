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
 * JIRA-194: Per-candidate diagnostic record for TripPlanner selection overrides.
 * Populated ONLY when the LLM's chosenIndex was not honored.
 */
export interface TripPlannerSelectionDiagnostic {
  /** The chosenIndex the LLM returned. */
  llmChosenIndex: number;
  /** The llmIndex actually selected (-1 when no validated candidates). */
  actualSelectedLlmIndex: number;
  /** Why the LLM's choice was not honored. */
  fallbackReason: 'chosen_not_in_validated' | 'chosen_zero_stops';
  /** Per-candidate evidence: validated candidates have empty validatorErrors. */
  candidates: Array<{
    llmIndex: number;
    rawStops: Array<{ action: string; load: string; city: string | null }>;
    validatorErrors: string[];
    prunedToZero: boolean;
  }>;
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
  /** JIRA-194: TripPlanner selection override diagnostic. Only present when LLM chosenIndex was not honored. */
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
