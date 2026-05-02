/**
 * Unit tests for ActiveEffectManager.
 *
 * Mocks the DB pool and PoolClient to control JSONB content.
 * Tests all methods and edge cases as specified in the testing strategy.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mock DB ──────────────────────────────────────────────────────────────────
jest.mock('../db/index', () => ({
  db: {
    query: jest.fn<() => Promise<any>>(),
  },
}));

import { ActiveEffectManager } from '../services/ActiveEffectManager';
import { db } from '../db/index';
import {
  ActiveEffectDescriptor,
  ActiveEffectRecord,
  EventCardType,
  PerPlayerEffect,
} from '../../shared/types/EventCard';
import { PoolClient } from 'pg';

const mockDb = db as unknown as { query: jest.Mock<() => Promise<any>> };

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockClient(activeEventRows: any[] = []): jest.Mocked<PoolClient> {
  const client = {
    query: jest.fn<() => Promise<any>>().mockResolvedValue({ rows: activeEventRows }),
  } as unknown as jest.Mocked<PoolClient>;
  return client;
}

function makeDescriptor(overrides: Partial<ActiveEffectDescriptor> = {}): ActiveEffectDescriptor {
  return {
    cardId: 121,
    drawingPlayerId: 'player-1',
    drawingPlayerIndex: 0,
    expiresAfterTurnNumber: 2,
    affectedZone: ['mp-1-1', 'mp-1-2'],
    ...overrides,
  };
}

function makeActiveEffectRecord(overrides: Partial<ActiveEffectRecord> = {}): ActiveEffectRecord {
  return {
    cardId: 121,
    cardType: 'Strike',
    drawingPlayerId: 'player-1',
    drawingPlayerIndex: 0,
    drawingPlayerTurnNumber: 1,
    expiresAfterTurnNumber: 2,
    affectedZone: ['mp-1-1', 'mp-1-2'],
    restrictions: {
      movement: [],
      build: [],
      pickupDelivery: [{ type: 'no_pickup_delivery_in_zone', zone: ['mp-1-1', 'mp-1-2'] }],
    },
    pendingLostTurns: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const GAME_ID = 'game-uuid-1';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ActiveEffectManager', () => {
  let manager: ActiveEffectManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ActiveEffectManager();
  });

  // ── getActiveEffects ──────────────────────────────────────────────────────

  describe('getActiveEffects', () => {
    it('should return empty array when active_event is null', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ active_event: null }] });

      const effects = await manager.getActiveEffects(GAME_ID);
      expect(effects).toEqual([]);
    });

    it('should return empty array when active_event is empty array', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ active_event: [] }] });

      const effects = await manager.getActiveEffects(GAME_ID);
      expect(effects).toEqual([]);
    });

    it('should return empty array when game row not found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const effects = await manager.getActiveEffects(GAME_ID);
      expect(effects).toEqual([]);
    });

    it('should deserialize JSONB and rehydrate affectedZone as Set<string>', async () => {
      const record = makeActiveEffectRecord();
      mockDb.query.mockResolvedValueOnce({ rows: [{ active_event: [record] }] });

      const effects = await manager.getActiveEffects(GAME_ID);

      expect(effects).toHaveLength(1);
      expect(effects[0].affectedZone).toBeInstanceOf(Set);
      expect(effects[0].affectedZone).toEqual(new Set(['mp-1-1', 'mp-1-2']));
      expect(effects[0].cardId).toBe(121);
      expect(effects[0].cardType).toBe(EventCardType.Strike);
    });

    it('should return multiple effects when array has multiple entries', async () => {
      const record1 = makeActiveEffectRecord({ cardId: 121 });
      const record2 = makeActiveEffectRecord({ cardId: 130, cardType: 'Snow' });
      mockDb.query.mockResolvedValueOnce({ rows: [{ active_event: [record1, record2] }] });

      const effects = await manager.getActiveEffects(GAME_ID);
      expect(effects).toHaveLength(2);
      expect(effects[0].cardId).toBe(121);
      expect(effects[1].cardId).toBe(130);
    });

    it('should preserve floodedRiver field when present', async () => {
      const record = makeActiveEffectRecord({ cardType: 'Flood', floodedRiver: 'Rhine' });
      mockDb.query.mockResolvedValueOnce({ rows: [{ active_event: [record] }] });

      const effects = await manager.getActiveEffects(GAME_ID);
      expect(effects[0].floodedRiver).toBe('Rhine');
    });
  });

  // ── addActiveEffect ───────────────────────────────────────────────────────

  describe('addActiveEffect', () => {
    it('should persist a Strike coastal effect with correct restrictions', async () => {
      const client = makeMockClient([{ active_event: null }]);
      const descriptor = makeDescriptor({ cardId: 121, affectedZone: ['mp-coast-1', 'mp-coast-2'] });

      await manager.addActiveEffect(GAME_ID, descriptor, EventCardType.Strike, [], client);

      const updateCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('UPDATE games'),
      );
      expect(updateCall).toBeDefined();

      const jsonArg = JSON.parse((updateCall as any[])[1][0]);
      expect(jsonArg).toHaveLength(1);
      expect(jsonArg[0].cardId).toBe(121);
      expect(jsonArg[0].cardType).toBe(EventCardType.Strike);
      expect(jsonArg[0].restrictions.pickupDelivery).toHaveLength(1);
      expect(jsonArg[0].restrictions.pickupDelivery[0].type).toBe('no_pickup_delivery_in_zone');
      expect(jsonArg[0].restrictions.movement).toHaveLength(0);
      expect(jsonArg[0].restrictions.build).toHaveLength(0);
    });

    it('should persist a Strike rail effect with movement and build restrictions', async () => {
      const client = makeMockClient([{ active_event: null }]);
      // Rail strike has empty affectedZone
      const descriptor = makeDescriptor({ cardId: 123, affectedZone: [] });

      await manager.addActiveEffect(GAME_ID, descriptor, EventCardType.Strike, [], client);

      const updateCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('UPDATE games'),
      );
      const jsonArg = JSON.parse((updateCall as any[])[1][0]);
      expect(jsonArg[0].restrictions.movement).toHaveLength(1);
      expect(jsonArg[0].restrictions.movement[0].type).toBe('no_movement_on_player_rail');
      expect(jsonArg[0].restrictions.movement[0].targetPlayerId).toBe('player-1');
      expect(jsonArg[0].restrictions.build).toHaveLength(1);
      expect(jsonArg[0].restrictions.build[0].type).toBe('no_build_for_player');
      expect(jsonArg[0].restrictions.build[0].targetPlayerId).toBe('player-1');
      expect(jsonArg[0].restrictions.pickupDelivery).toHaveLength(0);
    });

    it('should persist a Snow Alpine effect with half_rate and blocked_terrain', async () => {
      const client = makeMockClient([{ active_event: null }]);
      const descriptor = makeDescriptor({ cardId: 130, affectedZone: ['mp-alpine-1'] });

      await manager.addActiveEffect(GAME_ID, descriptor, EventCardType.Snow, [], client);

      const updateCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('UPDATE games'),
      );
      const jsonArg = JSON.parse((updateCall as any[])[1][0]);
      expect(jsonArg[0].cardType).toBe(EventCardType.Snow);
      const movRestrictions = jsonArg[0].restrictions.movement;
      expect(movRestrictions.some((r: any) => r.type === 'half_rate')).toBe(true);
      expect(movRestrictions.some((r: any) => r.type === 'blocked_terrain')).toBe(true);
      const buildRestrictions = jsonArg[0].restrictions.build;
      expect(buildRestrictions.some((r: any) => r.type === 'blocked_terrain')).toBe(true);
    });

    it('should persist a Derailment effect with pendingLostTurns', async () => {
      const client = makeMockClient([{ active_event: null }]);
      const descriptor = makeDescriptor({ cardId: 125, affectedZone: ['mp-d-1'] });
      const perPlayerEffects: PerPlayerEffect[] = [
        { playerId: 'player-2', effectType: 'turn_lost', details: 'Derailment' },
        { playerId: 'player-2', effectType: 'load_lost', details: 'Derailment', amount: 1 },
        { playerId: 'player-3', effectType: 'turn_lost', details: 'Derailment' },
      ];

      await manager.addActiveEffect(
        GAME_ID, descriptor, EventCardType.Derailment, perPlayerEffects, client,
      );

      const updateCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('UPDATE games'),
      );
      const jsonArg = JSON.parse((updateCall as any[])[1][0]);
      expect(jsonArg[0].pendingLostTurns).toHaveLength(2);
      expect(jsonArg[0].pendingLostTurns[0].playerId).toBe('player-2');
      expect(jsonArg[0].pendingLostTurns[1].playerId).toBe('player-3');
    });

    it('should deduplicate pendingLostTurns (player in zone by multiple Derailments)', async () => {
      const client = makeMockClient([{ active_event: null }]);
      const descriptor = makeDescriptor({ cardId: 125, affectedZone: [] });
      // Player 2 appears twice with turn_lost (should appear once)
      const perPlayerEffects: PerPlayerEffect[] = [
        { playerId: 'player-2', effectType: 'turn_lost', details: 'Derailment' },
        { playerId: 'player-2', effectType: 'turn_lost', details: 'Derailment' },
      ];

      await manager.addActiveEffect(
        GAME_ID, descriptor, EventCardType.Derailment, perPlayerEffects, client,
      );

      const updateCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('UPDATE games'),
      );
      const jsonArg = JSON.parse((updateCall as any[])[1][0]);
      expect(jsonArg[0].pendingLostTurns).toHaveLength(1);
    });

    it('should append to existing effects array (multi-effect)', async () => {
      const existing = makeActiveEffectRecord({ cardId: 121 });
      const client = makeMockClient([{ active_event: [existing] }]);
      const descriptor = makeDescriptor({ cardId: 130 });

      await manager.addActiveEffect(GAME_ID, descriptor, EventCardType.Snow, [], client);

      const updateCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('UPDATE games'),
      );
      const jsonArg = JSON.parse((updateCall as any[])[1][0]);
      expect(jsonArg).toHaveLength(2);
      expect(jsonArg[0].cardId).toBe(121);
      expect(jsonArg[1].cardId).toBe(130);
    });

    it('should create array from null active_event', async () => {
      const client = makeMockClient([{ active_event: null }]);
      const descriptor = makeDescriptor();

      await manager.addActiveEffect(GAME_ID, descriptor, EventCardType.Strike, [], client);

      const updateCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('UPDATE games'),
      );
      const jsonArg = JSON.parse((updateCall as any[])[1][0]);
      expect(jsonArg).toHaveLength(1);
    });

    it('should store floodedRiver for Flood events', async () => {
      const client = makeMockClient([{ active_event: null }]);
      const descriptor = makeDescriptor({ cardId: 135, affectedZone: [] });

      await manager.addActiveEffect(
        GAME_ID, descriptor, EventCardType.Flood, [], client, 'Rhine',
      );

      const updateCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('UPDATE games'),
      );
      const jsonArg = JSON.parse((updateCall as any[])[1][0]);
      expect(jsonArg[0].floodedRiver).toBe('Rhine');
    });

    it('should not set floodedRiver when riverName is not provided', async () => {
      const client = makeMockClient([{ active_event: null }]);
      const descriptor = makeDescriptor();

      await manager.addActiveEffect(GAME_ID, descriptor, EventCardType.Strike, [], client);

      const updateCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('UPDATE games'),
      );
      const jsonArg = JSON.parse((updateCall as any[])[1][0]);
      expect(jsonArg[0].floodedRiver).toBeUndefined();
    });

    it('should use SELECT FOR UPDATE to lock game row', async () => {
      const client = makeMockClient([{ active_event: null }]);
      const descriptor = makeDescriptor();

      await manager.addActiveEffect(GAME_ID, descriptor, EventCardType.Strike, [], client);

      const lockCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('FOR UPDATE'),
      );
      expect(lockCall).toBeDefined();
    });

    it('should set drawingPlayerTurnNumber to expiresAfterTurnNumber - 1', async () => {
      const client = makeMockClient([{ active_event: null }]);
      const descriptor = makeDescriptor({ expiresAfterTurnNumber: 5 });

      await manager.addActiveEffect(GAME_ID, descriptor, EventCardType.Strike, [], client);

      const updateCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('UPDATE games'),
      );
      const jsonArg = JSON.parse((updateCall as any[])[1][0]);
      expect(jsonArg[0].drawingPlayerTurnNumber).toBe(4);
    });
  });

  // ── cleanupExpiredEffects ─────────────────────────────────────────────────

  describe('cleanupExpiredEffects', () => {
    it('should return empty when no effects active', async () => {
      const client = makeMockClient([{ active_event: null }]);

      const result = await manager.cleanupExpiredEffects(GAME_ID, 0, 2, client);
      expect(result.expiredCardIds).toEqual([]);
    });

    it('should return empty when active_event is empty array', async () => {
      const client = makeMockClient([{ active_event: [] }]);

      const result = await manager.cleanupExpiredEffects(GAME_ID, 0, 2, client);
      expect(result.expiredCardIds).toEqual([]);
    });

    it('should remove expired effect at correct turn boundary', async () => {
      const record = makeActiveEffectRecord({
        cardId: 121,
        drawingPlayerIndex: 0,
        expiresAfterTurnNumber: 2,
      });
      const client = makeMockClient([{ active_event: [record] }]);

      const result = await manager.cleanupExpiredEffects(GAME_ID, 0, 2, client);

      expect(result.expiredCardIds).toEqual([121]);
      // Should write null or empty array
      const updateCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('UPDATE games'),
      );
      expect(updateCall).toBeDefined();
    });

    it('should keep non-expired effects', async () => {
      const expired = makeActiveEffectRecord({
        cardId: 121,
        drawingPlayerIndex: 0,
        expiresAfterTurnNumber: 2,
      });
      const notExpired = makeActiveEffectRecord({
        cardId: 130,
        drawingPlayerIndex: 1,
        expiresAfterTurnNumber: 3,
      });
      const client = makeMockClient([{ active_event: [expired, notExpired] }]);

      const result = await manager.cleanupExpiredEffects(GAME_ID, 0, 2, client);

      expect(result.expiredCardIds).toEqual([121]);
      const updateCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('UPDATE games'),
      );
      const jsonArg = JSON.parse((updateCall as any[])[1][0]);
      expect(jsonArg).toHaveLength(1);
      expect(jsonArg[0].cardId).toBe(130);
    });

    it('should handle multiple effects with different expiry times', async () => {
      const records = [
        makeActiveEffectRecord({ cardId: 121, drawingPlayerIndex: 0, expiresAfterTurnNumber: 2 }),
        makeActiveEffectRecord({ cardId: 122, drawingPlayerIndex: 0, expiresAfterTurnNumber: 3 }),
        makeActiveEffectRecord({ cardId: 130, drawingPlayerIndex: 1, expiresAfterTurnNumber: 2 }),
      ];
      const client = makeMockClient([{ active_event: records }]);

      // Player 0 completes turn 2
      const result = await manager.cleanupExpiredEffects(GAME_ID, 0, 2, client);

      // Only card 121 expires: playerIndex=0, expiresAfterTurn=2
      expect(result.expiredCardIds).toEqual([121]);
    });

    it('should not expire effects for a different player completing their turn', async () => {
      const record = makeActiveEffectRecord({
        cardId: 121,
        drawingPlayerIndex: 0,
        expiresAfterTurnNumber: 2,
      });
      const client = makeMockClient([{ active_event: [record] }]);

      // Player 1 completes turn 2, not player 0
      const result = await manager.cleanupExpiredEffects(GAME_ID, 1, 2, client);

      expect(result.expiredCardIds).toEqual([]);
    });

    it('should use SELECT FOR UPDATE to lock game row', async () => {
      const client = makeMockClient([{ active_event: [] }]);

      await manager.cleanupExpiredEffects(GAME_ID, 0, 2, client);

      const lockCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('FOR UPDATE'),
      );
      expect(lockCall).toBeDefined();
    });
  });

  // ── getMovementRestrictions ───────────────────────────────────────────────

  describe('getMovementRestrictions', () => {
    it('should return empty array when no active effects', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ active_event: null }] });

      const restrictions = await manager.getMovementRestrictions(GAME_ID);
      expect(restrictions).toEqual([]);
    });

    it('should aggregate movement restrictions across multiple active effects', async () => {
      const record1 = makeActiveEffectRecord({
        cardId: 130,
        cardType: 'Snow',
        restrictions: {
          movement: [{ type: 'half_rate', zone: ['mp-1'] }],
          build: [],
          pickupDelivery: [],
        },
      });
      const record2 = makeActiveEffectRecord({
        cardId: 131,
        cardType: 'Snow',
        restrictions: {
          movement: [{ type: 'blocked_terrain', zone: ['mp-2'] }],
          build: [],
          pickupDelivery: [],
        },
      });
      mockDb.query.mockResolvedValueOnce({ rows: [{ active_event: [record1, record2] }] });

      const restrictions = await manager.getMovementRestrictions(GAME_ID);
      expect(restrictions).toHaveLength(2);
      expect(restrictions[0].type).toBe('half_rate');
      expect(restrictions[1].type).toBe('blocked_terrain');
    });
  });

  // ── getBuildRestrictions ──────────────────────────────────────────────────

  describe('getBuildRestrictions', () => {
    it('should return empty array when no active effects', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ active_event: null }] });

      const restrictions = await manager.getBuildRestrictions(GAME_ID);
      expect(restrictions).toEqual([]);
    });

    it('should aggregate build restrictions across multiple active effects', async () => {
      const record1 = makeActiveEffectRecord({
        cardId: 123,
        cardType: 'Strike',
        restrictions: {
          movement: [],
          build: [{ type: 'no_build_for_player', targetPlayerId: 'player-1' }],
          pickupDelivery: [],
        },
      });
      const record2 = makeActiveEffectRecord({
        cardId: 130,
        cardType: 'Snow',
        restrictions: {
          movement: [],
          build: [{ type: 'blocked_terrain', zone: ['mp-alpine-1'] }],
          pickupDelivery: [],
        },
      });
      mockDb.query.mockResolvedValueOnce({ rows: [{ active_event: [record1, record2] }] });

      const restrictions = await manager.getBuildRestrictions(GAME_ID);
      expect(restrictions).toHaveLength(2);
    });
  });

  // ── getPickupDeliveryRestrictions ─────────────────────────────────────────

  describe('getPickupDeliveryRestrictions', () => {
    it('should return empty array when no active effects', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ active_event: null }] });

      const restrictions = await manager.getPickupDeliveryRestrictions(GAME_ID);
      expect(restrictions).toEqual([]);
    });

    it('should aggregate pickup/delivery restrictions across multiple active effects', async () => {
      const record1 = makeActiveEffectRecord({
        cardId: 121,
        restrictions: {
          movement: [],
          build: [],
          pickupDelivery: [{ type: 'no_pickup_delivery_in_zone', zone: ['mp-coast-1'] }],
        },
      });
      const record2 = makeActiveEffectRecord({
        cardId: 122,
        restrictions: {
          movement: [],
          build: [],
          pickupDelivery: [{ type: 'no_pickup_delivery_in_zone', zone: ['mp-coast-2'] }],
        },
      });
      mockDb.query.mockResolvedValueOnce({ rows: [{ active_event: [record1, record2] }] });

      const restrictions = await manager.getPickupDeliveryRestrictions(GAME_ID);
      expect(restrictions).toHaveLength(2);
      expect(restrictions[0].zone).toEqual(['mp-coast-1']);
      expect(restrictions[1].zone).toEqual(['mp-coast-2']);
    });
  });

  // ── consumeLostTurn ───────────────────────────────────────────────────────

  describe('consumeLostTurn', () => {
    it('should return false when no active effects', async () => {
      const client = makeMockClient([{ active_event: null }]);

      const result = await manager.consumeLostTurn(GAME_ID, 'player-2', client);
      expect(result).toBe(false);
    });

    it('should return false when player has no pending lost turn', async () => {
      const record = makeActiveEffectRecord({
        pendingLostTurns: [{ playerId: 'player-3' }],
      });
      const client = makeMockClient([{ active_event: [record] }]);

      const result = await manager.consumeLostTurn(GAME_ID, 'player-2', client);
      expect(result).toBe(false);
    });

    it('should remove player from pendingLostTurns and return true', async () => {
      const record = makeActiveEffectRecord({
        cardId: 125,
        pendingLostTurns: [{ playerId: 'player-2' }, { playerId: 'player-3' }],
      });
      const client = makeMockClient([{ active_event: [record] }]);

      const result = await manager.consumeLostTurn(GAME_ID, 'player-2', client);

      expect(result).toBe(true);
      const updateCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('UPDATE games'),
      );
      const jsonArg = JSON.parse((updateCall as any[])[1][0]);
      expect(jsonArg[0].pendingLostTurns).toHaveLength(1);
      expect(jsonArg[0].pendingLostTurns[0].playerId).toBe('player-3');
    });

    it('should only remove from first matching effect (one turn max)', async () => {
      const record1 = makeActiveEffectRecord({
        cardId: 125,
        pendingLostTurns: [{ playerId: 'player-2' }],
      });
      const record2 = makeActiveEffectRecord({
        cardId: 126,
        pendingLostTurns: [{ playerId: 'player-2' }],
      });
      const client = makeMockClient([{ active_event: [record1, record2] }]);

      const result = await manager.consumeLostTurn(GAME_ID, 'player-2', client);

      expect(result).toBe(true);
      const updateCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('UPDATE games'),
      );
      const jsonArg = JSON.parse((updateCall as any[])[1][0]);
      // First effect should have player-2 removed
      expect(jsonArg[0].pendingLostTurns).toHaveLength(0);
      // Second effect should still have player-2 (not double-consumed)
      expect(jsonArg[1].pendingLostTurns).toHaveLength(1);
      expect(jsonArg[1].pendingLostTurns[0].playerId).toBe('player-2');
    });

    it('should use SELECT FOR UPDATE to lock game row', async () => {
      const client = makeMockClient([{ active_event: null }]);

      await manager.consumeLostTurn(GAME_ID, 'player-2', client);

      const lockCall = (client.query as jest.Mock).mock.calls.find(
        (c: any[]) => (c[0] as string).includes('FOR UPDATE'),
      );
      expect(lockCall).toBeDefined();
    });
  });

  // ── Restart hydration (stateless design) ─────────────────────────────────

  describe('Restart hydration (stateless design)', () => {
    it('should correctly read back written ActiveEffectRecord from DB', async () => {
      // Simulate: write an ActiveEffectRecord, then read back via getActiveEffects
      const record: ActiveEffectRecord = {
        cardId: 130,
        cardType: 'Snow',
        drawingPlayerId: 'player-1',
        drawingPlayerIndex: 0,
        drawingPlayerTurnNumber: 3,
        expiresAfterTurnNumber: 4,
        affectedZone: ['mp-alpine-1', 'mp-alpine-2'],
        restrictions: {
          movement: [{ type: 'half_rate', zone: ['mp-alpine-1', 'mp-alpine-2'] }],
          build: [{ type: 'blocked_terrain', zone: ['mp-alpine-1', 'mp-alpine-2'] }],
          pickupDelivery: [],
        },
        pendingLostTurns: [],
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      // Simulate a fresh manager reading from DB (stateless)
      mockDb.query.mockResolvedValueOnce({ rows: [{ active_event: [record] }] });

      const freshManager = new ActiveEffectManager();
      const effects = await freshManager.getActiveEffects(GAME_ID);

      expect(effects).toHaveLength(1);
      expect(effects[0].cardId).toBe(130);
      expect(effects[0].cardType).toBe(EventCardType.Snow);
      expect(effects[0].affectedZone).toBeInstanceOf(Set);
      expect(effects[0].affectedZone.has('mp-alpine-1')).toBe(true);
      expect(effects[0].affectedZone.has('mp-alpine-2')).toBe(true);
      expect(effects[0].restrictions.movement[0].type).toBe('half_rate');
      expect(effects[0].restrictions.build[0].type).toBe('blocked_terrain');
      expect(effects[0].pendingLostTurns).toEqual([]);
    });
  });
});
