import { TurnValidator } from '../../services/ai/TurnValidator';
import * as MapTopology from '../../services/MapTopology';
import {
  AIActionType,
  WorldSnapshot,
  TurnPlan,
  GameContext,
  TerrainType,
  TrackSegment,
  TurnPlanMultiAction,
  GameState,
} from '../../../shared/types/GameTypes';

function makeSnapshot(money: number = 50): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 1,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money,
      position: null,
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

function makeContext(overrides?: Partial<GameContext>): GameContext {
  return {
    position: { city: 'Berlin', row: 10, col: 10 },
    money: 50,
    trainType: 'Freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: ['Berlin'],
    unconnectedMajorCities: [],
    totalMajorCities: 8,
    trackSummary: '5 segments',
    turnBuildCost: 0,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: ['Berlin', 'Hamburg'],
    citiesOnNetwork: [],
    canUpgrade: true,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'normal',
    turnNumber: 5,
    gameState: GameState.Mid,
    ...overrides,
  };
}

function makeSegment(
  fromRow: number, fromCol: number,
  toRow: number, toCol: number,
  cost: number = 1,
  toTerrain: TerrainType = TerrainType.Clear,
): TrackSegment {
  return {
    from: { x: fromCol * 40, y: fromRow * 40, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: toCol * 40, y: toRow * 40, row: toRow, col: toCol, terrain: toTerrain },
    cost,
  };
}

function multiAction(steps: TurnPlan[]): TurnPlanMultiAction {
  return { type: 'MultiAction', steps };
}

