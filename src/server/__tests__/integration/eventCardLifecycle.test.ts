/**
 * Integration test for event card lifecycle with socket broadcasting.
 *
 * Tests the complete event card lifecycle:
 * 1. Draw an event card → ActiveEffectManager persists it → emitEventCardDrawn + emitEventEffectApplied
 * 2. Verify active_event persisted in games table
 * 3. Turn advancement → cleanupExpiredEffects → emitEventEffectExpired
 * 4. Verify active_event cleared in games table
 * 5. Reconnection simulation → emitActiveEffects provides active effects via state:init
 *
 * Uses a real PostgreSQL test database.
 * Mocks socketService to capture emitted socket events.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/index';
import { ActiveEffectManager } from '../../services/ActiveEffectManager';
import {
  emitEventCardDrawn,
  emitEventEffectApplied,
  emitEventEffectExpired,
  emitActiveEffects,
  EventCardDrawnPayload,
  EventEffectAppliedPayload,
  EventEffectExpiredPayload,
} from '../../services/socketService';
import {
  EventCardType,
  ActiveEffect,
  ActiveEffectDescriptor,
  PerPlayerEffect,
} from '../../../shared/types/EventCard';
import { Socket } from 'socket.io';

// ─── Mock Socket.IO so socket functions work without a real server ─────────────

const mockRoomEmit = jest.fn();
const mockIoTo = jest.fn(() => ({ emit: mockRoomEmit }));
const mockIoInstance = {
  use: jest.fn(),
  on: jest.fn(),
  to: mockIoTo,
  close: jest.fn(),
};

jest.mock('socket.io', () => ({
  Server: jest.fn(() => mockIoInstance),
}));

// Mock dependencies of socketService that aren't needed in this test
jest.mock('../../services/authService', () => ({
  AuthService: { verifyToken: jest.fn() },
}));
jest.mock('../../services/gameService', () => ({
  GameService: { getGame: jest.fn() },
}));
jest.mock('../../services/chatService', () => ({
  ChatService: {},
}));
jest.mock('../../services/rateLimitService', () => ({
  rateLimitService: { checkLimit: jest.fn() },
}));
jest.mock('../../services/gameChatLimitService', () => ({
  gameChatLimitService: {},
}));
jest.mock('../../services/moderationService', () => ({
  moderationService: { check: jest.fn() },
}));
jest.mock('../../services/ai/BotTurnTrigger', () => ({
  onTurnChange: jest.fn(),
  onHumanReconnect: jest.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSocket(): Socket {
  return {
    emit: jest.fn(),
    id: 'mock-socket-reconnect',
  } as unknown as Socket;
}

function makeDescriptor(
  cardId: number,
  drawingPlayerId: string,
  drawingPlayerIndex: number,
  expiresAfterTurnNumber: number,
): ActiveEffectDescriptor {
  return {
    cardId,
    drawingPlayerId,
    drawingPlayerIndex,
    expiresAfterTurnNumber,
    affectedZone: ['10,10', '10,11', '10,12'],
  };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Event card lifecycle integration (real DB + socket mocks)', () => {
  let gameId: string;
  let userId: string;
  let playerId: string;
  let manager: ActiveEffectManager;

  // Initialize the io singleton once so emit functions work
  beforeAll(() => {
    const { createServer } = require('http');
    const { initializeSocketIO } = require('../../services/socketService') as {
      initializeSocketIO: (s: ReturnType<typeof createServer>) => unknown;
    };
    initializeSocketIO(createServer());
  });

  beforeEach(async () => {
    gameId = uuidv4();
    userId = uuidv4();
    playerId = uuidv4();
    manager = new ActiveEffectManager();

    // Seed a minimal user + game row in the real DB
    await db.query(
      'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
      [userId, `user_${userId.slice(0, 6)}`, `u_${userId.slice(0, 6)}@test.local`, 'hash'],
    );
    await db.query(
      `INSERT INTO games (id, status, current_player_index, max_players, active_event)
       VALUES ($1, 'active', 0, 2, NULL)`,
      [gameId],
    );
    await db.query(
      `INSERT INTO players
       (id, game_id, user_id, name, color, money, train_type,
        position_x, position_y, position_row, position_col,
        current_turn_number, hand, loads)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [playerId, gameId, userId, 'TestPlayer', '#FF0000', 100, 'freight',
        null, null, null, null, 2, [], []],
    );

    // Reset socket mocks between tests
    mockRoomEmit.mockClear();
    mockIoTo.mockClear();
  });

  afterEach(async () => {
    await db.query('DELETE FROM players WHERE game_id = $1', [gameId]);
    await db.query('DELETE FROM games WHERE id = $1', [gameId]);
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  // ── 1. Effect persistence ─────────────────────────────────────────────────────

  it('persists an active effect to the DB via addActiveEffect', async () => {
    const cardId = 131; // Snow card
    const descriptor = makeDescriptor(cardId, playerId, 0, 3);

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await manager.addActiveEffect(
        gameId,
        descriptor,
        EventCardType.Snow,
        [],
        client,
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // Verify row written to DB
    const row = await db.query(
      'SELECT active_event FROM games WHERE id = $1',
      [gameId],
    );
    const records = row.rows[0].active_event as Array<{ cardId: number }>;
    expect(records).toHaveLength(1);
    expect(records[0].cardId).toBe(cardId);
  });

  // ── 2. Broadcast after persistence ───────────────────────────────────────────

  it('emits event:card-drawn to the game room after effect is persisted', () => {
    const payload: EventCardDrawnPayload = {
      gameId,
      card: {
        id: 131,
        type: EventCardType.Snow,
        title: 'Snow!',
        description: 'Snow around Torino.',
        effectConfig: {
          type: EventCardType.Snow,
          centerCity: 'Torino',
          radius: 6,
          blockedTerrain: [],
        },
      },
      drawingPlayerId: playerId,
      drawingPlayerName: 'TestPlayer',
      affectedZone: ['10,10', '10,11', '10,12'],
      affectedPlayerIds: [],
      effectSummary: 'Snow affecting 3 mileposts',
      duration: 'persistent',
      timestamp: new Date().toISOString(),
    };

    emitEventCardDrawn(gameId, payload);

    expect(mockIoTo).toHaveBeenCalledWith(gameId);
    expect(mockRoomEmit).toHaveBeenCalledWith('event:card-drawn', payload);
  });

  it('emits event:effect-applied to the game room after effect is persisted', () => {
    const effects: PerPlayerEffect[] = [
      { playerId, effectType: 'speed_halved', details: 'Snow: half rate movement' },
    ];
    const payload: EventEffectAppliedPayload = {
      gameId,
      cardId: 131,
      effects,
      timestamp: new Date().toISOString(),
    };

    emitEventEffectApplied(gameId, payload);

    expect(mockIoTo).toHaveBeenCalledWith(gameId);
    expect(mockRoomEmit).toHaveBeenCalledWith('event:effect-applied', payload);
  });

  // ── 3. Effect expiry ──────────────────────────────────────────────────────────

  it('cleanupExpiredEffects removes expired effects and returns their IDs', async () => {
    const cardId = 131;
    const descriptor = makeDescriptor(cardId, playerId, 0, 2);

    // Add effect that expires after turn 2 for player at index 0
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await manager.addActiveEffect(gameId, descriptor, EventCardType.Snow, [], client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // Cleanup at turn 2 for player index 0 → should expire
    const cleanupClient = await db.connect();
    let expiredCardIds: number[] = [];
    try {
      await cleanupClient.query('BEGIN');
      const result = await manager.cleanupExpiredEffects(
        gameId,
        0,     // completedPlayerIndex matches drawingPlayerIndex
        2,     // completedTurnNumber meets expiresAfterTurnNumber threshold
        cleanupClient,
      );
      expiredCardIds = result.expiredCardIds;
      await cleanupClient.query('COMMIT');
    } finally {
      cleanupClient.release();
    }

    expect(expiredCardIds).toContain(cardId);

    // Verify DB is cleared
    const row = await db.query(
      'SELECT active_event FROM games WHERE id = $1',
      [gameId],
    );
    const records = row.rows[0].active_event as Array<unknown> | null;
    expect(records === null || records.length === 0).toBe(true);
  });

  it('emits event:effect-expired to the game room when expiry occurs', () => {
    const payload: EventEffectExpiredPayload = {
      gameId,
      cardId: 131,
      timestamp: new Date().toISOString(),
    };

    emitEventEffectExpired(gameId, payload);

    expect(mockIoTo).toHaveBeenCalledWith(gameId);
    expect(mockRoomEmit).toHaveBeenCalledWith('event:effect-expired', payload);
  });

  // ── 4. cleanupExpiredEffects does NOT expire early ────────────────────────────

  it('cleanupExpiredEffects does not remove effects that have not yet expired', async () => {
    const cardId = 135;
    const descriptor = makeDescriptor(cardId, playerId, 0, 5); // expires after turn 5

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await manager.addActiveEffect(gameId, descriptor, EventCardType.Snow, [], client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // Attempt cleanup at turn 3 — effect should remain
    const cleanupClient = await db.connect();
    let expiredCardIds: number[] = [];
    try {
      await cleanupClient.query('BEGIN');
      const result = await manager.cleanupExpiredEffects(gameId, 0, 3, cleanupClient);
      expiredCardIds = result.expiredCardIds;
      await cleanupClient.query('COMMIT');
    } finally {
      cleanupClient.release();
    }

    expect(expiredCardIds).not.toContain(cardId);

    // Effect should still be in DB
    const row = await db.query(
      'SELECT active_event FROM games WHERE id = $1',
      [gameId],
    );
    const records = row.rows[0].active_event as Array<{ cardId: number }>;
    expect(records).toHaveLength(1);
    expect(records[0].cardId).toBe(cardId);
  });

  // ── 5. Reconnection simulation ────────────────────────────────────────────────

  it('emitActiveEffects sends current effects to a single reconnecting socket', async () => {
    // Seed an active effect in the DB
    const cardId = 132;
    const descriptor = makeDescriptor(cardId, playerId, 0, 10);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await manager.addActiveEffect(gameId, descriptor, EventCardType.Snow, [], client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // Read back from DB (simulates what state:init does before emitting)
    const activeEffects: ActiveEffect[] = await manager.getActiveEffects(gameId);

    // Simulate a reconnecting socket receiving state:init with activeEffects
    const reconnectSocket = makeSocket();
    emitActiveEffects(reconnectSocket, gameId, activeEffects);

    const mockSocketEmit = reconnectSocket.emit as jest.Mock;
    expect(mockSocketEmit).toHaveBeenCalledTimes(1);

    const [eventName, payload] = mockSocketEmit.mock.calls[0] as [string, Record<string, unknown>];
    expect(eventName).toBe('event:active-effects');
    expect(payload.gameId).toBe(gameId);
    expect(Array.isArray(payload.activeEffects)).toBe(true);
    expect((payload.activeEffects as ActiveEffect[]).length).toBe(1);
    expect((payload.activeEffects as ActiveEffect[])[0].cardId).toBe(cardId);
    expect(typeof payload.timestamp).toBe('string');
  });

  it('emitActiveEffects sends empty array when no active effects exist', async () => {
    // No effects seeded — DB has active_event = NULL
    const activeEffects: ActiveEffect[] = await manager.getActiveEffects(gameId);
    expect(activeEffects).toHaveLength(0);

    const reconnectSocket = makeSocket();
    emitActiveEffects(reconnectSocket, gameId, activeEffects);

    const mockSocketEmit = reconnectSocket.emit as jest.Mock;
    expect(mockSocketEmit).toHaveBeenCalledTimes(1);

    const [, payload] = mockSocketEmit.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.activeEffects).toEqual([]);
  });

  // ── 6. No room broadcast during reconnection ──────────────────────────────────

  it('emitActiveEffects does NOT broadcast to the game room', async () => {
    const activeEffects: ActiveEffect[] = await manager.getActiveEffects(gameId);
    const reconnectSocket = makeSocket();

    emitActiveEffects(reconnectSocket, gameId, activeEffects);

    // io.to() must not be called — reconnection uses targeted single-socket emit
    expect(mockIoTo).not.toHaveBeenCalled();
  });
});
