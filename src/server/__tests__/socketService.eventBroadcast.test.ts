/**
 * Unit tests for SocketService event card broadcasting methods.
 *
 * Tests verify that each broadcast method correctly calls emitToGame or
 * socket.emit with the appropriate event name and payload.
 *
 * Strategy: mock socket.io's Server so the io singleton is set without needing
 * a real server, then assert on mockTo / mockEmit calls.
 */

import { createServer } from 'http';
import { EventCardType, ActiveEffect } from '../../shared/types/EventCard';
import { TerrainType } from '../../shared/types/GameTypes';
import type {
  EventCardDrawnPayload,
  EventEffectAppliedPayload,
  EventEffectExpiredPayload,
} from '../services/socketService';
import { Socket } from 'socket.io';

// ─── Mock Socket.IO so initializeSocketIO works without a real server ─────────

const mockRoomEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockRoomEmit }));
const mockIoInstance = {
  use: jest.fn(),
  on: jest.fn(),
  to: mockTo,
  close: jest.fn(),
};

jest.mock('socket.io', () => ({
  Server: jest.fn(() => mockIoInstance),
}));

// Mock all heavy dependencies so we don't need a DB / auth service during tests
jest.mock('../db', () => ({
  db: { query: jest.fn() },
}));

jest.mock('../services/authService', () => ({
  AuthService: { verifyToken: jest.fn() },
}));

jest.mock('../services/gameService', () => ({
  GameService: { getGame: jest.fn() },
}));

jest.mock('../services/chatService', () => ({
  ChatService: {},
}));

jest.mock('../services/rateLimitService', () => ({
  rateLimitService: { checkLimit: jest.fn() },
}));

jest.mock('../services/gameChatLimitService', () => ({
  gameChatLimitService: {},
}));

jest.mock('../services/moderationService', () => ({
  moderationService: { check: jest.fn() },
}));

