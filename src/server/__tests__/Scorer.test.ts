import { Scorer } from '../services/ai/Scorer';
import {
  FeasibleOption,
  WorldSnapshot,
  BotConfig,
  BotArchetype,
  BotSkillLevel,
  AIActionType,
  TerrainType,
  TrackSegment,
} from '../../shared/types/GameTypes';

// Mock MapTopology so we don't load gridPoints.json
jest.mock('../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  _resetCache: jest.fn(),
}));

function makeBotConfig(archetype: BotArchetype = BotArchetype.Balanced): BotConfig {
  return { skillLevel: BotSkillLevel.Medium, archetype };
}

function makeSegment(cost: number): TrackSegment {
  return {
    from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: 1, col: 0, terrain: TerrainType.Clear },
    cost,
  };
}

function makeBuildOption(segments: TrackSegment[], targetCity?: string): FeasibleOption {
  return {
    action: AIActionType.BuildTrack,
    feasible: true,
    reason: 'Build track',
    segments,
    estimatedCost: segments.reduce((s, seg) => s + seg.cost, 0),
    targetCity,
  };
}

function makePassOption(): FeasibleOption {
  return {
    action: AIActionType.PassTurn,
    feasible: true,
    reason: 'Always an option',
  };
}

function makeSnapshot(overrides?: Partial<WorldSnapshot['bot']>): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 1,
    bot: {
      playerId: 'bot-1',
      money: 50,
      position: null,
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

describe('Scorer', () => {
  describe('score', () => {
    it('should assign higher score to BuildTrack than PassTurn', () => {
      const options = [
        makePassOption(),
        makeBuildOption([makeSegment(1)]),
      ];
      const scored = Scorer.score(options, makeSnapshot(), makeBotConfig());

      expect(scored[0].action).toBe(AIActionType.BuildTrack);
      expect(scored[0].score!).toBeGreaterThan(scored[1].score!);
    });

    it('should return options sorted highest score first', () => {
      const options = [
        makePassOption(),
        makeBuildOption([makeSegment(1)]),
        makeBuildOption([makeSegment(1), makeSegment(1)]),
      ];
      const scored = Scorer.score(options, makeSnapshot(), makeBotConfig());

      for (let i = 0; i < scored.length - 1; i++) {
        expect(scored[i].score!).toBeGreaterThanOrEqual(scored[i + 1].score!);
      }
    });

    it('should give infeasible options -Infinity score', () => {
      const options: FeasibleOption[] = [
        { action: AIActionType.BuildTrack, feasible: false, reason: 'No money' },
        makePassOption(),
      ];
      const scored = Scorer.score(options, makeSnapshot(), makeBotConfig());

      const infeasible = scored.find((o) => !o.feasible);
      expect(infeasible!.score).toBe(-Infinity);
    });

    it('should reward more segments with higher score', () => {
      const one = makeBuildOption([makeSegment(1)]);
      const three = makeBuildOption([makeSegment(1), makeSegment(1), makeSegment(1)]);
      const scored = Scorer.score([one, three], makeSnapshot(), makeBotConfig());

      expect(scored[0].segments!.length).toBe(3);
      expect(scored[0].score!).toBeGreaterThan(scored[1].score!);
    });

    it('should penalize higher estimated cost', () => {
      const cheap = makeBuildOption([makeSegment(1)]);
      const expensive = makeBuildOption([makeSegment(5)]);
      const scored = Scorer.score([cheap, expensive], makeSnapshot(), makeBotConfig());

      expect(scored[0].estimatedCost).toBe(1);
      expect(scored[0].score!).toBeGreaterThan(scored[1].score!);
    });

    it('should give bonus for reaching a target city', () => {
      const withCity = makeBuildOption([makeSegment(1)], 'Paris');
      const noCity = makeBuildOption([makeSegment(1)]);
      const scored = Scorer.score([withCity, noCity], makeSnapshot(), makeBotConfig());

      const parisOption = scored.find((o) => o.targetCity === 'Paris');
      const noCityOption = scored.find((o) => !o.targetCity);
      expect(parisOption!.score!).toBeGreaterThan(noCityOption!.score!);
    });
  });

  describe('archetype bonuses', () => {
    it('should give BuilderFirst extra segment bonus', () => {
      const segs = [makeSegment(1), makeSegment(1)];
      const option = makeBuildOption(segs);

      const balanced = Scorer.score(
        [{ ...option }],
        makeSnapshot(),
        makeBotConfig(BotArchetype.Balanced),
      );

      const builderFirst = Scorer.score(
        [{ ...option }],
        makeSnapshot(),
        makeBotConfig(BotArchetype.BuilderFirst),
      );

      expect(builderFirst[0].score!).toBeGreaterThan(balanced[0].score!);
    });
  });

  describe('PassTurn scoring', () => {
    it('should give PassTurn a score of 0', () => {
      const options = [makePassOption()];
      const scored = Scorer.score(options, makeSnapshot(), makeBotConfig());
      expect(scored[0].score).toBe(0);
    });
  });
});
