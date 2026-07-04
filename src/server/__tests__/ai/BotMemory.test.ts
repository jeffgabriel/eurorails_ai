/**
 * BotMemory.clearGameMemory tests — BE-003
 *
 * Verifies game-scoped in-memory cleanup removes only the target game's
 * entries, clears the persisted bot_memory for the game's bots, and is
 * idempotent when called for a game with no remaining state.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// ── Mock external systems ─────────────────────────────────────────────────

jest.mock('../../db/index', () => ({
  db: {
    query: jest.fn<() => Promise<any>>(),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────

import { getMemory, updateMemory, clearGameMemory } from '../../services/ai/BotMemory';
import { db } from '../../db/index';

const mockQuery = db.query as unknown as jest.Mock<(...args: any[]) => Promise<any>>;

function mockResult(rows: any[]) {
  return { rows, command: '', rowCount: rows.length, oid: 0, fields: [] };
}

describe('BotMemory.clearGameMemory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: DB reads return no persisted memory, writes succeed.
    mockQuery.mockResolvedValue(mockResult([]));
  });

  it('removes only the target game\'s in-memory entries, leaving other games untouched', async () => {
    await updateMemory('game-A', 'player-1', { deliveryCount: 5 });
    await updateMemory('game-A', 'player-2', { deliveryCount: 3 });
    await updateMemory('game-B', 'player-1', { deliveryCount: 9 });

    await clearGameMemory('game-A');

    // game-A entries are gone → getMemory falls back to DB (empty) → default state
    const clearedA1 = await getMemory('game-A', 'player-1');
    const clearedA2 = await getMemory('game-A', 'player-2');
    expect(clearedA1.deliveryCount).toBe(0);
    expect(clearedA2.deliveryCount).toBe(0);

    // game-B entry is preserved in the in-memory Map
    const preservedB = await getMemory('game-B', 'player-1');
    expect(preservedB.deliveryCount).toBe(9);
  });

  it('issues a game-scoped DB clear for the game\'s bots', async () => {
    await updateMemory('game-C', 'player-1', { deliveryCount: 2 });
    mockQuery.mockClear();

    await clearGameMemory('game-C');

    expect(mockQuery).toHaveBeenCalledWith(
      'UPDATE players SET bot_memory = NULL WHERE game_id = $1 AND is_bot = true',
      ['game-C'],
    );
  });

  it('is idempotent — clearing a game with no entries does not throw', async () => {
    await expect(clearGameMemory('nonexistent-game')).resolves.toBeUndefined();
    await expect(clearGameMemory('nonexistent-game')).resolves.toBeUndefined();
  });

  it('ignores an empty gameId without touching the DB', async () => {
    mockQuery.mockClear();
    await clearGameMemory('');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('swallows DB errors so cleanup never throws', async () => {
    await updateMemory('game-D', 'player-1', { deliveryCount: 1 });
    mockQuery.mockRejectedValueOnce(new Error('db down'));

    await expect(clearGameMemory('game-D')).resolves.toBeUndefined();

    // In-memory entry is still removed even though the DB write failed
    const cleared = await getMemory('game-D', 'player-1');
    expect(cleared.deliveryCount).toBe(0);
  });
});
