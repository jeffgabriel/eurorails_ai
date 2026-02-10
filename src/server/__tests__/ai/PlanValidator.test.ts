/**
 * Unit tests for PlanValidator.
 * Tests plan validation against WorldSnapshot including funds, capacity,
 * reachability, build budget, and cumulative state progression.
 */

import { makeSnapshot, makeSegment, makeDemandCard, makeGridPoint } from './helpers/testFixtures';
import { PlanValidator } from '../../ai/PlanValidator';
import {
  TurnPlan,
  FeasibleOption,
  AIActionType,
  DeliverLoadParams,
  PickupAndDeliverParams,
  BuildTrackParams,
  UpgradeTrainParams,
  BuildTowardMajorCityParams,
  PassTurnParams,
} from '../../ai/types';
import { TrainType, TerrainType, TRAIN_PROPERTIES } from '../../../shared/types/GameTypes';
import { LoadType } from '../../../shared/types/LoadTypes';

// Mock majorCityGroups (needed by computeReachableCities)
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: () => [
    {
      cityName: 'Berlin',
      center: { row: 1, col: 2 },
      outposts: [{ row: 1, col: 1 }, { row: 1, col: 3 }],
    },
    {
      cityName: 'Paris',
      center: { row: 3, col: 2 },
      outposts: [{ row: 3, col: 1 }, { row: 3, col: 3 }],
    },
  ],
  getFerryEdges: () => [],
}));

// --- Helpers to build FeasibleOption wrappers ---

function makeDeliverOption(params: Omit<DeliverLoadParams, 'type'>): FeasibleOption {
  return {
    type: AIActionType.DeliverLoad,
    description: `Deliver ${params.loadType} to ${params.city}`,
    feasible: true,
    params: { type: AIActionType.DeliverLoad, ...params },
  };
}

function makePickupAndDeliverOption(params: Omit<PickupAndDeliverParams, 'type'>): FeasibleOption {
  return {
    type: AIActionType.PickupAndDeliver,
    description: `Pickup ${params.pickupLoadType} and deliver to ${params.deliverCity}`,
    feasible: true,
    params: { type: AIActionType.PickupAndDeliver, ...params },
  };
}

function makeBuildOption(params: Omit<BuildTrackParams, 'type'>): FeasibleOption {
  return {
    type: AIActionType.BuildTrack,
    description: `Build ${params.segments.length} segments for ${params.totalCost}M`,
    feasible: true,
    params: { type: AIActionType.BuildTrack, ...params },
  };
}

function makeBuildTowardOption(params: Omit<BuildTowardMajorCityParams, 'type'>): FeasibleOption {
  return {
    type: AIActionType.BuildTowardMajorCity,
    description: `Build toward ${params.targetCity}`,
    feasible: true,
    params: { type: AIActionType.BuildTowardMajorCity, ...params },
  };
}

function makeUpgradeOption(params: Omit<UpgradeTrainParams, 'type'>): FeasibleOption {
  return {
    type: AIActionType.UpgradeTrain,
    description: `Upgrade to ${params.targetTrainType}`,
    feasible: true,
    params: { type: AIActionType.UpgradeTrain, ...params },
  };
}

function makePassOption(): FeasibleOption {
  return {
    type: AIActionType.PassTurn,
    description: 'Pass turn',
    feasible: true,
    params: { type: AIActionType.PassTurn } as PassTurnParams,
  };
}

