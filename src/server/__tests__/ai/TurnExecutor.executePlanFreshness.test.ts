/**
 * Unit tests for TurnExecutor.executePlan freshness gate (TEST-001 / BE-002).
 *
 * These tests form the canonical test suite for the SNAPSHOT_MISMATCH gate and
 * complement the broader TurnExecutor.freshnessGate.test.ts suite. Coverage includes:
 *
 *   - Stale derivedFromIdentity → SNAPSHOT_MISMATCH rejection (no state mutation)
 *   - Matching identities → gate passes, execution proceeds normally
 *   - Legacy paths → no derivedFromIdentity or no snapshot.identity bypasses gate
 *   - MultiAction plans → stale rejected at entry; fresh proceeds
 *   - rejectedAction derivation for single-action and MultiAction plans
 *   - console.warn logging on mismatch with correct identity details
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../db/index', () => ({
  db: {
    query: jest.fn<() => Promise<any>>().mockResolvedValue({ rows: [] }),
    connect: jest.fn(),
  },
}));

jest.mock('../../services/socketService', () => ({
  emitToGame: jest.fn(),
  emitStatePatch: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

jest.mock('../../services/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
}));

jest.mock('../../../shared/services/cityPositionResolver', () => ({
  getCityNameAtPosition: jest.fn(() => 'Hamburg'),
}));

jest.mock('../../../shared/services/trainProperties', () => ({
  getTrainCapacity: jest.fn(() => 2),
  getTrainSpeed: jest.fn(() => 9),
}));

jest.mock('../../services/demandDeckService', () => ({
  DemandDeckService: {
    getInstance: jest.fn(() => ({
      getCard: jest.fn(() => undefined),
    })),
  },
}));

jest.mock('../../services/loadService', () => ({
  LoadService: {
    getInstance: jest.fn(() => ({
      getAvailableLoadsForCity: jest.fn(() => []),
    })),
  },
}));

// PlayerService — track invocations to verify no mutation on rejection
const mockDeliverLoadForUser = jest.fn<() => Promise<any>>();
const mockMoveTrainForUser = jest.fn<() => Promise<any>>();
const mockBuildTrackForPlayer = jest.fn<() => Promise<any>>();

jest.mock('../../services/playerService', () => {
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
      buildTrackForPlayer: jest.fn().mockImplementation((...args: unknown[]) => mockBuildTrackForPlayer(...args as [])),
    },
  };
});

// WorldSnapshotService — expose real assertFresh/SnapshotMismatch
jest.mock('../../services/ai/WorldSnapshotService', () => {
  const actual = jest.requireActual<typeof import('../../services/ai/WorldSnapshotService')>('../../services/ai/WorldSnapshotService');
  return {
    capture: jest.fn<() => Promise<any>>().mockResolvedValue({}),
    computeIdentity: jest.fn(() => ({ turnNumber: 1, factsHash: 'stub' })),
    assertFresh: actual.assertFresh,
    SnapshotMismatch: actual.SnapshotMismatch,
  };
});

import { TurnExecutor } from '../../services/ai/TurnExecutor';
import { AIActionType, TrainType } from '../../../shared/types/GameTypes';
import { GuardrailEnforcer } from '../../services/ai/GuardrailEnforcer';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIdentity(overrides: { turnNumber?: number; factsHash?: string } = {}) {
  return { turnNumber: 5, factsHash: 'hash-abc', ...overrides };
}

function makeSnapshot(
  identity: { turnNumber: number; factsHash: string } | null | undefined = { turnNumber: 5, factsHash: 'hash-abc' },
) {
  return {
    gameId: 'game-fresh',
    gameStatus: 'active',
    turnNumber: 5,
    activeEffects: [],
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 80,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [1],
      resolvedDemands: [{ cardId: 1, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 25 }] }],
      trainType: TrainType.Freight,
      loads: ['Coal'],
      botConfig: null,
      connectedMajorCityCount: 3,
      pendingFloodRebuilds: [],
    },
    allPlayerTracks: [],
    loadAvailability: {},
    hexGrid: [],
    identity: identity ?? undefined,
  } as any;
}

const passTurnPlan = { type: AIActionType.PassTurn } as any;
const deliverPlan = { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Berlin', cardId: 1, payout: 25 } as any;
const movePlan = { type: AIActionType.MoveTrain, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }] } as any;

function makeMultiPlan(firstStepType: AIActionType = AIActionType.DeliverLoad) {
  return {
    type: 'MultiAction',
    steps: [
      { type: firstStepType, load: 'Coal', city: 'Berlin', cardId: 1, payout: 25 },
    ],
  } as any;
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('TurnExecutor.executePlan — freshness gate (TEST-001)', () => {
  let warnSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // ── 1. Stale identity rejection ───────────────────────────────────────────

  describe('stale derivedFromIdentity — SNAPSHOT_MISMATCH rejection', () => {
    it('returns success:false when factsHash differs', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live-hash' });
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale-hash' });

      const result = await TurnExecutor.executePlan(deliverPlan, snapshot, derived);

      expect(result.success).toBe(false);
      expect(result.rejectionReason?.code).toBe('SNAPSHOT_MISMATCH');
    });

    it('returns success:false when turnNumber differs', async () => {
      const snapshot = makeSnapshot({ turnNumber: 6, factsHash: 'same-hash' });
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'same-hash' });

      const result = await TurnExecutor.executePlan(deliverPlan, snapshot, derived);

      expect(result.success).toBe(false);
      expect(result.rejectionReason?.code).toBe('SNAPSHOT_MISMATCH');
    });

    it('rejection message matches GuardrailEnforcer.SNAPSHOT_MISMATCH constant', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live' });
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale' });

      const result = await TurnExecutor.executePlan(deliverPlan, snapshot, derived);

      expect(result.rejectionReason?.message).toBe(GuardrailEnforcer.SNAPSHOT_MISMATCH);
    });

    it('returns error field set to mismatch reason', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live' });
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale' });

      const result = await TurnExecutor.executePlan(deliverPlan, snapshot, derived);

      expect(result.error).toBe(GuardrailEnforcer.SNAPSHOT_MISMATCH);
    });

    it('returns zero cost, segmentsBuilt, durationMs on rejection', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live' });
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale' });

      const result = await TurnExecutor.executePlan(deliverPlan, snapshot, derived);

      expect(result.cost).toBe(0);
      expect(result.segmentsBuilt).toBe(0);
      expect(result.durationMs).toBe(0);
    });

    it('returns remainingMoney = snapshot.bot.money on rejection', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live' });
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale' });

      const result = await TurnExecutor.executePlan(deliverPlan, snapshot, derived);

      expect(result.remainingMoney).toBe(snapshot.bot.money);
    });

    it('does NOT call PlayerService methods on rejection (no state mutation)', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live' });
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale' });

      await TurnExecutor.executePlan(deliverPlan, snapshot, derived);

      expect(mockDeliverLoadForUser).not.toHaveBeenCalled();
      expect(mockMoveTrainForUser).not.toHaveBeenCalled();
      expect(mockBuildTrackForPlayer).not.toHaveBeenCalled();
    });
  });

  // ── 2. Logging on mismatch ────────────────────────────────────────────────

  describe('console.warn logging on SNAPSHOT_MISMATCH', () => {
    it('calls console.warn on mismatch', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live-hash' });
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale-hash' });

      await TurnExecutor.executePlan(deliverPlan, snapshot, derived);

      expect(warnSpy).toHaveBeenCalled();
    });

    it('log message includes [TurnExecutor] prefix', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live' });
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale' });

      await TurnExecutor.executePlan(deliverPlan, snapshot, derived);

      const logCall = warnSpy.mock.calls[0]?.[0] as string;
      expect(logCall).toContain('[TurnExecutor]');
    });

    it('log message includes derived identity details', async () => {
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale-hash-abc' });
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live-hash-xyz' });

      await TurnExecutor.executePlan(deliverPlan, snapshot, derived);

      const logCall = warnSpy.mock.calls[0]?.[0] as string;
      expect(logCall).toContain('5');           // turnNumber
      expect(logCall).toContain('stale-hash-abc');  // derived factsHash
    });

    it('log message includes live identity details', async () => {
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale-xyz' });
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live-abc-456' });

      await TurnExecutor.executePlan(deliverPlan, snapshot, derived);

      const logCall = warnSpy.mock.calls[0]?.[0] as string;
      expect(logCall).toContain('live-abc-456');
    });

    it('does NOT call console.warn when identities match', async () => {
      const identity = makeIdentity();
      const snapshot = makeSnapshot(identity);

      await TurnExecutor.executePlan(passTurnPlan, snapshot, identity);

      // Gate passed — no warning logged
      const mismatchWarn = warnSpy.mock.calls.find(
        (c) => (c[0] as string)?.includes?.('SNAPSHOT_MISMATCH') || (c[0] as string)?.includes?.('[TurnExecutor]'),
      );
      expect(mismatchWarn).toBeUndefined();
    });
  });

  // ── 3. rejectedAction derivation ─────────────────────────────────────────

  describe('rejectedAction field derivation', () => {
    it('single DeliverLoad plan → action = DeliverLoad', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live' });
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale' });

      const result = await TurnExecutor.executePlan(deliverPlan, snapshot, derived);

      expect(result.action).toBe(AIActionType.DeliverLoad);
    });

    it('single MoveTrain plan → action = MoveTrain', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live' });
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale' });

      const result = await TurnExecutor.executePlan(movePlan, snapshot, derived);

      expect(result.action).toBe(AIActionType.MoveTrain);
    });

    it('MultiAction plan → action = first step type', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live' });
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale' });

      const result = await TurnExecutor.executePlan(makeMultiPlan(AIActionType.DeliverLoad), snapshot, derived);

      expect(result.action).toBe(AIActionType.DeliverLoad);
    });

    it('empty MultiAction plan → action = PassTurn (fallback)', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live' });
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale' });

      const emptyMulti = { type: 'MultiAction', steps: [] } as any;
      const result = await TurnExecutor.executePlan(emptyMulti, snapshot, derived);

      expect(result.action).toBe(AIActionType.PassTurn);
    });
  });

  // ── 4. MultiAction plans ─────────────────────────────────────────────────

  describe('MultiAction plans', () => {
    it('stale MultiAction plan is rejected at entry before any step executes', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'live' });
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'stale' });

      await TurnExecutor.executePlan(makeMultiPlan(), snapshot, derived);

      expect(mockDeliverLoadForUser).not.toHaveBeenCalled();
    });

    it('fresh MultiAction plan is NOT rejected by the gate', async () => {
      const identity = makeIdentity();
      const snapshot = makeSnapshot(identity);

      // Fresh plan — gate should pass (execution will proceed, may fail for other
      // reasons, but rejectionReason must not be SNAPSHOT_MISMATCH)
      const result = await TurnExecutor.executePlan(makeMultiPlan(), snapshot, identity);

      expect(result.rejectionReason?.code).not.toBe('SNAPSHOT_MISMATCH');
    });
  });

  // ── 5. Matching identity — gate passes ───────────────────────────────────

  describe('matching identities — gate passes', () => {
    it('proceeds normally when derivedFromIdentity equals snapshot.identity', async () => {
      const identity = makeIdentity({ turnNumber: 5, factsHash: 'same-hash' });
      const snapshot = makeSnapshot(identity);

      const result = await TurnExecutor.executePlan(passTurnPlan, snapshot, identity);

      expect(result.rejectionReason?.code).not.toBe('SNAPSHOT_MISMATCH');
      expect(result.success).toBe(true);
    });
  });

  // ── 6. Legacy paths — gate bypassed ──────────────────────────────────────

  describe('legacy paths — gate bypassed', () => {
    it('no derivedFromIdentity → gate is bypassed (undefined = legacy call)', async () => {
      const snapshot = makeSnapshot({ turnNumber: 5, factsHash: 'any' });

      const result = await TurnExecutor.executePlan(passTurnPlan, snapshot);

      expect(result.rejectionReason?.code).not.toBe('SNAPSHOT_MISMATCH');
      expect(result.success).toBe(true);
    });

    it('snapshot.identity undefined → gate is bypassed (legacy snapshot)', async () => {
      const snapshot = makeSnapshot(null);           // no identity
      const derived = makeIdentity();

      const result = await TurnExecutor.executePlan(passTurnPlan, snapshot, derived);

      expect(result.rejectionReason?.code).not.toBe('SNAPSHOT_MISMATCH');
      expect(result.success).toBe(true);
    });

    it('both undefined → gate is bypassed entirely', async () => {
      const snapshot = makeSnapshot(null);

      const result = await TurnExecutor.executePlan(passTurnPlan, snapshot);

      expect(result.rejectionReason?.code).not.toBe('SNAPSHOT_MISMATCH');
      expect(result.success).toBe(true);
    });
  });
});
