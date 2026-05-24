/**
 * WhisperService Unit Tests
 * Tests for whisper advice recording and retrieval
 */

import { WhisperService } from '../services/ai/WhisperService';
import { mockDb, resetDbMock } from './mocks/db.mock';
import type { WhisperSubmitPayload } from '../../shared/types/WhisperTypes';
import type { WorldSnapshot } from '../../shared/types/GameTypes';

// Mock db module
jest.mock('../db/index', () => ({ db: require('./mocks/db.mock').mockDb }));

// Mock WorldSnapshotService.capture
const mockCapture = jest.fn();
jest.mock('../services/ai/WorldSnapshotService', () => ({
  capture: (...args: any[]) => mockCapture(...args),
}));

const makeSnapshot = (overrides?: Partial<WorldSnapshot>): WorldSnapshot => ({
  gameId: 'game-1',
  gameStatus: 'active' as any,
  turnNumber: 5,
  bot: {
    playerId: 'bot-player-1',
    userId: 'bot-user-1',
    money: 120,
    position: { row: 10, col: 20 },
    existingSegments: [],
    demandCards: [],
    resolvedDemands: [],
    trainType: 'FastFreight',
    loads: [],
    botConfig: {
      skillLevel: 'hard',
      name: 'TestBot',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    },
    connectedMajorCityCount: 3,
  },
  allPlayerTracks: [],
  loadAvailability: {},
  ...overrides,
});

const makePayload = (overrides?: Partial<WhisperSubmitPayload>): WhisperSubmitPayload => ({
  gameId: 'game-1',
  turnNumber: 5,
  botPlayerId: 'bot-player-1',
  advice: 'Should have gone to Berlin first',
  botTurnSummary: {
    action: 'MoveTrain',
    reasoning: 'Heading to Hamburg for Steel pickup',
    cost: 0,
    segmentsBuilt: 0,
    milepostsMoved: 9,
  },
  ...overrides,
});

describe('WhisperService', () => {
  beforeEach(() => {
    resetDbMock();
    mockCapture.mockReset();
  });

  describe('recordWhisper', () => {
    it('should call WorldSnapshotService.capture with correct gameId and botPlayerId', async () => {
      const snapshot = makeSnapshot();
      mockCapture.mockResolvedValue(snapshot);
      mockDb.query.mockResolvedValue({
        rows: [{ id: 'whisper-1', created_at: '2026-03-16T00:00:00Z' }],
        rowCount: 1,
      });

      const payload = makePayload();
      await WhisperService.recordWhisper(payload, 'human-user-1');

      expect(mockCapture).toHaveBeenCalledWith('game-1', 'bot-player-1');
    });

    it('should extract metadata from snapshot botConfig fields', async () => {
      const snapshot = makeSnapshot();
      mockCapture.mockResolvedValue(snapshot);
      mockDb.query.mockResolvedValue({
        rows: [{ id: 'whisper-1', created_at: '2026-03-16T00:00:00Z' }],
        rowCount: 1,
      });

      const result = await WhisperService.recordWhisper(makePayload(), 'human-user-1');

      expect(result.metadata).toEqual({
        gamePhase: 'active',
        botSkillLevel: 'hard',
        botProvider: 'anthropic',
        botModel: 'claude-sonnet-4-20250514',
        botMoney: 120,
        botTrainType: 'FastFreight',
        botConnectedCities: 3,
      });
    });

    it('should insert correct columns into whisper_advice table', async () => {
      const snapshot = makeSnapshot();
      mockCapture.mockResolvedValue(snapshot);
      mockDb.query.mockResolvedValue({
        rows: [{ id: 'whisper-1', created_at: '2026-03-16T00:00:00Z' }],
        rowCount: 1,
      });

      const payload = makePayload();
      await WhisperService.recordWhisper(payload, 'human-user-1');

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO whisper_advice'),
        expect.arrayContaining([
          'game-1',
          5,
          'bot-player-1',
          'human-user-1',
          'Should have gone to Berlin first',
        ]),
      );
    });

    it('should return WhisperRecord with generated id and timestamp', async () => {
      const snapshot = makeSnapshot();
      mockCapture.mockResolvedValue(snapshot);
      mockDb.query.mockResolvedValue({
        rows: [{ id: 'whisper-uuid-123', created_at: '2026-03-16T12:00:00Z' }],
        rowCount: 1,
      });

      const result = await WhisperService.recordWhisper(makePayload(), 'human-user-1');

      expect(result.id).toBe('whisper-uuid-123');
      expect(result.createdAt).toBe('2026-03-16T12:00:00Z');
      expect(result.gameId).toBe('game-1');
      expect(result.turnNumber).toBe(5);
      expect(result.botPlayerId).toBe('bot-player-1');
      expect(result.humanPlayerId).toBe('human-user-1');
      expect(result.advice).toBe('Should have gone to Berlin first');
      expect(result.botDecision.action).toBe('MoveTrain');
      expect(result.gameStateSnapshot).toBe(snapshot);
    });

    it('should handle missing botConfig fields with defaults', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          botConfig: null,
        },
      });
      mockCapture.mockResolvedValue(snapshot);
      mockDb.query.mockResolvedValue({
        rows: [{ id: 'whisper-1', created_at: '2026-03-16T00:00:00Z' }],
        rowCount: 1,
      });

      const result = await WhisperService.recordWhisper(makePayload(), 'human-user-1');

      expect(result.metadata.botSkillLevel).toBe('unknown');
      expect(result.metadata.botProvider).toBe('unknown');
      expect(result.metadata.botModel).toBe('unknown');
    });
  });

  describe('getWhispers', () => {
    it('should query with gameId filter', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await WhisperService.getWhispers('game-1');

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('game_id = $1'),
        ['game-1'],
      );
    });

    it('should apply optional turnNumber filter', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await WhisperService.getWhispers('game-1', { turnNumber: 5 });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('turn_number = $2'),
        ['game-1', 5],
      );
    });

    it('should apply optional botPlayerId filter', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await WhisperService.getWhispers('game-1', { botPlayerId: 'bot-1' });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('bot_player_id = $2'),
        ['game-1', 'bot-1'],
      );
    });

    it('should apply both filters together', async () => {
      mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await WhisperService.getWhispers('game-1', { turnNumber: 3, botPlayerId: 'bot-1' });

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('turn_number = $2'),
        expect.arrayContaining(['game-1', 3, 'bot-1']),
      );
    });

    it('should map DB rows to WhisperRecord format', async () => {
      mockDb.query.mockResolvedValue({
        rows: [{
          id: 'w-1',
          game_id: 'game-1',
          turn_number: 5,
          bot_player_id: 'bot-1',
          human_player_id: 'human-1',
          advice: 'Go to Berlin',
          bot_decision: { action: 'MoveTrain', reasoning: 'test', cost: 0, segmentsBuilt: 0 },
          game_state_snapshot: { gameId: 'game-1' },
          metadata: { gamePhase: 'active' },
          created_at: '2026-03-16T00:00:00Z',
        }],
        rowCount: 1,
      });

      const result = await WhisperService.getWhispers('game-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('w-1');
      expect(result[0].gameId).toBe('game-1');
      expect(result[0].advice).toBe('Go to Berlin');
    });
  });
});
