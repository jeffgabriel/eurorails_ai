/**
 * GameLogger unit tests — AC4: per-turn record includes gameState field
 *
 * Validates that GameTurnLogEntry schema includes gameState (JIRA-241) and
 * that appendTurn emits entries with the field correctly.
 *
 * Note: appendTurn uses fs.appendFile (async, fire-and-forget). The tests mock
 * fs at the module boundary so the write is observed synchronously via the
 * captured call arguments — no race against the real filesystem.
 */

import { GameState } from '../../../shared/types/GameTypes';

const appendFileMock = jest.fn(
  (_path: string, _data: string, _enc: string, cb: (err: Error | null) => void) => cb(null),
);
const mkdirSyncMock = jest.fn();

jest.mock('fs', () => ({
  appendFile: (...args: unknown[]) => appendFileMock(...(args as Parameters<typeof appendFileMock>)),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
}));

// Import AFTER jest.mock so the module under test picks up the mocked fs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { appendTurn } = require('../../services/ai/GameLogger') as typeof import('../../services/ai/GameLogger');
type GameTurnLogEntry = import('../../services/ai/GameLogger').GameTurnLogEntry;

const TEST_GAME_ID = 'test-gamelogger-jira241';

function makeEntry(overrides: Partial<GameTurnLogEntry> = {}): GameTurnLogEntry {
  return {
    turn: 1,
    playerId: 'bot-1',
    timestamp: '2026-05-15T22:00:00.000Z',
    action: 'MoveAndDeliver',
    ...overrides,
  } as unknown as GameTurnLogEntry;
}

function lastWrittenLine(): string {
  expect(appendFileMock).toHaveBeenCalled();
  const lastCall = appendFileMock.mock.calls[appendFileMock.mock.calls.length - 1];
  // Args: [path, data, encoding, callback]
  return String(lastCall[1]).trim();
}

describe('GameLogger — AC4: gameState field in per-turn record', () => {
  beforeEach(() => {
    appendFileMock.mockClear();
    mkdirSyncMock.mockClear();
  });

  it('AC4(a): GameTurnLogEntry schema accepts gameState field (TypeScript type check)', () => {
    // Compile-time check — if GameTurnLogEntry doesn't include gameState, this
    // assignment fails typecheck.
    const entry: GameTurnLogEntry = makeEntry({ gameState: GameState.End });
    expect(entry.gameState).toBe(GameState.End);
  });

  it('AC4(b): appendTurn emits a record that includes gameState when set to End', () => {
    appendTurn(TEST_GAME_ID, makeEntry({ gameState: GameState.End }));
    const parsed = JSON.parse(lastWrittenLine());
    expect(parsed.gameState).toBe('end');
  });

  it('AC4(c): appendTurn emits a record that includes gameState when set to Mid', () => {
    appendTurn(TEST_GAME_ID, makeEntry({ gameState: GameState.Mid }));
    const parsed = JSON.parse(lastWrittenLine());
    expect(parsed.gameState).toBe('mid');
  });

  it('AC4(d): appendTurn works when gameState is omitted (optional field)', () => {
    appendTurn(TEST_GAME_ID, makeEntry());
    const parsed = JSON.parse(lastWrittenLine());
    expect(parsed.gameState).toBeUndefined();
  });
});