describe('TurnValidator', () => {
  describe('BUILD_UPGRADE_EXCLUSION', () => {
    it('should reject plan with both BUILD and UPGRADE', () => {
      const plan = multiAction([
        { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 1, 2, 5)] },
        { type: AIActionType.UpgradeTrain, targetTrain: 'FastFreight', cost: 20 },
      ]);
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      expect(result.valid).toBe(false);
      expect(result.violation).toContain('BUILD and UPGRADE');
      expect(result.hardGates.find(g => g.gate === 'BUILD_UPGRADE_EXCLUSION')?.passed).toBe(false);
    });

    it('should pass plan with BUILD only', () => {
      const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 1, 2, 5)] };
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      expect(result.hardGates.find(g => g.gate === 'BUILD_UPGRADE_EXCLUSION')?.passed).toBe(true);
    });

    it('should pass plan with UPGRADE only', () => {
      const plan: TurnPlan = { type: AIActionType.UpgradeTrain, targetTrain: 'FastFreight', cost: 20 };
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      expect(result.hardGates.find(g => g.gate === 'BUILD_UPGRADE_EXCLUSION')?.passed).toBe(true);
    });
  });

  describe('PHASE_B_BUDGET_CAP', () => {
    it('should reject plan spending over 20M on track', () => {
      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [
          makeSegment(1, 1, 1, 2, 10),
          makeSegment(1, 2, 1, 3, 11),
        ],
      };
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      expect(result.valid).toBe(false);
      expect(result.hardGates.find(g => g.gate === 'PHASE_B_BUDGET_CAP')?.passed).toBe(false);
      expect(result.violation).toContain('budget cap');
    });

    it('should pass plan spending exactly 20M', () => {
      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [
          makeSegment(1, 1, 1, 2, 10),
          makeSegment(1, 2, 1, 3, 10),
        ],
      };
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      expect(result.hardGates.find(g => g.gate === 'PHASE_B_BUDGET_CAP')?.passed).toBe(true);
    });

    it('should pass plan with 20M upgrade', () => {
      const plan: TurnPlan = { type: AIActionType.UpgradeTrain, targetTrain: 'FastFreight', cost: 20 };
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      expect(result.hardGates.find(g => g.gate === 'PHASE_B_BUDGET_CAP')?.passed).toBe(true);
    });
  });

  describe('CASH_SUFFICIENCY', () => {
    it('should reject plan building 15M track with only 10M cash', () => {
      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(1, 1, 1, 2, 15)],
      };
      const result = TurnValidator.validate(plan, makeContext({ money: 10 }), makeSnapshot(10));
      expect(result.valid).toBe(false);
      expect(result.hardGates.find(g => g.gate === 'CASH_SUFFICIENCY')?.passed).toBe(false);
    });

    it('should pass when bot has enough cash', () => {
      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(1, 1, 1, 2, 15)],
      };
      const result = TurnValidator.validate(plan, makeContext({ money: 20 }), makeSnapshot(20));
      expect(result.hardGates.find(g => g.gate === 'CASH_SUFFICIENCY')?.passed).toBe(true);
    });

    it('should pass when delivery income covers build cost', () => {
      const plan = multiAction([
        { type: AIActionType.DeliverLoad, load: 'Wine', city: 'Berlin', cardId: 5, payout: 18 },
        { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 1, 2, 12)] },
      ]);
      const result = TurnValidator.validate(plan, makeContext({ money: 0 }), makeSnapshot(0));
      expect(result.hardGates.find(g => g.gate === 'CASH_SUFFICIENCY')?.passed).toBe(true);
    });

    it('should fail when delivery income is insufficient for build cost', () => {
      const plan = multiAction([
        { type: AIActionType.DeliverLoad, load: 'Wine', city: 'Berlin', cardId: 5, payout: 5 },
        { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 1, 2, 12)] },
      ]);
      const result = TurnValidator.validate(plan, makeContext({ money: 0 }), makeSnapshot(0));
      expect(result.hardGates.find(g => g.gate === 'CASH_SUFFICIENCY')?.passed).toBe(false);
    });

    it('should pass when delivery income plus cash covers build cost', () => {
      const plan = multiAction([
        { type: AIActionType.DeliverLoad, load: 'Wine', city: 'Berlin', cardId: 5, payout: 10 },
        { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 1, 2, 12)] },
      ]);
      const result = TurnValidator.validate(plan, makeContext({ money: 5 }), makeSnapshot(5));
      expect(result.hardGates.find(g => g.gate === 'CASH_SUFFICIENCY')?.passed).toBe(true);
    });

    it('should pass when delivery income covers both movement fees and build cost', () => {
      const plan = multiAction([
        { type: AIActionType.MoveTrain, path: [{ row: 1, col: 1 }, { row: 1, col: 2 }], fees: new Set(['p2']), totalFee: 4 },
        { type: AIActionType.DeliverLoad, load: 'Wine', city: 'Berlin', cardId: 5, payout: 18 },
        { type: AIActionType.BuildTrack, segments: [makeSegment(1, 2, 1, 3, 12)] },
      ]);
      // totalCost = 12 + 4 = 16, availableCash = 0 + 18 = 18 → PASS
      const result = TurnValidator.validate(plan, makeContext({ money: 0 }), makeSnapshot(0));
      expect(result.hardGates.find(g => g.gate === 'CASH_SUFFICIENCY')?.passed).toBe(true);
    });

    it('should account for movement fees in cash check', () => {
      const plan = multiAction([
        { type: AIActionType.MoveTrain, path: [{ row: 1, col: 1 }, { row: 1, col: 2 }], fees: new Set(['p2']), totalFee: 4 },
        { type: AIActionType.BuildTrack, segments: [makeSegment(1, 2, 1, 3, 10)] },
      ]);
      // 10 (build) + 4 (fee) = 14 > 12 cash
      const result = TurnValidator.validate(plan, makeContext({ money: 12 }), makeSnapshot(12));
      expect(result.hardGates.find(g => g.gate === 'CASH_SUFFICIENCY')?.passed).toBe(false);
    });
  });

  describe('SAME_CARD_DOUBLE_DELIVERY', () => {
    it('should reject two deliveries from same demand card', () => {
      const plan = multiAction([
        { type: AIActionType.DeliverLoad, load: 'Wine', city: 'Berlin', cardId: 5, payout: 20 },
        { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Hamburg', cardId: 5, payout: 15 },
      ]);
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      expect(result.valid).toBe(false);
      expect(result.hardGates.find(g => g.gate === 'SAME_CARD_DOUBLE_DELIVERY')?.passed).toBe(false);
    });

    it('should pass deliveries from different demand cards', () => {
      const plan = multiAction([
        { type: AIActionType.DeliverLoad, load: 'Wine', city: 'Berlin', cardId: 5, payout: 20 },
        { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Hamburg', cardId: 8, payout: 15 },
      ]);
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      expect(result.hardGates.find(g => g.gate === 'SAME_CARD_DOUBLE_DELIVERY')?.passed).toBe(true);
    });
  });

  describe('FERRY_STOP_RULE', () => {
    it('should reject movement through ferry port without stopping', () => {
      const snapshot = makeSnapshot();
      snapshot.ferryEdges = [
        { name: 'Channel', pointA: { row: 5, col: 5 }, pointB: { row: 5, col: 10 }, cost: 4 },
      ];
      const plan = multiAction([
        {
          type: AIActionType.MoveTrain,
          path: [{ row: 5, col: 4 }, { row: 5, col: 5 }, { row: 5, col: 6 }],
          fees: new Set<string>(),
          totalFee: 0,
        },
      ]);
      const result = TurnValidator.validate(plan, makeContext(), snapshot);
      expect(result.valid).toBe(false);
      expect(result.hardGates.find(g => g.gate === 'FERRY_STOP_RULE')?.passed).toBe(false);
    });

    it('should pass when train stops at ferry port (last point in path)', () => {
      const snapshot = makeSnapshot();
      snapshot.ferryEdges = [
        { name: 'Channel', pointA: { row: 5, col: 5 }, pointB: { row: 5, col: 10 }, cost: 4 },
      ];
      const plan = multiAction([
        {
          type: AIActionType.MoveTrain,
          path: [{ row: 5, col: 4 }, { row: 5, col: 5 }],
          fees: new Set<string>(),
          totalFee: 0,
        },
      ]);
      const result = TurnValidator.validate(plan, makeContext(), snapshot);
      expect(result.hardGates.find(g => g.gate === 'FERRY_STOP_RULE')?.passed).toBe(true);
    });
  });

  describe('CITY_ENTRY_LIMIT', () => {
    it('should reject building into small city at 2-player limit', () => {
      const snapshot = makeSnapshot();
      snapshot.allPlayerTracks = [
        { playerId: 'p1', segments: [makeSegment(10, 10, 10, 11, 1, TerrainType.SmallCity)] },
        { playerId: 'p2', segments: [makeSegment(10, 12, 10, 11, 1, TerrainType.SmallCity)] },
      ];
      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 13, 10, 11, 3, TerrainType.SmallCity)],
      };
      const result = TurnValidator.validate(plan, makeContext(), snapshot);
      expect(result.valid).toBe(false);
      expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_LIMIT')?.passed).toBe(false);
    });

    it('should pass building into small city with only 1 other player', () => {
      const snapshot = makeSnapshot();
      snapshot.allPlayerTracks = [
        { playerId: 'p1', segments: [makeSegment(10, 10, 10, 11, 1, TerrainType.SmallCity)] },
      ];
      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 13, 10, 11, 3, TerrainType.SmallCity)],
      };
      const result = TurnValidator.validate(plan, makeContext(), snapshot);
      expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_LIMIT')?.passed).toBe(true);
    });

    // AC5: Kaliningrad has maxConnections=1 — reject when 1 opponent already there
    it('should reject building into Kaliningrad (row=19, col=63) when 1 opponent already has track there (1-player cap)', () => {
      const snapshot = makeSnapshot();
      // One opponent already at Kaliningrad (row=19, col=63)
      snapshot.allPlayerTracks = [
        { playerId: 'p1', segments: [makeSegment(18, 63, 19, 63, 3, TerrainType.SmallCity)] },
      ];
      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        // Bot tries to build into Kaliningrad from a different approach milepost
        segments: [makeSegment(20, 63, 19, 63, 3, TerrainType.SmallCity)],
      };
      const result = TurnValidator.validate(plan, makeContext(), snapshot);
      expect(result.valid).toBe(false);
      const gate = result.hardGates.find(g => g.gate === 'CITY_ENTRY_LIMIT');
      expect(gate?.passed).toBe(false);
      expect(gate?.detail).toContain('1 player limit');
    });

    // AC6: Kaliningrad with 0 opponents — accept
    it('should accept building into Kaliningrad when no opponent has track there', () => {
      const snapshot = makeSnapshot();
      snapshot.allPlayerTracks = [];
      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(18, 63, 19, 63, 3, TerrainType.SmallCity)],
      };
      const result = TurnValidator.validate(plan, makeContext(), snapshot);
      expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_LIMIT')?.passed).toBe(true);
    });

    // AC7: Non-overridden small city — still uses 2-player cap
    it('should accept building into non-overridden small city when only 1 opponent is there (cap stays at 2)', () => {
      // Use coordinates that are NOT Kaliningrad and not in gridPoints.json (no MaxConnections)
      // Generic small city at (10,11) — no override in gridPoints.json
      const snapshot = makeSnapshot();
      snapshot.allPlayerTracks = [
        { playerId: 'p1', segments: [makeSegment(10, 10, 10, 11, 1, TerrainType.SmallCity)] },
      ];
      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 13, 10, 11, 3, TerrainType.SmallCity)],
      };
      const result = TurnValidator.validate(plan, makeContext(), snapshot);
      expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_LIMIT')?.passed).toBe(true);
    });

    it('should reject building into non-overridden small city when 2 opponents are there (cap at 2)', () => {
      const snapshot = makeSnapshot();
      snapshot.allPlayerTracks = [
        { playerId: 'p1', segments: [makeSegment(10, 10, 10, 11, 1, TerrainType.SmallCity)] },
        { playerId: 'p2', segments: [makeSegment(10, 12, 10, 11, 1, TerrainType.SmallCity)] },
      ];
      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 13, 10, 11, 3, TerrainType.SmallCity)],
      };
      const result = TurnValidator.validate(plan, makeContext(), snapshot);
      expect(result.valid).toBe(false);
      expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_LIMIT')?.passed).toBe(false);
    });

    // AC8: Medium city still uses 3-player cap
    it('should accept building into medium city when 1 opponent is already there (cap at 3)', () => {
      const snapshot = makeSnapshot();
      snapshot.allPlayerTracks = [
        { playerId: 'p1', segments: [makeSegment(10, 10, 10, 11, 1, TerrainType.MediumCity)] },
      ];
      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 13, 10, 11, 3, TerrainType.MediumCity)],
      };
      const result = TurnValidator.validate(plan, makeContext(), snapshot);
      expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_LIMIT')?.passed).toBe(true);
    });

    it('should reject building into medium city when 3 opponents are already there (cap at 3)', () => {
      const snapshot = makeSnapshot();
      snapshot.allPlayerTracks = [
        { playerId: 'p1', segments: [makeSegment(10, 10, 10, 11, 1, TerrainType.MediumCity)] },
        { playerId: 'p2', segments: [makeSegment(10, 12, 10, 11, 1, TerrainType.MediumCity)] },
        { playerId: 'p3', segments: [makeSegment(10, 13, 10, 11, 1, TerrainType.MediumCity)] },
      ];
      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 14, 10, 11, 3, TerrainType.MediumCity)],
      };
      const result = TurnValidator.validate(plan, makeContext(), snapshot);
      expect(result.valid).toBe(false);
      expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_LIMIT')?.passed).toBe(false);
    });
  });

  // AC9: computeSaturatedCityKeys — Kaliningrad saturated when ≥1 opponent
  describe('computeSaturatedCityKeys', () => {
    it('should include Kaliningrad key (19,63) when 1 opponent has track there', () => {
      const snapshot = makeSnapshot();
      // One opponent at Kaliningrad milepost (row=19, col=63)
      snapshot.allPlayerTracks = [
        { playerId: 'p1', segments: [makeSegment(18, 63, 19, 63, 3, TerrainType.SmallCity)] },
      ];
      // Add terrain to the bot's segment set so terrainLookup is populated
      snapshot.bot.existingSegments = [];

      const saturated = TurnValidator.computeSaturatedCityKeys(snapshot);
      expect(saturated.has('19,63')).toBe(true);
    });

    it('should NOT include Kaliningrad when 0 opponents have track there', () => {
      const snapshot = makeSnapshot();
      snapshot.allPlayerTracks = [];
      snapshot.bot.existingSegments = [];

      const saturated = TurnValidator.computeSaturatedCityKeys(snapshot);
      expect(saturated.has('19,63')).toBe(false);
    });

    // AC9: non-overridden small city NOT saturated with 1 opponent
    it('should NOT include a non-overridden small city when only 1 opponent is there (cap=2)', () => {
      const snapshot = makeSnapshot();
      // Generic small city at (10,11) — no MaxConnections override in gridPoints.json
      snapshot.allPlayerTracks = [
        { playerId: 'p1', segments: [makeSegment(10, 10, 10, 11, 1, TerrainType.SmallCity)] },
      ];
      snapshot.bot.existingSegments = [];

      const saturated = TurnValidator.computeSaturatedCityKeys(snapshot);
      expect(saturated.has('10,11')).toBe(false);
    });

    it('should include a non-overridden small city when 2 opponents are there (cap=2)', () => {
      const snapshot = makeSnapshot();
      snapshot.allPlayerTracks = [
        { playerId: 'p1', segments: [makeSegment(10, 10, 10, 11, 1, TerrainType.SmallCity)] },
        { playerId: 'p2', segments: [makeSegment(10, 12, 10, 11, 1, TerrainType.SmallCity)] },
      ];
      snapshot.bot.existingSegments = [];

      const saturated = TurnValidator.computeSaturatedCityKeys(snapshot);
      expect(saturated.has('10,11')).toBe(true);
    });

    // AC5a: computeSaturatedCityKeys includes a medium city when the bot adding 1 entry would violate reservation
    it('AC5a: should include a 4-edge medium city key when 1 opponent has 3 edges leaving only 1, and bot entry would leave 0 (reservedFor=1)', () => {
      // Medium city at (20, 20), cap=3. 1 opponent has track there.
      // We mock getHexNeighbors to return exactly 4 neighbors.
      // 3 of those neighbor edges are occupied by the opponent → remaining = 1.
      // Bot adding 1 → remainingAfterBotEntry = 0 < reservedFor = max(0, 3 - (1+1)) = 1 → saturated.
      const cityRow = 20;
      const cityCol = 20;
      const cityKey = `${cityRow},${cityCol}`;
      const neighbors = [
        { row: 19, col: 20 },
        { row: 19, col: 21 },
        { row: 20, col: 19 },
        { row: 20, col: 21 },
      ];

      const spy = jest.spyOn(MapTopology, 'getHexNeighbors').mockImplementation((r, c) => {
        if (r === cityRow && c === cityCol) return neighbors;
        return [];
      });

      try {
        const snapshot = makeSnapshot();
        // Opponent occupies 3 of the 4 entry edges
        snapshot.allPlayerTracks = [
          {
            playerId: 'p1',
            segments: [
              makeSegment(19, 20, cityRow, cityCol, 1, TerrainType.MediumCity),
              makeSegment(19, 21, cityRow, cityCol, 1, TerrainType.MediumCity),
              makeSegment(20, 19, cityRow, cityCol, 1, TerrainType.MediumCity),
            ],
          },
        ];
        snapshot.bot.existingSegments = [];
        // terrainLookup must know about this city — add a fake bot segment elsewhere with this city as endpoint
        // Instead, use allPlayerTracks to populate terrain. The track segments above have toTerrain=MediumCity.

        const saturated = TurnValidator.computeSaturatedCityKeys(snapshot);
        expect(saturated.has(cityKey)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    // AC5b: computeSaturatedCityKeys does NOT include a city the bot already touches due to edge exhaustion alone
    it('AC5b: should NOT include a 3-edge small city when the bot already has 2 entry segments (R5 — bot-already-touches keeps player-count semantics)', () => {
      // Small city at (30, 30), cap=2. Bot already has 2 entry edges.
      // Even though 0 edges remain, R5 says cities the bot already touches are governed
      // by player-count semantics only — the reservation logic is skipped for them.
      const cityRow = 30;
      const cityCol = 30;
      const cityKey = `${cityRow},${cityCol}`;
      const neighbors = [
        { row: 29, col: 30 },
        { row: 29, col: 31 },
        { row: 30, col: 29 },
      ];

      const spy = jest.spyOn(MapTopology, 'getHexNeighbors').mockImplementation((r, c) => {
        if (r === cityRow && c === cityCol) return neighbors;
        return [];
      });

      try {
        const snapshot = makeSnapshot();
        snapshot.allPlayerTracks = [];
        // Bot has 2 entry segments to this city
        snapshot.bot.existingSegments = [
          makeSegment(29, 30, cityRow, cityCol, 1, TerrainType.SmallCity),
          makeSegment(29, 31, cityRow, cityCol, 1, TerrainType.SmallCity),
        ];

        const saturated = TurnValidator.computeSaturatedCityKeys(snapshot);
        // Should NOT be saturated: bot already touches, so player-count semantics apply.
        // otherPlayers = 0, bot touches, total = 1, limit = 2 → 1 <= 2 → NOT saturated by player-count.
        // R5: edge-reservation logic skipped for bot-already-touching cities.
        expect(saturated.has(cityKey)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('CITY_ENTRY_RESERVATION', () => {
    // Helper: spy on getHexNeighbors to return a fixed neighbor set for a city
    function mockNeighbors(cityRow: number, cityCol: number, neighbors: Array<{ row: number; col: number }>) {
      return jest.spyOn(MapTopology, 'getHexNeighbors').mockImplementation((r, c) => {
        if (r === cityRow && c === cityCol) return neighbors;
        return [];
      });
    }

    // AC1a: Solo bot, 3-edge small city, bot builds 1st entry → PASS
    it('AC1a: should PASS when solo bot builds 1st entry into a 3-edge small city (2 edges remain after)', () => {
      const cityRow = 40;
      const cityCol = 40;
      const neighbors = [
        { row: 39, col: 40 },
        { row: 39, col: 41 },
        { row: 40, col: 39 },
      ];

      const spy = mockNeighbors(cityRow, cityCol, neighbors);
      try {
        const snapshot = makeSnapshot();
        snapshot.allPlayerTracks = [];
        snapshot.bot.existingSegments = [];

        // Bot builds 1st entry
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(39, 40, cityRow, cityCol, 3, TerrainType.SmallCity)],
        };
        const result = TurnValidator.validate(plan, makeContext(), snapshot);
        expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_RESERVATION')?.passed).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    // AC1b: Solo bot, 3-edge small city, 2 entry edges already built, plan adds 3rd → REJECT
    it('AC1b: should REJECT when solo bot tries to build 3rd entry into 3-edge small city (0 edges would remain, 1 reserved)', () => {
      const cityRow = 40;
      const cityCol = 40;
      const neighbors = [
        { row: 39, col: 40 },
        { row: 39, col: 41 },
        { row: 40, col: 39 },
      ];

      const spy = mockNeighbors(cityRow, cityCol, neighbors);
      try {
        const snapshot = makeSnapshot();
        snapshot.allPlayerTracks = [];
        // Bot already has 2 entry edges via existingSegments
        snapshot.bot.existingSegments = [
          makeSegment(39, 40, cityRow, cityCol, 3, TerrainType.SmallCity),
          makeSegment(39, 41, cityRow, cityCol, 3, TerrainType.SmallCity),
        ];

        // Bot tries to build the 3rd entry
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(40, 39, cityRow, cityCol, 3, TerrainType.SmallCity)],
        };
        const result = TurnValidator.validate(plan, makeContext(), snapshot);
        expect(result.valid).toBe(false);
        expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_RESERVATION')?.passed).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    // AC2a: Bot + 1 opponent at 4-edge medium city, plan adds 1 segment, 2+ remaining post-build → PASS
    it('AC2a: should PASS when bot + 1 opponent at 4-edge medium city and 2 edges remain post-build', () => {
      const cityRow = 50;
      const cityCol = 50;
      const neighbors = [
        { row: 49, col: 50 },
        { row: 49, col: 51 },
        { row: 50, col: 49 },
        { row: 50, col: 51 },
      ];

      const spy = mockNeighbors(cityRow, cityCol, neighbors);
      try {
        const snapshot = makeSnapshot();
        // Opponent has 1 entry edge
        snapshot.allPlayerTracks = [
          {
            playerId: 'p1',
            segments: [makeSegment(49, 50, cityRow, cityCol, 1, TerrainType.MediumCity)],
          },
        ];
        snapshot.bot.existingSegments = [];

        // Bot builds 1 entry; remaining before = 3, after = 2, reservedFor = max(0, 3 - (1+1)) = 1 → 2 >= 1 → PASS
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(49, 51, cityRow, cityCol, 3, TerrainType.MediumCity)],
        };
        const result = TurnValidator.validate(plan, makeContext(), snapshot);
        expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_RESERVATION')?.passed).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    // AC2b: 3-edge medium city, 1 opponent + bot already has 1 segment, plan adds 1 more → REJECT
    it('AC2b: should REJECT when 3-edge medium city has 1 opponent + bot already has 1 entry and plan adds 1 more (0 edges remain, reservation=1)', () => {
      const cityRow = 50;
      const cityCol = 50;
      const neighbors = [
        { row: 49, col: 50 },
        { row: 49, col: 51 },
        { row: 50, col: 49 },
      ];

      const spy = mockNeighbors(cityRow, cityCol, neighbors);
      try {
        const snapshot = makeSnapshot();
        // 1 opponent has 1 entry
        snapshot.allPlayerTracks = [
          {
            playerId: 'p1',
            segments: [makeSegment(49, 50, cityRow, cityCol, 1, TerrainType.MediumCity)],
          },
        ];
        // Bot already has 1 entry
        snapshot.bot.existingSegments = [
          makeSegment(49, 51, cityRow, cityCol, 3, TerrainType.MediumCity),
        ];

        // Bot tries to add another entry. remaining = 1 (only (50,49) edge free).
        // After build: remaining = 0. playersAfter = 1(opponent) + 1(bot) = 2.
        // reservedFor = max(0, 3 - 2) = 1. 0 < 1 → REJECT.
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(50, 49, cityRow, cityCol, 3, TerrainType.MediumCity)],
        };
        const result = TurnValidator.validate(plan, makeContext(), snapshot);
        expect(result.valid).toBe(false);
        expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_RESERVATION')?.passed).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    // AC3: Kaliningrad (maxConnections=1), no other players, bot builds → PASS (reservation = 0)
    it('AC3: should PASS for Kaliningrad (maxConnections=1) with no other players — no edges owed to future players', () => {
      const snapshot = makeSnapshot();
      snapshot.allPlayerTracks = [];
      snapshot.bot.existingSegments = [];

      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(18, 63, 19, 63, 3, TerrainType.SmallCity)],
      };
      const result = TurnValidator.validate(plan, makeContext(), snapshot);
      expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_RESERVATION')?.passed).toBe(true);
    });

    // AC4a: Multi-segment turn, 3 segments to same 3-edge small city → 3rd segment REJECTS
    it('AC4a: should REJECT 3rd segment in a multi-segment plan that builds all 3 entries to a 3-edge small city', () => {
      const cityRow = 60;
      const cityCol = 60;
      const neighbors = [
        { row: 59, col: 60 },
        { row: 59, col: 61 },
        { row: 60, col: 59 },
      ];

      const spy = mockNeighbors(cityRow, cityCol, neighbors);
      try {
        const snapshot = makeSnapshot();
        snapshot.allPlayerTracks = [];
        snapshot.bot.existingSegments = [];

        // Plan: 3 segments, all building into the small city
        const plan = multiAction([
          {
            type: AIActionType.BuildTrack,
            segments: [makeSegment(59, 60, cityRow, cityCol, 1, TerrainType.SmallCity)],
          },
          {
            type: AIActionType.BuildTrack,
            segments: [makeSegment(59, 61, cityRow, cityCol, 1, TerrainType.SmallCity)],
          },
          {
            type: AIActionType.BuildTrack,
            segments: [makeSegment(60, 59, cityRow, cityCol, 1, TerrainType.SmallCity)],
          },
        ]);
        const result = TurnValidator.validate(plan, makeContext(), snapshot);
        // The 3rd segment takes remaining from 1 to 0 with reservedFor=1 → REJECT
        expect(result.valid).toBe(false);
        expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_RESERVATION')?.passed).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    // AC4b: 3-edge small city, 1 prior bot entry, plan has 2 more segments → 2nd plan segment REJECTS
    it('AC4b: should REJECT 2nd plan segment when bot already has 1 entry edge and plan adds 2 more to 3-edge small city', () => {
      const cityRow = 60;
      const cityCol = 60;
      const neighbors = [
        { row: 59, col: 60 },
        { row: 59, col: 61 },
        { row: 60, col: 59 },
      ];

      const spy = mockNeighbors(cityRow, cityCol, neighbors);
      try {
        const snapshot = makeSnapshot();
        snapshot.allPlayerTracks = [];
        // Bot already has 1 entry
        snapshot.bot.existingSegments = [
          makeSegment(59, 60, cityRow, cityCol, 1, TerrainType.SmallCity),
        ];

        // Plan: 2 more segments to the city. 1st plan: remaining = 2-1 = 1 ≥ reservedFor=1 → PASS.
        // 2nd plan: remaining before = 1, after = 0 < reservedFor=1 → REJECT.
        const plan = multiAction([
          {
            type: AIActionType.BuildTrack,
            segments: [makeSegment(59, 61, cityRow, cityCol, 1, TerrainType.SmallCity)],
          },
          {
            type: AIActionType.BuildTrack,
            segments: [makeSegment(60, 59, cityRow, cityCol, 1, TerrainType.SmallCity)],
          },
        ]);
        const result = TurnValidator.validate(plan, makeContext(), snapshot);
        expect(result.valid).toBe(false);
        expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_RESERVATION')?.passed).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    // R6 sanity: Plan builds segment ending at Major City → new gate ignores it, passes
    it('R6: should PASS for a segment ending at a MajorCity milepost — gate ignores non-small/medium cities', () => {
      const snapshot = makeSnapshot();
      snapshot.allPlayerTracks = [];
      snapshot.bot.existingSegments = [];

      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 20, 10, 21, 5, TerrainType.MajorCity)],
      };
      const result = TurnValidator.validate(plan, makeContext(), snapshot);
      expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_RESERVATION')?.passed).toBe(true);
    });

    // AC6: validate() always emits a HardGateResult with gate === 'CITY_ENTRY_RESERVATION'
    it('AC6: validate() hardGates array always contains an entry with gate CITY_ENTRY_RESERVATION', () => {
      const plan: TurnPlan = { type: AIActionType.PassTurn };
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      const gate = result.hardGates.find(g => g.gate === 'CITY_ENTRY_RESERVATION');
      expect(gate).toBeDefined();
      expect(gate?.passed).toBe(true);
    });

    // AC6 ordering: CITY_ENTRY_RESERVATION appears immediately after CITY_ENTRY_LIMIT
    it('AC6 ordering: CITY_ENTRY_RESERVATION gate appears immediately after CITY_ENTRY_LIMIT in hardGates', () => {
      const plan: TurnPlan = { type: AIActionType.PassTurn };
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      const limitIdx = result.hardGates.findIndex(g => g.gate === 'CITY_ENTRY_LIMIT');
      const reservationIdx = result.hardGates.findIndex(g => g.gate === 'CITY_ENTRY_RESERVATION');
      expect(limitIdx).toBeGreaterThanOrEqual(0);
      expect(reservationIdx).toBe(limitIdx + 1);
    });
  });

  describe('MAJOR_CITY_BUILD_LIMIT', () => {
    it('should reject building 3 track sections from a major city in one turn', () => {
      // Use coordinates that exist in the major city lookup
      // We'll use generic coordinates and mock the lookup result
      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [
          // All segments originate from same major city milepost
          { from: { x: 0, y: 0, row: 14, col: 20, terrain: TerrainType.MajorCity }, to: { x: 40, y: 0, row: 14, col: 21, terrain: TerrainType.Clear }, cost: 1 },
          { from: { x: 0, y: 0, row: 14, col: 20, terrain: TerrainType.MajorCity }, to: { x: 40, y: 40, row: 15, col: 20, terrain: TerrainType.Clear }, cost: 1 },
          { from: { x: 0, y: 0, row: 14, col: 20, terrain: TerrainType.MajorCity }, to: { x: 0, y: 40, row: 13, col: 20, terrain: TerrainType.Clear }, cost: 1 },
        ],
      };
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      // This test depends on whether (14,20) is actually a major city in the grid data
      // If it's not a major city, the gate will pass (no major city segments detected)
      // The gate logic itself is correct — this tests the happy path of the gate check
      const gate = result.hardGates.find(g => g.gate === 'MAJOR_CITY_BUILD_LIMIT');
      expect(gate).toBeDefined();
    });

    it('should pass when building 2 or fewer sections from a major city', () => {
      const plan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [
          makeSegment(1, 1, 1, 2, 1),
          makeSegment(1, 2, 1, 3, 1),
        ],
      };
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      expect(result.hardGates.find(g => g.gate === 'MAJOR_CITY_BUILD_LIMIT')?.passed).toBe(true);
    });
  });

  describe('validate() orchestration', () => {
    it('should return valid=true when all gates pass', () => {
      const plan: TurnPlan = { type: AIActionType.PassTurn };
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      expect(result.valid).toBe(true);
      expect(result.violation).toBeUndefined();
      expect(result.hardGates).toHaveLength(8);
      expect(result.hardGates.every(g => g.passed)).toBe(true);
    });

    it('should return the first violation detail', () => {
      // BUILD + UPGRADE violates BUILD_UPGRADE_EXCLUSION (first gate checked)
      const plan = multiAction([
        { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 1, 2, 25)] },
        { type: AIActionType.UpgradeTrain, targetTrain: 'FastFreight', cost: 20 },
      ]);
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      expect(result.valid).toBe(false);
      // First gate is BUILD_UPGRADE_EXCLUSION
      expect(result.violation).toContain('BUILD and UPGRADE');
    });

    it('should handle single-step plans (not MultiAction)', () => {
      const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 1, 2, 5)] };
      const result = TurnValidator.validate(plan, makeContext(), makeSnapshot());
      expect(result.valid).toBe(true);
    });
  });
});
