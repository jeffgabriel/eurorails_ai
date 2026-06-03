/**
 * Unit tests for TurnExecutor.executePlan freshness gate (BE-002).
 *
 * The gate is the FIRST statement in executePlan. When derivedFromIdentity
 * does not match snapshot.identity, the executor must:
 *   - Return success:false with rejectionReason.code === 'SNAPSHOT_MISMATCH'
 *   - NOT mutate any game state (no PlayerService calls)
 *
 * Legacy paths (no derivedFromIdentity) must bypass the gate entirely.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../db/index', () => ({
  db: {
    query: jest.fn<() => Promise<any>>().mockResolvedValue({ rows: [] }),
    connect: jest.fn(),
  },
}));

jest.mock('../services/socketService', () => ({
  emitToGame: jest.fn(),
  emitStatePatch: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

jest.mock('../services/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
}));

jest.mock('../../shared/services/cityPositionResolver', () => ({
  getCityNameAtPosition: jest.fn(() => 'Hamburg'),
}));

jest.mock('../../shared/services/trainProperties', () => ({
  getTrainCapacity: jest.fn(() => 2),
  getTrainSpeed: jest.fn(() => 9),
}));

jest.mock('../services/demandDeckService', () => ({
  DemandDeckService: {
    getInstance: jest.fn(() => ({
      getCard: jest.fn(() => undefined),
    })),
  },
}));

jest.mock('../services/loadService', () => ({
  LoadService: {
    getInstance: jest.fn(() => ({
      getAvailableLoadsForCity: jest.fn(() => []),
    })),
  },
}));

// Track whether PlayerService methods are called (they must NOT be on rejection)
const mockDeliverLoadForUser = jest.fn<() => Promise<any>>();
const mockMoveTrainForUser = jest.fn<() => Promise<any>>();

jest.mock('../services/playerService', () => {
  class ActionRestrictionError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'ActionRestrictionError';
      this.code = code;
    }
  }
  return {
    ActionRestrictionError,
    PlayerService: {
      deliverLoadForUser: jest.fn().mockImplementation((...args: unknown[]) => mockDeliverLoadForUser(...args as [])),
      moveTrainForUser: jest.fn().mockImplementation((...args: unknown[]) => mockMoveTrainForUser(...args as [])),
    },
  };
});

jest.mock('../services/ai/WorldSnapshotService', () => {
  const actual = jest.requireActual<typeof import('../services/ai/WorldSnapshotService')>('../services/ai/WorldSnapshotService');
  return {
    capture: jest.fn<() => Promise<any>>().mockResolvedValue({}),
    computeIdentity: jest.fn(() => ({ turnNumber: 1, factsHash: 'stub' })),
    assertFresh: actual.assertFresh,       // real implementation
    SnapshotMismatch: actual.SnapshotMismatch,
  };
});

import { TurnExecutor } from '../services/ai/TurnExecutor';
import { AIActionType, TrainType } from '../../shared/types/GameTypes';
import { GuardrailEnforcer } from '../services/ai/GuardrailEnforcer';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIdentity(overrides: { turnNumber?: number; factsHash?: string } = {}) {
  return { turnNumber: 5, factsHash: 'hash-abc', ...overrides };
}

function makeSnapshot(identityOverride?: { turnNumber: number; factsHash: string } | null) {
  const snap = {
    gameId: 'game-fresh-test',
    gameStatus: 'active',
    turnNumber: 5,
    activeEffects: [],
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 50,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [1],
      resolvedDemands: [{ cardId: 1, demands: [{ city: 'Hamburg', loadType: 'Coal', payment: 20 }] }],
      trainType: TrainType.Freight,
      loads: ['Coal'],
      botConfig: null,
      connectedMajorCityCount: 0,
      pendingFloodRebuilds: [],
    },
    allPlayerTracks: [],
    loadAvailability: {},
    hexGrid: [],
  } as any;
  if (identityOverride !== undefined) {
    snap.identity = identityOverride ?? undefined;
  } else {
    snap.identity = { turnNumber: 5, factsHash: 'hash-abc' };
  }
  return snap;
}

function makeDeliverPlan() {
  return {
    type: AIActionType.DeliverLoad,
    load: 'Coal',
    city: 'Hamburg',
    cardId: 1,
    payout: 20,
  } as any;
}

function makeMovePlan() {
  return {
    type: AIActionType.MoveTrain,
    path: [{ row: 10, col: 10 }, { row: 10, col: 11 }],
  } as any;
}

function makeMultiActionPlan(firstStepType: AIActionType = AIActionType.DeliverLoad) {
  return {
    type: 'MultiAction',
    steps: [
      { type: firstStepType, load: 'Coal', city: 'Hamburg', cardId: 1, payout: 20 },
    ],
  } as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TurnExecutor.executePlan — freshness gate (BE-002)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('stale plan rejection', () => {
    it('returns success:false with SNAPSHOT_MISMATCH when factsHash changed', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'hash-live' });
      const derivedFromIdentity = makeIdentity({ turnNumber: 5, factsHash: 'hash-stale' });

      const result = await TurnExecutor.executePlan(makeDeliverPlan(), snapshot, derivedFromIdentity);

      expect(result.success).toBe(false);
      expect(result.rejectionReason?.code).toBe('SNAPSHOT_MISMATCH');
      expect(result.rejectionReason?.message).toBe(GuardrailEnforcer.SNAPSHOT_MISMATCH);
    });

    it('returns success:false with SNAPSHOT_MISMATCH when turnNumber changed', async () => {
      const snapshot = makeSnapshot({ turnNumber: 6, factsHash: 'hash-abc' });
      const derivedFromIdentity = makeIdentity({ turnNumber: 5, factsHash: 'hash-abc' });

      const result = await TurnExecutor.executePlan(makeDeliverPlan(), snapshot, derivedFromIdentity);

      expect(result.success).toBe(false);
      expect(result.rejectionReason?.code).toBe('SNAPSHOT_MISMATCH');
    });

    it('does NOT call PlayerService on stale plan (no state mutation)', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'hash-live' });
      const derivedFromIdentity = makeIdentity({ turnNumber: 5, factsHash: 'hash-stale' });

      await TurnExecutor.executePlan(makeDeliverPlan(), snapshot, derivedFromIdentity);

      expect(mockDeliverLoadForUser).not.toHaveBeenCalled();
    });

    it('returns cost:0, segmentsBuilt:0, durationMs:0 on rejection', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'hash-live' });
      const derivedFromIdentity = makeIdentity({ turnNumber: 5, factsHash: 'hash-stale' });

      const result = await TurnExecutor.executePlan(makeDeliverPlan(), snapshot, derivedFromIdentity);

      expect(result.cost).toBe(0);
      expect(result.segmentsBuilt).toBe(0);
      expect(result.durationMs).toBe(0);
      expect(result.remainingMoney).toBe(snapshot.bot.money);
    });

    it('correctly derives rejectedAction for single-action plan', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'stale' });
      const derivedFromIdentity = makeIdentity({ turnNumber: 5, factsHash: 'fresh' });

      const movePlan = makeMovePlan();
      const result = await TurnExecutor.executePlan(movePlan, snapshot, derivedFromIdentity);

      expect(result.action).toBe(AIActionType.MoveTrain);
    });

    it('correctly derives rejectedAction for MultiAction plan (first step type)', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'stale' });
      const derivedFromIdentity = makeIdentity({ turnNumber: 5, factsHash: 'fresh' });

      const multiPlan = makeMultiActionPlan(AIActionType.DeliverLoad);
      const result = await TurnExecutor.executePlan(multiPlan, snapshot, derivedFromIdentity);

      expect(result.action).toBe(AIActionType.DeliverLoad);
    });

    it('falls back to PassTurn for empty MultiAction steps on rejection', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'stale' });
      const derivedFromIdentity = makeIdentity({ turnNumber: 5, factsHash: 'fresh' });

      const emptyMultiPlan = { type: 'MultiAction', steps: [] } as any;
      const result = await TurnExecutor.executePlan(emptyMultiPlan, snapshot, derivedFromIdentity);

      expect(result.action).toBe(AIActionType.PassTurn);
    });

    it('rejects MultiAction plan before any step is processed', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'stale' });
      const derivedFromIdentity = makeIdentity({ turnNumber: 5, factsHash: 'fresh' });

      const multiPlan = makeMultiActionPlan(AIActionType.DeliverLoad);
      await TurnExecutor.executePlan(multiPlan, snapshot, derivedFromIdentity);

      // No delivery should have been attempted
      expect(mockDeliverLoadForUser).not.toHaveBeenCalled();
    });
  });

  describe('happy path — gate passes', () => {
    it('proceeds normally when derivedFromIdentity matches snapshot.identity', async () => {
      const identity = makeIdentity({ turnNumber: 5, factsHash: 'hash-abc' });
      const snapshot = makeSnapshot(identity);
      // Use a PassTurn plan to avoid complex handler mock setup — we only care the gate passes
      const passPlan = { type: AIActionType.PassTurn } as any;

      const result = await TurnExecutor.executePlan(passPlan, snapshot, identity);

      // Gate did not reject with SNAPSHOT_MISMATCH
      expect(result.rejectionReason?.code).not.toBe('SNAPSHOT_MISMATCH');
      // PassTurn always succeeds
      expect(result.success).toBe(true);
    });
  });

  describe('legacy path — no derivedFromIdentity', () => {
    it('bypasses freshness gate when derivedFromIdentity is undefined', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'hash-abc' });
      // Use PassTurn — no complex handler setup needed
      const passPlan = { type: AIActionType.PassTurn } as any;

      // No derivedFromIdentity — legacy path, gate must not fire
      const result = await TurnExecutor.executePlan(passPlan, snapshot);

      expect(result.rejectionReason?.code).not.toBe('SNAPSHOT_MISMATCH');
      expect(result.success).toBe(true);
    });

    it('bypasses freshness gate when snapshot.identity is undefined (legacy snapshot)', async () => {
      const snapshot = makeSnapshot(null); // no identity on snapshot
      const derivedFromIdentity = makeIdentity();
      const passPlan = { type: AIActionType.PassTurn } as any;

      const result = await TurnExecutor.executePlan(passPlan, snapshot, derivedFromIdentity);

      // derivedFromIdentity present but liveIdentity undefined → Ok (legacy path)
      expect(result.rejectionReason?.code).not.toBe('SNAPSHOT_MISMATCH');
      expect(result.success).toBe(true);
    });
  });
});