describe('PlanValidator', () => {
  describe('empty plan', () => {
    it('should accept an empty plan', () => {
      const snapshot = makeSnapshot();
      const plan: TurnPlan = { actions: [] };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('PassTurn', () => {
    it('should accept a PassTurn plan', () => {
      const snapshot = makeSnapshot();
      const plan: TurnPlan = { actions: [makePassOption()] };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(true);
    });
  });

  describe('fund validation', () => {
    it('should reject build plans exceeding 20M turn budget', () => {
      const snapshot = makeSnapshot({ money: 50 });
      const segments = [
        makeSegment(0, 0, TerrainType.Clear, 0, 1, TerrainType.Alpine, 5),
        makeSegment(0, 1, TerrainType.Alpine, 0, 2, TerrainType.Alpine, 5),
        makeSegment(0, 2, TerrainType.Alpine, 0, 3, TerrainType.Alpine, 5),
        makeSegment(0, 3, TerrainType.Alpine, 0, 4, TerrainType.Alpine, 5),
        makeSegment(0, 4, TerrainType.Alpine, 0, 5, TerrainType.Alpine, 5),
      ];
      const plan: TurnPlan = {
        actions: [makeBuildOption({ segments, totalCost: 25 })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('exceeds remaining turn budget')]),
      );
    });

    it('should accept build plans within budget', () => {
      const snapshot = makeSnapshot({ money: 50 });
      const segments = [
        makeSegment(0, 0, TerrainType.Clear, 0, 1, TerrainType.Clear, 1),
        makeSegment(0, 1, TerrainType.Clear, 0, 2, TerrainType.Clear, 1),
      ];
      const plan: TurnPlan = {
        actions: [makeBuildOption({ segments, totalCost: 2 })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(true);
    });

    it('should reject build when insufficient funds', () => {
      const snapshot = makeSnapshot({ money: 5 });
      const segments = [
        makeSegment(0, 0, TerrainType.Clear, 0, 1, TerrainType.Clear, 1),
      ];
      const plan: TurnPlan = {
        actions: [makeBuildOption({ segments, totalCost: 10 })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('insufficient funds')]),
      );
    });

    it('should reject upgrade when insufficient funds', () => {
      const snapshot = makeSnapshot({ money: 10, trainType: TrainType.Freight });
      const plan: TurnPlan = {
        actions: [makeUpgradeOption({
          targetTrainType: TrainType.FastFreight,
          kind: 'upgrade',
          cost: 20,
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('insufficient funds')]),
      );
    });

    it('should accept upgrade when sufficient funds', () => {
      const snapshot = makeSnapshot({ money: 25, trainType: TrainType.Freight });
      const plan: TurnPlan = {
        actions: [makeUpgradeOption({
          targetTrainType: TrainType.FastFreight,
          kind: 'upgrade',
          cost: 20,
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(true);
    });
  });

  describe('cumulative fund tracking', () => {
    it('should track funds across multiple build actions', () => {
      const snapshot = makeSnapshot({ money: 15 });
      const seg1 = [makeSegment(0, 0, TerrainType.Clear, 0, 1, TerrainType.Clear, 1)];
      const seg2 = [makeSegment(0, 1, TerrainType.Clear, 0, 2, TerrainType.Clear, 1)];
      const plan: TurnPlan = {
        actions: [
          makeBuildOption({ segments: seg1, totalCost: 10 }),
          makeBuildOption({ segments: seg2, totalCost: 10 }),
        ],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      // Second build should fail: 15 - 10 = 5 remaining, but needs 10
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('insufficient funds')]),
      );
    });

    it('should track build budget across multiple build actions', () => {
      const snapshot = makeSnapshot({ money: 50 });
      const seg1 = [
        makeSegment(0, 0, TerrainType.Clear, 0, 1, TerrainType.Alpine, 5),
        makeSegment(0, 1, TerrainType.Alpine, 0, 2, TerrainType.Alpine, 5),
      ];
      const seg2 = [
        makeSegment(0, 2, TerrainType.Alpine, 0, 3, TerrainType.Alpine, 5),
        makeSegment(0, 3, TerrainType.Alpine, 0, 4, TerrainType.Alpine, 5),
        makeSegment(0, 4, TerrainType.Alpine, 0, 5, TerrainType.Alpine, 5),
      ];
      const plan: TurnPlan = {
        actions: [
          makeBuildOption({ segments: seg1, totalCost: 10 }),
          makeBuildOption({ segments: seg2, totalCost: 15 }),
        ],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      // 10 + 15 = 25 > 20 budget
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('exceeds remaining turn budget')]),
      );
    });

    it('should track build budget with upgrade + build', () => {
      const snapshot = makeSnapshot({ money: 50, trainType: TrainType.Freight });
      const segs = [
        makeSegment(0, 0, TerrainType.Clear, 0, 1, TerrainType.Clear, 1),
        makeSegment(0, 1, TerrainType.Clear, 0, 2, TerrainType.Clear, 1),
      ];
      const plan: TurnPlan = {
        actions: [
          makeUpgradeOption({ targetTrainType: TrainType.FastFreight, kind: 'upgrade', cost: 20 }),
          makeBuildOption({ segments: segs, totalCost: 2 }),
        ],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      // Upgrade uses full 20M budget, no room for build
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('exceeds remaining turn budget')]),
      );
    });

    it('should allow crossgrade + build within budget', () => {
      const snapshot = makeSnapshot({ money: 50, trainType: TrainType.FastFreight });
      const segs = [
        makeSegment(0, 0, TerrainType.Clear, 0, 1, TerrainType.Clear, 1),
      ];
      const plan: TurnPlan = {
        actions: [
          makeUpgradeOption({ targetTrainType: TrainType.HeavyFreight, kind: 'crossgrade', cost: 5 }),
          makeBuildOption({ segments: segs, totalCost: 1 }),
        ],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(true);
      // Crossgrade 5 + build 1 = 6 <= 20 budget
    });
  });

  describe('train capacity validation', () => {
    it('should reject pickup when Freight train at 2-load capacity', () => {
      const demandCard = makeDemandCard(1, [
        { city: 'Berlin', resource: LoadType.Coal, payment: 15 },
      ]);
      const snapshot = makeSnapshot({
        trainType: TrainType.Freight,
        carriedLoads: [LoadType.Wine, LoadType.Oil],
        demandCards: [demandCard],
        loadAvailability: new Map([['TestCity', [LoadType.Coal]]]),
      });
      const plan: TurnPlan = {
        actions: [makePickupAndDeliverOption({
          pickupPath: [],
          pickupCity: 'TestCity',
          pickupLoadType: LoadType.Coal,
          deliverPath: [],
          deliverCity: 'Berlin',
          demandCardId: 1,
          demandIndex: 0,
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('at capacity')]),
      );
    });

    it('should allow pickup when Heavy Freight has room for 3rd load', () => {
      const demandCard = makeDemandCard(1, [
        { city: 'Berlin', resource: LoadType.Coal, payment: 15 },
      ]);
      // Build connected track so BFS can find the city
      const seg = makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.MajorCity, 5);
      const snapshot = makeSnapshot({
        trainType: TrainType.HeavyFreight,
        carriedLoads: [LoadType.Wine, LoadType.Oil],
        demandCards: [demandCard],
        loadAvailability: new Map([['Berlin', [LoadType.Coal]]]),
        position: { x: 50, y: 50, row: 1, col: 1 },
        allPlayerTracks: [{
          playerId: 'bot-1',
          gameId: 'test-game',
          segments: [seg],
          totalCost: 0,
          turnBuildCost: 0,
          lastBuildTimestamp: new Date(),
        }],
        mapPoints: [
          makeGridPoint(1, 1, TerrainType.Clear),
          makeGridPoint(1, 2, TerrainType.MajorCity, 'Berlin'),
        ],
      });
      const plan: TurnPlan = {
        actions: [makePickupAndDeliverOption({
          pickupPath: [],
          pickupCity: 'Berlin',
          pickupLoadType: LoadType.Coal,
          deliverPath: [],
          deliverCity: 'Berlin',
          demandCardId: 1,
          demandIndex: 0,
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(true);
    });
  });

  describe('delivery validation', () => {
    it('should reject delivery when load not carried', () => {
      const demandCard = makeDemandCard(1, [
        { city: 'Berlin', resource: LoadType.Coal, payment: 15 },
      ]);
      const snapshot = makeSnapshot({
        carriedLoads: [],
        demandCards: [demandCard],
      });
      const plan: TurnPlan = {
        actions: [makeDeliverOption({
          movePath: [],
          demandCardId: 1,
          demandIndex: 0,
          loadType: LoadType.Coal,
          city: 'Berlin',
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('not carrying')]),
      );
    });

    it('should reject delivery when demand card not in hand', () => {
      const snapshot = makeSnapshot({
        carriedLoads: [LoadType.Coal],
        demandCards: [],
      });
      const plan: TurnPlan = {
        actions: [makeDeliverOption({
          movePath: [],
          demandCardId: 999,
          demandIndex: 0,
          loadType: LoadType.Coal,
          city: 'Berlin',
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('demand card 999 not in hand')]),
      );
    });

    it('should reject delivery when bot has no position', () => {
      const demandCard = makeDemandCard(1, [
        { city: 'Berlin', resource: LoadType.Coal, payment: 15 },
      ]);
      const snapshot = makeSnapshot({
        position: null,
        carriedLoads: [LoadType.Coal],
        demandCards: [demandCard],
      });
      const plan: TurnPlan = {
        actions: [makeDeliverOption({
          movePath: [],
          demandCardId: 1,
          demandIndex: 0,
          loadType: LoadType.Coal,
          city: 'Berlin',
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('no position')]),
      );
    });

    it('should accept valid delivery with reachable city', () => {
      const demandCard = makeDemandCard(1, [
        { city: 'Berlin', resource: LoadType.Coal, payment: 15 },
      ]);
      const seg = makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.MajorCity, 5);
      const snapshot = makeSnapshot({
        carriedLoads: [LoadType.Coal],
        demandCards: [demandCard],
        position: { x: 50, y: 50, row: 1, col: 1 },
        allPlayerTracks: [{
          playerId: 'bot-1',
          gameId: 'test-game',
          segments: [seg],
          totalCost: 0,
          turnBuildCost: 0,
          lastBuildTimestamp: new Date(),
        }],
        mapPoints: [
          makeGridPoint(1, 1, TerrainType.Clear),
          makeGridPoint(1, 2, TerrainType.MajorCity, 'Berlin'),
        ],
      });
      const plan: TurnPlan = {
        actions: [makeDeliverOption({
          movePath: [{ x: 50, y: 50, row: 1, col: 1 }, { x: 100, y: 50, row: 1, col: 2 }],
          demandCardId: 1,
          demandIndex: 0,
          loadType: LoadType.Coal,
          city: 'Berlin',
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(true);
    });
  });

  describe('upgrade path validation', () => {
    it('should reject invalid upgrade path (Freight -> Superfreight directly)', () => {
      const snapshot = makeSnapshot({ money: 50, trainType: TrainType.Freight });
      const plan: TurnPlan = {
        actions: [makeUpgradeOption({
          targetTrainType: TrainType.Superfreight,
          kind: 'upgrade',
          cost: 20,
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('no valid path')]),
      );
    });

    it('should reject upgrade when already at target type', () => {
      const snapshot = makeSnapshot({ money: 50, trainType: TrainType.FastFreight });
      const plan: TurnPlan = {
        actions: [makeUpgradeOption({
          targetTrainType: TrainType.FastFreight,
          kind: 'upgrade',
          cost: 20,
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('already have this train type')]),
      );
    });

    it('should accept valid Freight -> FastFreight upgrade', () => {
      const snapshot = makeSnapshot({ money: 50, trainType: TrainType.Freight });
      const plan: TurnPlan = {
        actions: [makeUpgradeOption({
          targetTrainType: TrainType.FastFreight,
          kind: 'upgrade',
          cost: 20,
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(true);
    });

    it('should accept FastFreight -> HeavyFreight crossgrade', () => {
      const snapshot = makeSnapshot({ money: 50, trainType: TrainType.FastFreight });
      const plan: TurnPlan = {
        actions: [makeUpgradeOption({
          targetTrainType: TrainType.HeavyFreight,
          kind: 'crossgrade',
          cost: 5,
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(true);
    });
  });

  describe('BuildTowardMajorCity validation', () => {
    it('should reject when no segments provided', () => {
      const snapshot = makeSnapshot({ money: 50 });
      const plan: TurnPlan = {
        actions: [makeBuildTowardOption({
          targetCity: 'Berlin',
          segments: [],
          totalCost: 0,
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('no segments')]),
      );
    });

    it('should reject when cost exceeds budget', () => {
      const snapshot = makeSnapshot({ money: 50 });
      const segments = [
        makeSegment(0, 0, TerrainType.Clear, 0, 1, TerrainType.Alpine, 5),
        makeSegment(0, 1, TerrainType.Alpine, 0, 2, TerrainType.Alpine, 5),
        makeSegment(0, 2, TerrainType.Alpine, 0, 3, TerrainType.Alpine, 5),
        makeSegment(0, 3, TerrainType.Alpine, 0, 4, TerrainType.Alpine, 5),
        makeSegment(0, 4, TerrainType.Alpine, 0, 5, TerrainType.Alpine, 5),
      ];
      const plan: TurnPlan = {
        actions: [makeBuildTowardOption({
          targetCity: 'Berlin',
          segments,
          totalCost: 25,
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('exceeds remaining turn budget')]),
      );
    });

    it('should accept valid build toward major city', () => {
      const snapshot = makeSnapshot({ money: 50 });
      const segments = [
        makeSegment(0, 0, TerrainType.Clear, 0, 1, TerrainType.Clear, 1),
      ];
      const plan: TurnPlan = {
        actions: [makeBuildTowardOption({
          targetCity: 'Berlin',
          segments,
          totalCost: 1,
        })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(true);
    });
  });

  describe('BuildTrack validation', () => {
    it('should reject when no segments to build', () => {
      const snapshot = makeSnapshot({ money: 50 });
      const plan: TurnPlan = {
        actions: [makeBuildOption({ segments: [], totalCost: 0 })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('no segments')]),
      );
    });

    it('should account for existing turnBuildCostSoFar', () => {
      const snapshot = makeSnapshot({ money: 50, turnBuildCostSoFar: 15 });
      const segments = [
        makeSegment(0, 0, TerrainType.Clear, 0, 1, TerrainType.Alpine, 5),
        makeSegment(0, 1, TerrainType.Alpine, 0, 2, TerrainType.Clear, 1),
      ];
      const plan: TurnPlan = {
        actions: [makeBuildOption({ segments, totalCost: 6 })],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      // 15 already spent + 6 new = 21 > 20
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('exceeds remaining turn budget')]),
      );
    });
  });

  describe('multi-action plans', () => {
    it('should validate a deliver + build plan successfully', () => {
      const demandCard = makeDemandCard(1, [
        { city: 'Berlin', resource: LoadType.Coal, payment: 15 },
      ]);
      const seg = makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.MajorCity, 5);
      const snapshot = makeSnapshot({
        money: 50,
        carriedLoads: [LoadType.Coal],
        demandCards: [demandCard],
        position: { x: 50, y: 50, row: 1, col: 1 },
        allPlayerTracks: [{
          playerId: 'bot-1',
          gameId: 'test-game',
          segments: [seg],
          totalCost: 0,
          turnBuildCost: 0,
          lastBuildTimestamp: new Date(),
        }],
        mapPoints: [
          makeGridPoint(1, 1, TerrainType.Clear),
          makeGridPoint(1, 2, TerrainType.MajorCity, 'Berlin'),
        ],
      });
      const buildSegs = [
        makeSegment(1, 2, TerrainType.MajorCity, 1, 3, TerrainType.Clear, 1),
      ];
      const plan: TurnPlan = {
        actions: [
          makeDeliverOption({
            movePath: [{ x: 50, y: 50, row: 1, col: 1 }, { x: 100, y: 50, row: 1, col: 2 }],
            demandCardId: 1,
            demandIndex: 0,
            loadType: LoadType.Coal,
            city: 'Berlin',
          }),
          makeBuildOption({ segments: buildSegs, totalCost: 1 }),
        ],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(true);
    });

    it('should collect all errors from multiple invalid actions', () => {
      const snapshot = makeSnapshot({
        money: 5,
        carriedLoads: [],
        demandCards: [],
        trainType: TrainType.Freight,
      });
      const plan: TurnPlan = {
        actions: [
          makeDeliverOption({
            movePath: [],
            demandCardId: 999,
            demandIndex: 0,
            loadType: LoadType.Coal,
            city: 'Berlin',
          }),
          makeUpgradeOption({
            targetTrainType: TrainType.Superfreight,
            kind: 'upgrade',
            cost: 20,
          }),
        ],
      };
      const result = PlanValidator.validate(plan, snapshot);
      expect(result.valid).toBe(false);
      // Should have errors from both actions
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });
  });
});
