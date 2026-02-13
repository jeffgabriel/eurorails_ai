import { validate } from '../services/ai/PlanValidator';
import {
  FeasibleOption,
  WorldSnapshot,
  AIActionType,
  TerrainType,
  TrackSegment,
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
      money: 50,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      ...overrides,
    },
    allPlayerTracks: [],
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
