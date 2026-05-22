/**
 * GuardrailEnforcer event-card restriction gates (JIRA-256 Phase 4).
 *
 * Tests the backstop validation layer: construct a TurnPlan that violates
 * each restriction type and assert checkPlan returns the correct typed result.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { WorldSnapshot, TurnPlan } from '../../../shared/types/GameTypes';
import { AIActionType, TrainType, TerrainType } from '../../../shared/types/GameTypes';
import type { ActiveEffect } from '../../../shared/types/EventCard';
import { EventCardType } from '../../../shared/types/EventCard';
import type { TrackSegment } from '../../../shared/types/TrackTypes';

// ── Mock MapTopology ─────────────────────────────────────────────────────────
jest.mock('../../services/MapTopology', () => ({
  loadGridPoints: jest.fn(() => {
    const m = new Map<string, any>();
    m.set('10,5', { row: 10, col: 5, terrain: TerrainType.MajorCity, name: 'Hamburg' });
    m.set('5,5', { row: 5, col: 5, terrain: TerrainType.Clear });
    return m;
  }),
}));

// ── Mock trackService ────────────────────────────────────────────────────────
jest.mock('../../services/trackService', () => ({
  getRiverEdgeKeys: jest.fn((riverName: string) => {
    if (riverName === 'Rhine') return new Set(['5,5|5,6']);
    return null;
  }),
  segmentCrossesRiver: jest.fn(
    (segment: any, edgeKeys: Set<string>) => {
      const key = `${Math.min(segment.from.row, segment.to.row)},${Math.min(segment.from.col, segment.to.col)}|${Math.max(segment.from.row, segment.to.row)},${Math.max(segment.from.col, segment.to.col)}`;
      return edgeKeys.has(key);
    },
  ),
}));

// ── Mock other imports ───────────────────────────────────────────────────────
jest.mock('../../services/ai/routeHelpers', () => ({
  hasCarriedDeliverableOnNetwork: jest.fn(() => false),
}));
jest.mock('../../../shared/services/majorCityGroups', () => ({
  computeEffectivePathLength: jest.fn(() => 3),
  isIntraCityEdge: jest.fn(() => false),
  getMajorCityLookup: jest.fn(() => new Map()),
}));

import { GuardrailEnforcer } from '../../services/ai/GuardrailEnforcer';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeActiveEffect(overrides: Partial<ActiveEffect> = {}): ActiveEffect {
  return {
    cardId: 121,
    cardType: EventCardType.Strike,
    drawingPlayerId: 'player-human',
    drawingPlayerIndex: 0,
    expiresAfterTurnNumber: 5,
    affectedZone: new Set<string>(),
    restrictions: { movement: [], build: [], pickupDelivery: [] },
    pendingLostTurns: [],
    ...overrides,
  };
}

function makeSegment(from: { row: number; col: number }, to: { row: number; col: number }): TrackSegment {
  return {
    from: { x: 0, y: 0, row: from.row, col: from.col, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: to.row, col: to.col, terrain: TerrainType.Clear },
    cost: 1,
  };
}

function makeSnapshot(activeEffects: ActiveEffect[]): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: 5, col: 5 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: { skillLevel: 'medium' as any },
      connectedMajorCityCount: 0,
      pendingFloodRebuilds: [],
    },
    allPlayerTracks: [],
    loadAvailability: {},
    activeEffects,
  };
}

const baseContext: any = {
  position: { city: 'TestCity', row: 5, col: 5 },
  speed: 9,
  demands: [],
  canDeliver: [],
  isInitialBuild: false,
  money: 50,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GuardrailEnforcer — event-card restriction gates (JIRA-256)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('LOST_TURN_PENDING (Derailment)', () => {
    it('forces PassTurn when bot has a pending lost turn and plan is not PassTurn', async () => {
      const derailmentEffect = makeActiveEffect({
        cardType: EventCardType.Derailment,
        pendingLostTurns: [{ playerId: 'bot-1' }],
      });

      const plan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 5, col: 5 }, { row: 5, col: 6 }],
        fees: new Set(),
        totalFee: 0,
      };

      const result = await GuardrailEnforcer.checkPlan(
        plan, baseContext, makeSnapshot([derailmentEffect]),
      );

      expect(result.overridden).toBe(true);
      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.reason).toContain('LOST_TURN_PENDING');
    });

    it('does NOT override PassTurn when bot has a pending lost turn', async () => {
      const derailmentEffect = makeActiveEffect({
        cardType: EventCardType.Derailment,
        pendingLostTurns: [{ playerId: 'bot-1' }],
      });

      const plan: TurnPlan = { type: AIActionType.PassTurn };

      // hasActiveRoute=true to prevent stuck guardrail from firing
      const result = await GuardrailEnforcer.checkPlan(
        plan, baseContext, makeSnapshot([derailmentEffect]), true,
      );

      // PassTurn is legal under lost-turn — the event-card gate must NOT fire for PassTurn
      // (other guardrails may still override, but reason must not be LOST_TURN_PENDING)
      expect(result.reason ?? '').not.toContain('LOST_TURN_PENDING');
    });

    it('does NOT fire when pending lost turn is for a different player', async () => {
      const derailmentEffect = makeActiveEffect({
        cardType: EventCardType.Derailment,
        pendingLostTurns: [{ playerId: 'player-human' }],
      });

      const plan: TurnPlan = { type: AIActionType.PassTurn };
      // hasActiveRoute=true prevents the stuck guardrail from firing
      const result = await GuardrailEnforcer.checkPlan(
        plan, baseContext, makeSnapshot([derailmentEffect]), true,
      );

      expect(result.overridden).toBe(false);
    });
  });

  describe('MOVEMENT_RESTRICTION_VIOLATION (Snow blocked_terrain)', () => {
    it('forces PassTurn when MoveTrain path passes through a blocked terrain zone', async () => {
      const snowEffect = makeActiveEffect({
        cardType: EventCardType.Snow,
        restrictions: {
          movement: [{ type: 'blocked_terrain', zone: ['5,6', '5,7'] }],
          build: [],
          pickupDelivery: [],
        },
      });

      const plan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 5, col: 5 }, { row: 5, col: 6 }], // 5,6 is in blocked zone
        fees: new Set(),
        totalFee: 0,
      };

      const result = await GuardrailEnforcer.checkPlan(
        plan, baseContext, makeSnapshot([snowEffect]),
      );

      expect(result.overridden).toBe(true);
      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.reason).toContain('MOVEMENT_RESTRICTION_VIOLATION');
    });

    it('does NOT fire when MoveTrain path is outside the blocked zone', async () => {
      const snowEffect = makeActiveEffect({
        cardType: EventCardType.Snow,
        restrictions: {
          movement: [{ type: 'blocked_terrain', zone: ['99,99'] }],
          build: [],
          pickupDelivery: [],
        },
      });

      const plan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 5, col: 5 }, { row: 5, col: 6 }],
        fees: new Set(),
        totalFee: 0,
      };

      // Pass hasActiveRoute=true so stuck guardrail doesn't fire
      const result = await GuardrailEnforcer.checkPlan(
        plan, baseContext, makeSnapshot([snowEffect]), true,
      );

      expect(result.overridden).toBe(false);
    });
  });

  describe('BUILD_RESTRICTION_VIOLATION (Snow blocked_terrain)', () => {
    it('forces PassTurn when BuildTrack segment destination is in blocked zone', async () => {
      const snowEffect = makeActiveEffect({
        cardType: EventCardType.Snow,
        restrictions: {
          movement: [],
          build: [{ type: 'blocked_terrain', zone: ['8,4'] }],
          pickupDelivery: [],
        },
      });

      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment({ row: 8, col: 3 }, { row: 8, col: 4 })],
      };

      const result = await GuardrailEnforcer.checkPlan(
        plan, baseContext, makeSnapshot([snowEffect]),
      );

      expect(result.overridden).toBe(true);
      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.reason).toContain('BUILD_RESTRICTION_VIOLATION');
    });

    it('forces PassTurn when BuildTrack is blocked by Rail Strike (no_build_for_player)', async () => {
      const railStrikeEffect = makeActiveEffect({
        cardType: EventCardType.Strike,
        restrictions: {
          movement: [],
          build: [{ type: 'no_build_for_player', targetPlayerId: 'bot-1' }],
          pickupDelivery: [],
        },
      });

      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment({ row: 1, col: 1 }, { row: 1, col: 2 })],
      };

      const result = await GuardrailEnforcer.checkPlan(
        plan, baseContext, makeSnapshot([railStrikeEffect]),
      );

      expect(result.overridden).toBe(true);
      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.reason).toContain('BUILD_RESTRICTION_VIOLATION');
    });

    it('forces PassTurn when BuildTrack tries to rebuild a Flood-blocked river', async () => {
      const floodEffect = makeActiveEffect({
        cardType: EventCardType.Flood,
        floodedRiver: 'Rhine',
        restrictions: { movement: [], build: [], pickupDelivery: [] },
      });

      // Segment that crosses Rhine (from (5,5) to (5,6) in our mock)
      const rhineSeg = makeSegment({ row: 5, col: 5 }, { row: 5, col: 6 });

      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [rhineSeg],
      };

      const result = await GuardrailEnforcer.checkPlan(
        plan, baseContext, makeSnapshot([floodEffect]),
      );

      expect(result.overridden).toBe(true);
      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.reason).toContain('BUILD_RESTRICTION_VIOLATION');
      expect(result.reason).toContain('Rhine');
    });
  });

  describe('PICKUP_DELIVERY_RESTRICTION_VIOLATION (Coastal Strike)', () => {
    it('forces PassTurn when DeliverLoad city is in coastal zone', async () => {
      // Hamburg is at '10,5' per our mock
      const coastalStrikeEffect = makeActiveEffect({
        cardType: EventCardType.Strike,
        restrictions: {
          movement: [],
          build: [],
          pickupDelivery: [{ type: 'no_pickup_delivery_in_zone', zone: ['10,5'] }],
        },
      });

      const plan: TurnPlan = {
        type: AIActionType.DeliverLoad,
        load: 'Steel',
        city: 'Hamburg',
        cardId: 42,
        payout: 12,
      };

      const result = await GuardrailEnforcer.checkPlan(
        plan, baseContext, makeSnapshot([coastalStrikeEffect]),
      );

      expect(result.overridden).toBe(true);
      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.reason).toContain('PICKUP_DELIVERY_RESTRICTION_VIOLATION');
    });

    it('forces PassTurn when PickupLoad city is in coastal zone', async () => {
      const coastalStrikeEffect = makeActiveEffect({
        cardType: EventCardType.Strike,
        restrictions: {
          movement: [],
          build: [],
          pickupDelivery: [{ type: 'no_pickup_delivery_in_zone', zone: ['10,5'] }],
        },
      });

      const plan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Coal',
        city: 'Hamburg',
      };

      const result = await GuardrailEnforcer.checkPlan(
        plan, baseContext, makeSnapshot([coastalStrikeEffect]),
      );

      expect(result.overridden).toBe(true);
      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.reason).toContain('PICKUP_DELIVERY_RESTRICTION_VIOLATION');
    });

    it('does NOT fire when city is not in the coastal zone', async () => {
      const coastalStrikeEffect = makeActiveEffect({
        cardType: EventCardType.Strike,
        restrictions: {
          movement: [],
          build: [],
          pickupDelivery: [{ type: 'no_pickup_delivery_in_zone', zone: ['99,99'] }],
        },
      });

      const plan: TurnPlan = {
        type: AIActionType.DeliverLoad,
        load: 'Steel',
        city: 'Hamburg',
        cardId: 42,
        payout: 12,
      };

      // Pass hasActiveRoute=true so stuck guardrail doesn't fire before us
      const result = await GuardrailEnforcer.checkPlan(
        plan, baseContext, makeSnapshot([coastalStrikeEffect]), true,
      );

      expect(result.overridden).toBe(false);
    });
  });

  describe('MultiAction plan restriction checks', () => {
    it('fires on restricted step inside a MultiAction plan', async () => {
      const snowEffect = makeActiveEffect({
        cardType: EventCardType.Snow,
        restrictions: {
          movement: [{ type: 'blocked_terrain', zone: ['6,6'] }],
          build: [],
          pickupDelivery: [],
        },
      });

      const plan: TurnPlan = {
        type: 'MultiAction',
        steps: [
          {
            type: AIActionType.MoveTrain,
            path: [{ row: 5, col: 5 }, { row: 5, col: 6 }], // safe
            fees: new Set(),
            totalFee: 0,
          },
          {
            type: AIActionType.MoveTrain,
            path: [{ row: 5, col: 6 }, { row: 6, col: 6 }], // blocked
            fees: new Set(),
            totalFee: 0,
          },
        ],
      };

      const result = await GuardrailEnforcer.checkPlan(
        plan, baseContext, makeSnapshot([snowEffect]),
      );

      expect(result.overridden).toBe(true);
      expect(result.plan.type).toBe(AIActionType.PassTurn);
    });
  });

  describe('No active effects — gates do not fire', () => {
    it('does not override a valid MoveTrain when no effects are active', async () => {
      const plan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 5, col: 5 }, { row: 5, col: 6 }],
        fees: new Set(),
        totalFee: 0,
      };

      // Pass hasActiveRoute=true so stuck guardrail doesn't fire
      const result = await GuardrailEnforcer.checkPlan(
        plan, baseContext, makeSnapshot([]), true,
      );

      expect(result.overridden).toBe(false);
    });
  });
});
