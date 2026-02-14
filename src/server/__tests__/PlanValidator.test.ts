import { validate } from '../services/ai/PlanValidator';
import {
  FeasibleOption,
  WorldSnapshot,
  AIActionType,
  TerrainType,
  TrackSegment,
  TrainType,
} from '../../shared/types/GameTypes';

function makeSegment(
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
  cost: number,
  fromTerrain: TerrainType = TerrainType.Clear,
  toTerrain: TerrainType = TerrainType.Clear,
): TrackSegment {
  return {
    from: { x: 0, y: 0, row: fromRow, col: fromCol, terrain: fromTerrain },
    to: { x: 0, y: 0, row: toRow, col: toCol, terrain: toTerrain },
    cost,
  };
}

function makeSnapshot(overrides?: Partial<WorldSnapshot['bot']>): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 3,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

function makeBuildOption(segments: TrackSegment[], estimatedCost?: number): FeasibleOption {
  return {
    action: AIActionType.BuildTrack,
    feasible: true,
    reason: 'Build track',
    segments,
    estimatedCost: estimatedCost ?? segments.reduce((s, seg) => s + seg.cost, 0),
  };
}

describe('PlanValidator', () => {
  describe('PassTurn', () => {
    it('should always be valid', () => {
      const option: FeasibleOption = {
        action: AIActionType.PassTurn,
        feasible: true,
        reason: 'Always an option',
      };
      const result = validate(option, makeSnapshot());
      expect(result.valid).toBe(true);
      expect(result.reason).toContain('always valid');
    });
  });

  describe('BuildTrack — segments required', () => {
    it('should reject when segments are missing', () => {
      const option: FeasibleOption = {
        action: AIActionType.BuildTrack,
        feasible: true,
        reason: 'Build track',
        segments: undefined,
      };
      const result = validate(option, makeSnapshot());
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('requires segments');
    });

    it('should reject when segments array is empty', () => {
      const option = makeBuildOption([]);
      const result = validate(option, makeSnapshot());
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('requires segments');
    });
  });

  describe('BuildTrack — $20M budget limit', () => {
    it('should accept when cost equals $20M', () => {
      const seg = makeSegment(10, 10, 10, 11, 20, TerrainType.MajorCity);
      const option = makeBuildOption([seg]);
      const result = validate(option, makeSnapshot({ existingSegments: [seg] }));
      expect(result.valid).toBe(true);
    });

    it('should reject when cost exceeds $20M', () => {
      const seg = makeSegment(10, 10, 10, 11, 21, TerrainType.MajorCity);
      const option = makeBuildOption([seg]);
      const result = validate(option, makeSnapshot({ existingSegments: [seg] }));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('exceeds');
      expect(result.reason).toContain('20M');
    });

    it('should accept when cost is within budget', () => {
      const segs = [
        makeSegment(10, 10, 10, 11, 5, TerrainType.MajorCity),
        makeSegment(10, 11, 10, 12, 5),
      ];
      const option = makeBuildOption(segs);
      const result = validate(option, makeSnapshot({ existingSegments: [segs[0]] }));
      expect(result.valid).toBe(true);
    });
  });

  describe('BuildTrack — sufficient funds', () => {
    it('should accept when bot has enough money', () => {
      const seg = makeSegment(10, 10, 10, 11, 10, TerrainType.MajorCity);
      const option = makeBuildOption([seg]);
      const result = validate(option, makeSnapshot({ money: 15, existingSegments: [seg] }));
      expect(result.valid).toBe(true);
    });

    it('should reject when bot has insufficient money', () => {
      const seg = makeSegment(10, 10, 10, 11, 10, TerrainType.MajorCity);
      const option = makeBuildOption([seg]);
      const result = validate(option, makeSnapshot({ money: 5, existingSegments: [seg] }));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Insufficient funds');
    });

    it('should accept when cost exactly equals money', () => {
      const seg = makeSegment(10, 10, 10, 11, 15, TerrainType.MajorCity);
      const option = makeBuildOption([seg]);
      const result = validate(option, makeSnapshot({ money: 15, existingSegments: [seg] }));
      expect(result.valid).toBe(true);
    });
  });

  describe('BuildTrack — major city start rule', () => {
    it('should accept first track starting from major city', () => {
      const seg = makeSegment(10, 10, 10, 11, 5, TerrainType.MajorCity);
      const option = makeBuildOption([seg]);
      const result = validate(option, makeSnapshot({ existingSegments: [] }));
      expect(result.valid).toBe(true);
    });

    it('should reject first track not starting from major city', () => {
      const seg = makeSegment(10, 10, 10, 11, 1, TerrainType.Clear);
      const option = makeBuildOption([seg]);
      const result = validate(option, makeSnapshot({ existingSegments: [] }));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('major city');
    });

    it('should skip major city check when bot has existing track', () => {
      const existing = makeSegment(5, 5, 5, 6, 1, TerrainType.MajorCity);
      const seg = makeSegment(5, 6, 5, 7, 1, TerrainType.Clear);
      const option = makeBuildOption([seg]);
      const result = validate(option, makeSnapshot({ existingSegments: [existing] }));
      expect(result.valid).toBe(true);
    });
  });

  describe('BuildTrack — segment adjacency', () => {
    it('should accept contiguous segments', () => {
      const segs = [
        makeSegment(10, 10, 10, 11, 5, TerrainType.MajorCity),
        makeSegment(10, 11, 10, 12, 1),
        makeSegment(10, 12, 10, 13, 1),
      ];
      const option = makeBuildOption(segs);
      const result = validate(option, makeSnapshot({ existingSegments: [segs[0]] }));
      expect(result.valid).toBe(true);
    });

    it('should reject non-contiguous segments', () => {
      const segs = [
        makeSegment(10, 10, 10, 11, 5, TerrainType.MajorCity),
        makeSegment(20, 20, 20, 21, 1), // gap — not adjacent to previous
      ];
      const option = makeBuildOption(segs);
      const result = validate(option, makeSnapshot({ existingSegments: [segs[0]] }));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not adjacent');
    });

    it('should accept single segment (no adjacency check needed)', () => {
      const seg = makeSegment(10, 10, 10, 11, 5, TerrainType.MajorCity);
      const option = makeBuildOption([seg]);
      const result = validate(option, makeSnapshot({ existingSegments: [] }));
      expect(result.valid).toBe(true);
    });
  });

  describe('ValidationResult format', () => {
    it('should return valid:true with reason for valid plans', () => {
      const seg = makeSegment(10, 10, 10, 11, 5, TerrainType.MajorCity);
      const option = makeBuildOption([seg]);
      const result = validate(option, makeSnapshot());
      expect(result).toEqual({ valid: true, reason: 'All validations passed' });
    });

    it('should return valid:false with descriptive reason for invalid plans', () => {
      const seg = makeSegment(10, 10, 10, 11, 25, TerrainType.MajorCity);
      const option = makeBuildOption([seg]);
      const result = validate(option, makeSnapshot());
      expect(result.valid).toBe(false);
      expect(result.reason).toBeTruthy();
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * TEST-003: PlanValidator.validateMovement
 * ──────────────────────────────────────────────────────────────────────── */

function makeMoveOption(
  movementPath: { row: number; col: number }[],
  mileposts: number,
  estimatedCost?: number,
): FeasibleOption {
  return {
    action: AIActionType.MoveTrain,
    feasible: true,
    reason: 'Move toward city',
    movementPath,
    targetPosition: movementPath[movementPath.length - 1],
    mileposts,
    estimatedCost: estimatedCost ?? 0,
  };
}

function makeMoveSnapshot(overrides?: Partial<WorldSnapshot['bot']>): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [42],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: null,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

describe('PlanValidator — validateMovement', () => {
  describe('valid movement plans', () => {
    it('should accept a valid movement plan within speed limit', () => {
      const path = [
        { row: 10, col: 10 },
        { row: 11, col: 10 },
        { row: 12, col: 10 },
      ];
      const option = makeMoveOption(path, 2);
      const result = validate(option, makeMoveSnapshot());
      expect(result.valid).toBe(true);
      expect(result.reason).toContain('passed');
    });

    it('should accept movement exactly at speed limit', () => {
      // Freight speed = 9
      const path = Array.from({ length: 10 }, (_, i) => ({ row: 10 + i, col: 10 }));
      const option = makeMoveOption(path, 9);
      const result = validate(option, makeMoveSnapshot());
      expect(result.valid).toBe(true);
    });
  });

  describe('speed limit violations', () => {
    it('should reject movement exceeding Freight speed of 9', () => {
      const path = Array.from({ length: 12 }, (_, i) => ({ row: 10 + i, col: 10 }));
      const option = makeMoveOption(path, 11); // 11 > 9
      const result = validate(option, makeMoveSnapshot({ trainType: TrainType.Freight }));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('exceeds speed limit');
      expect(result.reason).toContain('9');
    });

    it('should reject movement exceeding FastFreight speed of 12', () => {
      const path = Array.from({ length: 15 }, (_, i) => ({ row: 10 + i, col: 10 }));
      const option = makeMoveOption(path, 14); // 14 > 12
      const result = validate(option, makeMoveSnapshot({ trainType: TrainType.FastFreight }));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('exceeds speed limit');
      expect(result.reason).toContain('12');
    });

    it('should accept FastFreight moving at 12 mileposts', () => {
      const path = Array.from({ length: 13 }, (_, i) => ({ row: 10 + i, col: 10 }));
      const option = makeMoveOption(path, 12);
      const result = validate(option, makeMoveSnapshot({ trainType: TrainType.FastFreight }));
      expect(result.valid).toBe(true);
    });
  });

  describe('insufficient funds for track usage fees', () => {
    it('should reject when bot cannot afford track usage fees', () => {
      const path = [
        { row: 10, col: 10 },
        { row: 11, col: 10 },
      ];
      const option = makeMoveOption(path, 1, 8); // 8M fee
      const result = validate(option, makeMoveSnapshot({ money: 5 })); // only 5M
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Insufficient funds');
    });

    it('should accept when bot can afford track usage fees', () => {
      const path = [
        { row: 10, col: 10 },
        { row: 11, col: 10 },
      ];
      const option = makeMoveOption(path, 1, 4); // 4M fee
      const result = validate(option, makeMoveSnapshot({ money: 10 }));
      expect(result.valid).toBe(true);
    });

    it('should accept zero-fee movement regardless of money', () => {
      const path = [
        { row: 10, col: 10 },
        { row: 11, col: 10 },
      ];
      const option = makeMoveOption(path, 1, 0);
      const result = validate(option, makeMoveSnapshot({ money: 0 }));
      expect(result.valid).toBe(true);
    });
  });

  describe('missing movement path', () => {
    it('should reject when movementPath is undefined', () => {
      const option: FeasibleOption = {
        action: AIActionType.MoveTrain,
        feasible: true,
        reason: 'Move',
        movementPath: undefined,
        mileposts: 2,
      };
      const result = validate(option, makeMoveSnapshot());
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('movement path');
    });

    it('should reject when movementPath is empty', () => {
      const option = makeMoveOption([], 0);
      const result = validate(option, makeMoveSnapshot());
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('movement path');
    });
  });

  describe('no position', () => {
    it('should reject when bot has no position', () => {
      const path = [
        { row: 10, col: 10 },
        { row: 11, col: 10 },
      ];
      const option = makeMoveOption(path, 1);
      const result = validate(option, makeMoveSnapshot({ position: null }));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('no position');
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * TEST-003: PlanValidator.validatePickup / validateDelivery
 * ──────────────────────────────────────────────────────────────────────── */

import { LoadType } from '../../shared/types/LoadTypes';

jest.mock('../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map([
    ['10,10', { row: 10, col: 10, terrain: 3, name: 'Berlin' }],
    ['20,20', { row: 20, col: 20, terrain: 0 }], // no name = not a city
  ])),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  _resetCache: jest.fn(),
}));

function makePickupSnapshot(overrides?: Partial<WorldSnapshot['bot']>, topOverrides?: Partial<WorldSnapshot>): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [42],
      resolvedDemands: [
        { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 10 }] },
      ],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: null,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: { Berlin: ['Coal', 'Iron'] },
    ...topOverrides,
  };
}

function makePickupOption2(loadType: string): FeasibleOption {
  return {
    action: AIActionType.PickupLoad,
    feasible: true,
    reason: `Pick up ${loadType}`,
    loadType: loadType as LoadType,
    targetCity: 'Berlin',
  };
}

function makeDeliveryOption2(loadType: string, cardId: number): FeasibleOption {
  return {
    action: AIActionType.DeliverLoad,
    feasible: true,
    reason: `Deliver ${loadType}`,
    loadType: loadType as LoadType,
    targetCity: 'Berlin',
    cardId,
    payment: 10,
  };
}

describe('PlanValidator — validatePickup', () => {
  it('should accept valid pickup at city with available load', () => {
    const option = makePickupOption2('Coal');
    const result = validate(option, makePickupSnapshot());
    expect(result.valid).toBe(true);
  });

  it('should reject pickup when game is not active', () => {
    const option = makePickupOption2('Coal');
    const result = validate(option, makePickupSnapshot({}, { gameStatus: 'initialBuild' as any }));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not active');
  });

  it('should reject pickup when bot has no position', () => {
    const option = makePickupOption2('Coal');
    const result = validate(option, makePickupSnapshot({ position: null }));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('no position');
  });

  it('should reject pickup when bot is not at a city', () => {
    const option = makePickupOption2('Coal');
    const result = validate(option, makePickupSnapshot({ position: { row: 20, col: 20 } }));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not at a city');
  });

  it('should reject pickup when loadType is missing', () => {
    const option: FeasibleOption = {
      action: AIActionType.PickupLoad,
      feasible: true,
      reason: 'Pick up',
    };
    const result = validate(option, makePickupSnapshot());
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('loadType');
  });

  it('should reject pickup when load is not available at city', () => {
    const option = makePickupOption2('Wine'); // Wine not in Berlin availability
    const result = validate(option, makePickupSnapshot());
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not available');
  });

  it('should reject pickup when train is at full capacity', () => {
    const option = makePickupOption2('Coal');
    const result = validate(option, makePickupSnapshot({
      loads: ['Iron', 'Wine'], // Freight capacity = 2
      trainType: TrainType.Freight,
    }));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('full capacity');
  });
});

describe('PlanValidator — validateDelivery', () => {
  it('should accept valid delivery at matching city', () => {
    const option = makeDeliveryOption2('Coal', 42);
    const result = validate(option, makePickupSnapshot({ loads: ['Coal'] }));
    expect(result.valid).toBe(true);
  });

  it('should reject delivery when game is not active', () => {
    const option = makeDeliveryOption2('Coal', 42);
    const result = validate(option, makePickupSnapshot({ loads: ['Coal'] }, { gameStatus: 'initialBuild' as any }));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not active');
  });

  it('should reject delivery when bot has no position', () => {
    const option = makeDeliveryOption2('Coal', 42);
    const result = validate(option, makePickupSnapshot({ position: null, loads: ['Coal'] }));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('no position');
  });

  it('should reject delivery when loadType is missing', () => {
    const option: FeasibleOption = {
      action: AIActionType.DeliverLoad,
      feasible: true,
      reason: 'Deliver',
      cardId: 42,
    };
    const result = validate(option, makePickupSnapshot({ loads: ['Coal'] }));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('loadType');
  });

  it('should reject delivery when cardId is missing', () => {
    const option: FeasibleOption = {
      action: AIActionType.DeliverLoad,
      feasible: true,
      reason: 'Deliver',
      loadType: 'Coal' as LoadType,
    };
    const result = validate(option, makePickupSnapshot({ loads: ['Coal'] }));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('cardId');
  });

  it('should reject delivery when bot is not carrying the load', () => {
    const option = makeDeliveryOption2('Coal', 42);
    const result = validate(option, makePickupSnapshot({ loads: ['Wine'] })); // carrying Wine, not Coal
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not carrying');
  });

  it('should reject delivery when card is not in bot hand', () => {
    const option = makeDeliveryOption2('Coal', 99); // card 99 not in hand
    const result = validate(option, makePickupSnapshot({ loads: ['Coal'] }));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not in bot');
  });

  it('should reject delivery when demand card has no matching demand for this city+load', () => {
    const option = makeDeliveryOption2('Iron', 42); // card 42 demands Coal at Berlin, not Iron
    const result = validate(option, makePickupSnapshot({ loads: ['Iron'] }));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('no demand');
  });
});
