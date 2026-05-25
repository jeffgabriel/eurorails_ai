/**
 * EventLogger unit tests (JIRA-262).
 *
 * Verifies that appendEvent writes one JSON line per call to
 * `logs/events-<gameId>.ndjson`, that failures don't throw, and that
 * each EventLogPhase shape round-trips correctly through JSON.stringify.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockAppendFile = jest.fn((_path: any, _line: any, _enc: any, cb: any) => {
  cb(null);
});
const mockMkdirSync = jest.fn();

jest.mock('fs', () => ({
  appendFile: (path: any, line: any, enc: any, cb: any) => mockAppendFile(path, line, enc, cb),
  mkdirSync: (path: any, opts: any) => mockMkdirSync(path, opts),
}));

import { appendEvent } from '../../services/ai/EventLogger';

describe('EventLogger.appendEvent (JIRA-262)', () => {
  beforeEach(() => {
    mockAppendFile.mockClear();
    mockMkdirSync.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes a drawn entry to logs/events-<gameId>.ndjson with a trailing newline', () => {
    appendEvent('game-abc', {
      timestamp: '2026-05-24T12:00:00.000Z',
      turn: 7,
      phase: 'drawn',
      cardId: 121,
      cardType: 'Strike',
      drawingPlayerId: 'player-1',
      drawingPlayerIndex: 0,
      affectedZone: ['10,11', '10,12'],
      restrictionTypes: ['no_pickup_delivery'],
      expiresAfterTurnNumber: 8,
      note: 'Drawn by Haiku',
    });

    expect(mockMkdirSync).toHaveBeenCalledTimes(1);
    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const [path, line] = mockAppendFile.mock.calls[0];
    expect(String(path)).toContain('events-game-abc.ndjson');
    const parsed = JSON.parse(String(line).trimEnd());
    expect(parsed).toMatchObject({
      phase: 'drawn',
      cardId: 121,
      cardType: 'Strike',
      drawingPlayerId: 'player-1',
      affectedZone: ['10,11', '10,12'],
      expiresAfterTurnNumber: 8,
    });
    expect(String(line)).toMatch(/\n$/);
  });

  it('writes an expired entry with a list of cardIds', () => {
    appendEvent('game-abc', {
      timestamp: '2026-05-24T12:01:00.000Z',
      turn: 8,
      phase: 'expired',
      expiredCardIds: [121, 122],
    });
    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(mockAppendFile.mock.calls[0][1]).trimEnd());
    expect(parsed.phase).toBe('expired');
    expect(parsed.expiredCardIds).toEqual([121, 122]);
  });

  it('writes a consumed entry naming the player whose lost turn was consumed', () => {
    appendEvent('game-abc', {
      timestamp: '2026-05-24T12:02:00.000Z',
      turn: -1,
      phase: 'consumed',
      consumedPlayerId: 'player-2',
    });
    const parsed = JSON.parse(String(mockAppendFile.mock.calls[0][1]).trimEnd());
    expect(parsed).toMatchObject({ phase: 'consumed', consumedPlayerId: 'player-2' });
  });

  it('does not throw when appendFile errors — observability must not break the game loop', () => {
    mockAppendFile.mockImplementationOnce((_path: any, _line: any, _enc: any, cb: any) => {
      cb(new Error('ENOSPC: disk full'));
    });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      appendEvent('game-abc', {
        timestamp: '2026-05-24T12:03:00.000Z',
        turn: 1,
        phase: 'drawn',
        cardId: 121,
      });
    }).not.toThrow();
    consoleSpy.mockRestore();
  });

  it('does not throw when mkdirSync errors synchronously', () => {
    mockMkdirSync.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      appendEvent('game-abc', {
        timestamp: '2026-05-24T12:04:00.000Z',
        turn: 1,
        phase: 'drawn',
        cardId: 121,
      });
    }).not.toThrow();
    consoleSpy.mockRestore();
  });
});
