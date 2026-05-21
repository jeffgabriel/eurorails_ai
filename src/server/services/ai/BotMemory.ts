/**
 * BotMemory — Tracks persistent state across bot turns for smarter decision-making.
 *
 * Write-through cache: in-memory Map is the primary store (hot path).
 * DB is written on every update and read on Map miss (cold path after server restart).
 * Bots resume exactly where they left off after a server restart.
 */

import { BotMemoryState } from '../../../shared/types/GameTypes';
import { db } from '../../db/index';

const memoryStore = new Map<string, BotMemoryState>();

function memoryKey(gameId: string, playerId: string): string {
  return `${gameId}:${playerId}`;
}

function defaultState(): BotMemoryState {
  return {
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 0,
    activeRoute: null,
    turnsOnRoute: 0,
    routeHistory: [],
    lastReasoning: null,
    lastPlanHorizon: null,
    previousRouteStops: null,
    consecutiveLlmFailures: 0,
  };
}

/**
 * Load bot memory from the database. Returns null if none exists or on error.
 * Best-effort — errors are logged but not thrown.
 */
async function loadMemoryFromDB(gameId: string, playerId: string): Promise<BotMemoryState | null> {
  try {
    const result = await db.query(
      'SELECT bot_memory FROM players WHERE id = $1 AND is_bot = true',
      [playerId],
    );
    const raw = result.rows[0]?.bot_memory;
    if (raw == null) {
      return null;
    }
    // JSONB is already parsed by pg driver; guard against corrupt data
    if (typeof raw !== 'object') {
      console.warn(`[BotMemory] Unexpected bot_memory type for player ${playerId}: ${typeof raw}`);
      return defaultState();
    }
    return raw as BotMemoryState;
  } catch (err) {
    console.error(`[BotMemory] Failed to load memory from DB for player ${playerId}:`, err);
    return null;
  }
}

/**
 * Save bot memory to the database. Best-effort — errors are logged but not thrown.
 */
async function saveMemoryToDB(gameId: string, playerId: string, state: BotMemoryState): Promise<void> {
  try {
    await db.query(
      'UPDATE players SET bot_memory = $1 WHERE id = $2',
      [JSON.stringify(state), playerId],
    );
  } catch (err) {
    console.error(`[BotMemory] Failed to save memory to DB for player ${playerId}:`, err);
  }
}

/**
 * Retrieve the current memory state for a bot in a specific game.
 * Returns Map state if present (hot path). On Map miss, falls back to DB.
 * Returns default state if neither Map nor DB has data.
 */
export async function getMemory(gameId: string, playerId: string): Promise<BotMemoryState> {
  const key = memoryKey(gameId, playerId);
  const cached = memoryStore.get(key);
  if (cached !== undefined) {
    return cached;
  }

  // Map miss — try DB (cold path: after server restart)
  const dbState = await loadMemoryFromDB(gameId, playerId);
  if (dbState !== null) {
    memoryStore.set(key, dbState);
    return dbState;
  }

  return defaultState();
}

/**
 * JIRA-253 Layer B: TTL for recentlyAbandonedRouteKeys entries.
 * Entries older than this many turns are evicted on each memory update.
 */
const ABANDONED_ROUTE_KEY_TTL_TURNS = 3;

/**
 * Evict stale entries from recentlyAbandonedRouteKeys based on the current turn.
 * Returns a new array with entries older than ABANDONED_ROUTE_KEY_TTL_TURNS removed.
 */
function evictStaleAbandonedRouteKeys(
  keys: Array<{ key: string; abandonedAtTurn: number }> | undefined,
  currentTurn: number,
): Array<{ key: string; abandonedAtTurn: number }> {
  if (!keys || keys.length === 0) return [];
  return keys.filter(entry => currentTurn - entry.abandonedAtTurn <= ABANDONED_ROUTE_KEY_TTL_TURNS);
}

/**
 * Update the memory state for a bot (shallow merge).
 * Writes through to DB after updating the in-memory Map.
 * Applies TTL eviction on recentlyAbandonedRouteKeys before persisting.
 */
export async function updateMemory(gameId: string, playerId: string, patch: Partial<BotMemoryState>): Promise<void> {
  const key = memoryKey(gameId, playerId);
  const cached = memoryStore.get(key);
  const current = cached !== undefined ? cached : defaultState();
  const merged = { ...current, ...patch };

  // Apply TTL eviction on the merged state so stale entries are cleared
  // on every turn update regardless of whether the patch touches this field.
  const currentTurn = merged.turnNumber ?? 0;
  merged.recentlyAbandonedRouteKeys = evictStaleAbandonedRouteKeys(
    merged.recentlyAbandonedRouteKeys,
    currentTurn,
  );

  memoryStore.set(key, merged);
  await saveMemoryToDB(gameId, playerId, merged);
}

/**
 * Clear all memory for a bot in a specific game.
 * Removes from in-memory Map and sets DB column to NULL.
 */
export async function clearMemory(gameId: string, playerId: string): Promise<void> {
  memoryStore.delete(memoryKey(gameId, playerId));
  try {
    await db.query(
      'UPDATE players SET bot_memory = NULL WHERE id = $1',
      [playerId],
    );
  } catch (err) {
    console.error(`[BotMemory] Failed to clear memory in DB for player ${playerId}:`, err);
  }
}

/**
 * Clear all bot memory for an entire game at game end.
 * Removes every in-memory entry keyed to this game (keys are `${gameId}:${playerId}`)
 * and best-effort clears the persisted bot_memory for the game's bots.
 * Idempotent — a gameId with no matching entries is a no-op.
 */
export async function clearGameMemory(gameId: string): Promise<void> {
  if (!gameId) return;

  const prefix = `${gameId}:`;
  for (const key of memoryStore.keys()) {
    if (key.startsWith(prefix)) {
      memoryStore.delete(key);
    }
  }

  try {
    await db.query(
      'UPDATE players SET bot_memory = NULL WHERE game_id = $1 AND is_bot = true',
      [gameId],
    );
  } catch (err) {
    console.error(`[BotMemory] Failed to clear game memory in DB for game ${gameId}:`, err);
  }
}
