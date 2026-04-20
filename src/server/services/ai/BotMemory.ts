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
    console.log(`[BotMemory] Loaded memory from DB for player ${playerId} in game ${gameId}`);
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
 * Update the memory state for a bot (shallow merge).
 * Writes through to DB after updating the in-memory Map.
 */
export async function updateMemory(gameId: string, playerId: string, patch: Partial<BotMemoryState>): Promise<void> {
  const key = memoryKey(gameId, playerId);
  const cached = memoryStore.get(key);
  const current = cached !== undefined ? cached : defaultState();
  const merged = { ...current, ...patch };
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
