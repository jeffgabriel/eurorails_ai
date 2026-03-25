import { loadNdjsonLog, inferDecisionSource, isLlmModel, isValidGameId, listGameLogs, parseTurnRange, fmt, secs, loc } from '../services/logParser';
import { GameTurnLogEntry } from '../services/ai/GameLogger';

// Mock fs module
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  mkdirSync: jest.fn(),
  appendFile: jest.fn(),
}));

import { readFileSync, readdirSync, statSync } from 'fs';

const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockReaddirSync = readdirSync as jest.MockedFunction<typeof readdirSync>;
const mockStatSync = statSync as jest.MockedFunction<typeof statSync>;

describe('logParser', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('loadNdjsonLog', () => {
    it('should parse valid NDJSON lines', () => {
      const lines = [
        JSON.stringify({ turn: 1, action: 'move' }),
        JSON.stringify({ turn: 2, action: 'build' }),
      ].join('\n');
      mockReadFileSync.mockReturnValue(lines);

      const result = loadNdjsonLog<{ turn: number; action: string }>('/path/to/log.ndjson');

      expect(result).toEqual([
        { turn: 1, action: 'move' },
        { turn: 2, action: 'build' },
      ]);
    });

    it('should return empty array for missing files', () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

      const result = loadNdjsonLog('/nonexistent.ndjson');

      expect(result).toEqual([]);
    });

    it('should return empty array for empty files', () => {
      mockReadFileSync.mockReturnValue('');

      const result = loadNdjsonLog('/empty.ndjson');

      expect(result).toEqual([]);
    });

    it('should skip malformed JSON lines', () => {
      const lines = [
        JSON.stringify({ turn: 1 }),
        'not valid json {{{',
        JSON.stringify({ turn: 3 }),
      ].join('\n');
      mockReadFileSync.mockReturnValue(lines);

      const result = loadNdjsonLog<{ turn: number }>('/path/to/log.ndjson');

      expect(result).toEqual([{ turn: 1 }, { turn: 3 }]);
    });

    it('should handle whitespace-only files', () => {
      mockReadFileSync.mockReturnValue('   \n  \n  ');

      const result = loadNdjsonLog('/whitespace.ndjson');

      expect(result).toEqual([]);
    });
  });

  describe('inferDecisionSource', () => {
    it('should return decisionSource when present', () => {
      const entry = { decisionSource: 'trip-planner' } as GameTurnLogEntry;
      expect(inferDecisionSource(entry)).toBe('trip-planner');
    });

    it('should fall back to actorDetail', () => {
      const entry = { actorDetail: 'strategy-brain' } as GameTurnLogEntry;
      expect(inferDecisionSource(entry)).toBe('strategy-brain');
    });

    it('should infer from actor field for old logs', () => {
      expect(inferDecisionSource({ actor: 'heuristic' } as GameTurnLogEntry)).toBe('heuristic-fallback');
      expect(inferDecisionSource({ actor: 'guardrail' } as GameTurnLogEntry)).toBe('guardrail-enforcer');
      expect(inferDecisionSource({ actor: 'error' } as GameTurnLogEntry)).toBe('pipeline-error');
      expect(inferDecisionSource({ actor: 'system' } as GameTurnLogEntry)).toBe('route-executor');
      expect(inferDecisionSource({ actor: 'llm' } as GameTurnLogEntry)).toBe('strategy-brain');
    });

    it('should return unknown for entries with no metadata', () => {
      const entry = {} as GameTurnLogEntry;
      expect(inferDecisionSource(entry)).toBe('unknown');
    });
  });

  describe('isLlmModel', () => {
    it('should return false for undefined', () => {
      expect(isLlmModel(undefined)).toBe(false);
    });

    it('should return false for known non-LLM sources', () => {
      expect(isLlmModel('heuristic-fallback')).toBe(false);
      expect(isLlmModel('broke-bot-heuristic')).toBe(false);
      expect(isLlmModel('pipeline-error')).toBe(false);
      expect(isLlmModel('llm-failed')).toBe(false);
      expect(isLlmModel('route-executor')).toBe(false);
      expect(isLlmModel('initial-build-planner')).toBe(false);
      expect(isLlmModel('no-api-key')).toBe(false);
    });

    it('should return true for actual LLM model names', () => {
      expect(isLlmModel('claude-haiku-3-5')).toBe(true);
      expect(isLlmModel('claude-sonnet-4')).toBe(true);
      expect(isLlmModel('gemini-2.0-flash')).toBe(true);
    });
  });

  describe('isValidGameId', () => {
    it('should accept valid UUIDs', () => {
      expect(isValidGameId('abc123-def-456')).toBe(true);
      expect(isValidGameId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
    });

    it('should reject path traversal attempts', () => {
      expect(isValidGameId('../etc/passwd')).toBe(false);
      expect(isValidGameId('game/../../../etc')).toBe(false);
    });

    it('should reject special characters', () => {
      expect(isValidGameId('game;rm -rf /')).toBe(false);
      expect(isValidGameId('')).toBe(false);
      expect(isValidGameId('UPPERCASE')).toBe(false);
    });
  });

  describe('listGameLogs', () => {
    it('should return empty array for empty directory', () => {
      mockReaddirSync.mockReturnValue([]);

      const result = listGameLogs('/logs');

      expect(result).toEqual([]);
    });

    it('should return empty array when directory does not exist', () => {
      mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT'); });

      const result = listGameLogs('/nonexistent');

      expect(result).toEqual([]);
    });

    it('should list and summarize game logs', () => {
      mockReaddirSync.mockReturnValue([
        'game-abc123.ndjson' as unknown as ReturnType<typeof readdirSync>[0],
        'llm-abc123.ndjson' as unknown as ReturnType<typeof readdirSync>[0],
        'other.txt' as unknown as ReturnType<typeof readdirSync>[0],
      ] as ReturnType<typeof readdirSync>);
      mockStatSync.mockReturnValue({ mtime: new Date('2025-01-01') } as ReturnType<typeof statSync>);
      const logLine = JSON.stringify({
        turn: 1,
        playerId: 'p1',
        playerName: 'Bot-A',
        llmModel: 'claude-haiku-3-5',
        action: 'move',
        success: true,
        segmentsBuilt: 0,
        cost: 0,
        durationMs: 100,
      });
      mockReadFileSync.mockReturnValue(logLine);

      const result = listGameLogs('/logs');

      expect(result).toHaveLength(1);
      expect(result[0].gameId).toBe('abc123');
      expect(result[0].turnCount).toBe(1);
      expect(result[0].players).toEqual(['Bot-A']);
      expect(result[0].models).toEqual(['claude-haiku-3-5']);
    });

    it('should sort by lastModified descending', () => {
      mockReaddirSync.mockReturnValue([
        'game-old.ndjson' as unknown as ReturnType<typeof readdirSync>[0],
        'game-new.ndjson' as unknown as ReturnType<typeof readdirSync>[0],
      ] as ReturnType<typeof readdirSync>);
      mockStatSync.mockImplementation(((filePath: unknown) => {
        const p = String(filePath);
        if (p.includes('old')) return { mtime: new Date('2025-01-01') } as ReturnType<typeof statSync>;
        return { mtime: new Date('2025-06-01') } as ReturnType<typeof statSync>;
      }) as typeof statSync);
      mockReadFileSync.mockReturnValue('');

      const result = listGameLogs('/logs');

      expect(result[0].gameId).toBe('new');
      expect(result[1].gameId).toBe('old');
    });
  });

  describe('parseTurnRange', () => {
    it('should parse a range', () => {
      expect(parseTurnRange('5-15')).toEqual({ min: 5, max: 15 });
    });

    it('should parse a single turn', () => {
      expect(parseTurnRange('10')).toEqual({ min: 10, max: 10 });
    });
  });

  describe('formatting helpers', () => {
    it('fmt should format numbers', () => {
      expect(fmt(1000)).toMatch(/1.000|1,000/);
    });

    it('secs should format milliseconds', () => {
      expect(secs(1500)).toBe('1.5s');
    });

    it('loc should format positions', () => {
      expect(loc(null)).toBe('?');
      expect(loc(undefined)).toBe('?');
      expect(loc({ row: 5, col: 10 })).toBe('(5,10)');
      expect(loc({ row: 5, col: 10, cityName: 'Paris' })).toBe('Paris');
    });
  });
});
