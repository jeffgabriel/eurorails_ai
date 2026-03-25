/**
 * logParser — Shared NDJSON parsing and formatting utilities for game/LLM logs.
 *
 * Extracted from scripts/llm-transcript.ts for reuse by web log viewer routes.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { GameTurnLogEntry } from './ai/GameLogger';
import { LLMTranscriptEntry } from './ai/LLMTranscriptLogger';

const LOGS_DIR = join(process.cwd(), 'logs');

const GAME_ID_REGEX = /^[a-f0-9-]+$/;

/** Summary of a game log for the index page. */
export interface GameLogSummary {
  gameId: string;
  fileName: string;
  lastModified: Date;
  turnCount: number;
  players: string[];
  models: string[];
}

/** Validate a gameId string to prevent path traversal. */
export function isValidGameId(gameId: string): boolean {
  return GAME_ID_REGEX.test(gameId);
}

/**
 * Load and parse an NDJSON log file. Skips malformed lines silently.
 * Returns empty array for missing or empty files.
 */
export function loadNdjsonLog<T>(filePath: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8').trim();
  } catch {
    return [];
  }
  if (!raw) return [];
  return raw.split('\n').map(line => {
    try { return JSON.parse(line) as T; } catch { return null; }
  }).filter((entry): entry is T => entry !== null);
}

/**
 * Known non-LLM decision sources — these are pipeline components,
 * not actual LLM model identifiers.
 */
const NON_LLM_SOURCES = new Set([
  'heuristic-fallback',
  'broke-bot-heuristic',
  'pipeline-error',
  'llm-failed',
  'route-executor',
  'initial-build-planner',
  'no-api-key',
]);

/** Check whether a model string is an actual LLM model name (not a pipeline label). */
export function isLlmModel(model: string | undefined): boolean {
  if (!model) return false;
  return !NON_LLM_SOURCES.has(model);
}

/**
 * Infer decisionSource for old log entries that lack the field.
 * Uses the actor/actorDetail fields first (JIRA-143), then falls back
 * to the model field heuristic.
 */
export function inferDecisionSource(entry: GameTurnLogEntry): string {
  if (entry.decisionSource) return entry.decisionSource;
  if (entry.actorDetail) return entry.actorDetail;
  // Fallback: old logs only have model field which conflated source and model name
  if (entry.actor) {
    switch (entry.actor) {
      case 'heuristic': return 'heuristic-fallback';
      case 'guardrail': return 'guardrail-enforcer';
      case 'error': return 'pipeline-error';
      case 'system': return 'route-executor';
      case 'llm': return 'strategy-brain';
    }
  }
  return 'unknown';
}

/** Parse a turn range string like "5-15" or "10". */
export function parseTurnRange(range: string): { min: number; max: number } {
  if (range.includes('-')) {
    const [a, b] = range.split('-').map(Number);
    return { min: a, max: b };
  }
  const n = Number(range);
  return { min: n, max: n };
}

/** Format a number with locale separators. */
export function fmt(n: number): string {
  return n.toLocaleString();
}

/** Format milliseconds as seconds string. */
export function secs(ms: number): string {
  return (ms / 1000).toFixed(1) + 's';
}

/** Format a position as city name or coordinates. */
export function loc(pos: { row: number; col: number; cityName?: string } | null | undefined): string {
  if (!pos) return '?';
  return pos.cityName ?? `(${pos.row},${pos.col})`;
}

/**
 * List all game logs in the logs directory with summary metadata.
 * Returns sorted by lastModified descending (most recent first).
 */
export function listGameLogs(logsDir: string = LOGS_DIR): GameLogSummary[] {
  let files: string[];
  try {
    files = readdirSync(logsDir).filter(f => f.startsWith('game-') && f.endsWith('.ndjson'));
  } catch {
    return [];
  }

  const summaries: GameLogSummary[] = [];
  for (const fileName of files) {
    const filePath = join(logsDir, fileName);
    try {
      const stat = statSync(filePath);
      const gameId = fileName.replace(/^game-/, '').replace(/\.ndjson$/, '');
      const entries = loadNdjsonLog<GameTurnLogEntry>(filePath);
      const players = Array.from(new Set(entries.map(e => e.playerName ?? e.playerId)));
      const models = Array.from(new Set(
        entries
          .map(e => e.llmModel)
          .filter((m): m is string => !!m)
      ));
      summaries.push({
        gameId,
        fileName,
        lastModified: stat.mtime,
        turnCount: entries.length,
        players,
        models,
      });
    } catch {
      // Skip unreadable files
    }
  }

  summaries.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return summaries;
}

/**
 * Load game turn log entries for a specific game.
 * Returns null if the log file doesn't exist.
 */
export function loadGameLog(gameId: string, logsDir: string = LOGS_DIR): GameTurnLogEntry[] | null {
  const filePath = join(logsDir, `game-${gameId}.ndjson`);
  try {
    readFileSync(filePath); // Check existence
  } catch {
    return null;
  }
  return loadNdjsonLog<GameTurnLogEntry>(filePath);
}

/**
 * Load LLM transcript entries for a specific game.
 * Returns null if the log file doesn't exist.
 */
export function loadLLMTranscript(gameId: string, logsDir: string = LOGS_DIR): LLMTranscriptEntry[] | null {
  const filePath = join(logsDir, `llm-${gameId}.ndjson`);
  try {
    readFileSync(filePath); // Check existence
  } catch {
    return null;
  }
  return loadNdjsonLog<LLMTranscriptEntry>(filePath);
}