jest.mock('../services/ai/BotTurnTrigger', () => ({
  onTurnChange: jest.fn(),
  onHumanReconnect: jest.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSocket(): Socket {
  return {
    emit: jest.fn(),
    id: 'mock-socket-id',
  } as unknown as Socket;
}

const TEST_GAME_ID = 'game-abc-123';
const TEST_TIMESTAMP = '2024-01-01T00:00:00.000Z';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SocketService event card broadcasting', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    initializeSocketIO,
    emitEventCardDrawn,
    emitEventEffectApplied,
    emitEventEffectExpired,
    emitActiveEffects,
    // eslint-disable-next-line @typescript-eslint/no-var-requires
  } = require('../services/socketService') as {
    initializeSocketIO: (server: ReturnType<typeof createServer>) => unknown;
    emitEventCardDrawn: (gameId: string, payload: EventCardDrawnPayload) => void;
    emitEventEffectApplied: (gameId: string, payload: EventEffectAppliedPayload) => void;
    emitEventEffectExpired: (gameId: string, payload: EventEffectExpiredPayload) => void;
    emitActiveEffects: (socket: Socket, gameId: string, effects: ActiveEffect[]) => void;
  };

  beforeAll(() => {
    // Initialize the singleton so io != null inside all emit functions
    initializeSocketIO(createServer());
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── emitEventCardDrawn ────────────────────────────────────────────────────────

  describe('emitEventCardDrawn', () => {
    it('should broadcast event:card-drawn to the game room', () => {
      const payload: EventCardDrawnPayload = {
        gameId: TEST_GAME_ID,
        card: {
          id: 125,
          type: EventCardType.Derailment,
          title: 'Derailment!',
          description: 'All trains within 3 mileposts of Roma lose 1 turn and 1 load.',
          effectConfig: { type: EventCardType.Derailment, cities: ['Roma'], radius: 3 },
        },
        drawingPlayerId: 'player-1',
        drawingPlayerName: 'Alice',
        affectedZone: ['mp-100', 'mp-101'],
        affectedPlayerIds: ['player-2'],
        effectSummary: 'Derailment affecting 2 mileposts',
        duration: 'immediate',
        timestamp: TEST_TIMESTAMP,
      };

      emitEventCardDrawn(TEST_GAME_ID, payload);

      expect(mockTo).toHaveBeenCalledWith(TEST_GAME_ID);
      expect(mockRoomEmit).toHaveBeenCalledTimes(1);
      expect(mockRoomEmit).toHaveBeenCalledWith('event:card-drawn', payload);
    });

    it('should route to the correct game room', () => {
      const gameId = 'specific-game-999';
      const payload: EventCardDrawnPayload = {
        gameId,
        card: {
          id: 130,
          type: EventCardType.Snow,
          title: 'Snow!',
          description: 'Snow around Torino.',
          effectConfig: {
            type: EventCardType.Snow,
            centerCity: 'Torino',
            radius: 6,
            blockedTerrain: [TerrainType.Alpine],
          },
        },
        drawingPlayerId: 'player-3',
        drawingPlayerName: 'Bob',
        affectedZone: [],
        affectedPlayerIds: [],
        effectSummary: 'Snow affecting 0 mileposts',
        duration: 'persistent',
        timestamp: TEST_TIMESTAMP,
      };

      emitEventCardDrawn(gameId, payload);

      expect(mockTo).toHaveBeenCalledWith(gameId);
    });
  });

  // ── emitEventEffectApplied ────────────────────────────────────────────────────

  describe('emitEventEffectApplied', () => {
    it('should broadcast event:effect-applied to the game room', () => {
      const payload: EventEffectAppliedPayload = {
        gameId: TEST_GAME_ID,
        cardId: 125,
        effects: [
          { playerId: 'player-2', effectType: 'turn_lost', details: 'Derailment: lost 1 turn', amount: 1 },
          { playerId: 'player-2', effectType: 'load_lost', details: 'Derailment: lost 1 load', amount: 1 },
        ],
        timestamp: TEST_TIMESTAMP,
      };

      emitEventEffectApplied(TEST_GAME_ID, payload);

      expect(mockTo).toHaveBeenCalledWith(TEST_GAME_ID);
      expect(mockRoomEmit).toHaveBeenCalledTimes(1);
      expect(mockRoomEmit).toHaveBeenCalledWith('event:effect-applied', payload);
    });

    it('should handle empty effects array', () => {
      const payload: EventEffectAppliedPayload = {
        gameId: TEST_GAME_ID,
        cardId: 124,
        effects: [],
        timestamp: TEST_TIMESTAMP,
      };

      emitEventEffectApplied(TEST_GAME_ID, payload);

      expect(mockRoomEmit).toHaveBeenCalledWith('event:effect-applied', payload);
    });
  });

  // ── emitEventEffectExpired ────────────────────────────────────────────────────

  describe('emitEventEffectExpired', () => {
    it('should broadcast event:effect-expired to the game room', () => {
      const payload: EventEffectExpiredPayload = {
        gameId: TEST_GAME_ID,
        cardId: 131,
        timestamp: TEST_TIMESTAMP,
      };

      emitEventEffectExpired(TEST_GAME_ID, payload);

      expect(mockTo).toHaveBeenCalledWith(TEST_GAME_ID);
      expect(mockRoomEmit).toHaveBeenCalledTimes(1);
      expect(mockRoomEmit).toHaveBeenCalledWith('event:effect-expired', payload);
    });

    it('should pass the cardId through unchanged', () => {
      const cardId = 9999;
      const payload: EventEffectExpiredPayload = {
        gameId: TEST_GAME_ID,
        cardId,
        timestamp: TEST_TIMESTAMP,
      };

      emitEventEffectExpired(TEST_GAME_ID, payload);

      const [, emittedPayload] = mockRoomEmit.mock.calls[0] as [string, EventEffectExpiredPayload];
      expect(emittedPayload.cardId).toBe(cardId);
    });
  });

  // ── emitActiveEffects ─────────────────────────────────────────────────────────

  describe('emitActiveEffects', () => {
    it('should emit event:active-effects on the provided socket with gameId and activeEffects', () => {
      const socket = makeSocket();
      const activeEffects: ActiveEffect[] = [
        {
          cardId: 131,
          cardType: EventCardType.Snow,
          affectedZone: new Set(['mp-50', 'mp-51']),
          drawingPlayerId: 'player-1',
          drawingPlayerIndex: 0,
          expiresAfterTurnNumber: 3,
          restrictions: {
            movement: [{ type: 'half_rate', zone: ['mp-50', 'mp-51'] }],
            build: [],
            pickupDelivery: [],
          },
          pendingLostTurns: [],
        },
      ];

      emitActiveEffects(socket, TEST_GAME_ID, activeEffects);

      const mockEmit = socket.emit as jest.Mock;
      expect(mockEmit).toHaveBeenCalledTimes(1);

      const [eventName, payload] = mockEmit.mock.calls[0] as [string, Record<string, unknown>];
      expect(eventName).toBe('event:active-effects');
      expect(payload.gameId).toBe(TEST_GAME_ID);
      expect(payload.activeEffects).toBe(activeEffects);
      expect(typeof payload.timestamp).toBe('string');
    });

    it('should NOT broadcast to the room — only emit on the single socket', () => {
      const socket = makeSocket();

      emitActiveEffects(socket, TEST_GAME_ID, []);

      // io.to() must not be called — this is a targeted per-socket emit
      expect(mockTo).not.toHaveBeenCalled();
      expect((socket.emit as jest.Mock)).toHaveBeenCalledTimes(1);
    });

    it('should handle empty activeEffects array', () => {
      const socket = makeSocket();

      emitActiveEffects(socket, TEST_GAME_ID, []);

      const mockEmit = socket.emit as jest.Mock;
      const [, payload] = mockEmit.mock.calls[0] as [string, Record<string, unknown>];
      expect(payload.activeEffects).toEqual([]);
    });

    it('should include an ISO timestamp in the payload', () => {
      const socket = makeSocket();
      const before = new Date().toISOString();

      emitActiveEffects(socket, TEST_GAME_ID, []);

      const after = new Date().toISOString();
      const mockEmit = socket.emit as jest.Mock;
      const [, payload] = mockEmit.mock.calls[0] as [string, Record<string, unknown>];
      const ts = payload.timestamp as string;

      expect(ts >= before).toBe(true);
      expect(ts <= after).toBe(true);
    });
  });
});
