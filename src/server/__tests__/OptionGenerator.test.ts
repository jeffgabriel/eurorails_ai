import { OptionGenerator } from '../services/ai/OptionGenerator';
import { WorldSnapshot, AIActionType, TrackSegment, TerrainType } from '../../shared/types/GameTypes';
import { computeBuildSegments } from '../services/ai/computeBuildSegments';
import { getMajorCityGroups } from '../../shared/services/majorCityGroups';

// Mock computeBuildSegments so we control what segments come back
jest.mock('../services/ai/computeBuildSegments');
jest.mock('../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  _resetCache: jest.fn(),
}));

const mockComputeBuild = computeBuildSegments as jest.Mock;

function makeSegment(fromRow: number, fromCol: number, toRow: number, toCol: number, cost: number): TrackSegment {
  return {
    from: { x: 0, y: 0, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost,
  };
}

function makeSnapshot(overrides?: Partial<WorldSnapshot>): WorldSnapshot {
  return {
    gameId: 'game-1',
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
    },
    allPlayerTracks: [],
    ...overrides,
  };
}

describe('OptionGenerator', () => {
  afterEach(() => jest.clearAllMocks());

  describe('generate', () => {
    it('should always include a PassTurn option', () => {
      mockComputeBuild.mockReturnValue([]);
      const options = OptionGenerator.generate(makeSnapshot());
      const passTurn = options.find((o) => o.action === AIActionType.PassTurn);
      expect(passTurn).toBeDefined();
      expect(passTurn!.feasible).toBe(true);
    });

    it('should include BuildTrack option when segments are available', () => {
      const seg = makeSegment(29, 32, 29, 31, 1);
      mockComputeBuild.mockReturnValue([seg]);

      const options = OptionGenerator.generate(makeSnapshot());
      const buildTrack = options.find(
        (o) => o.action === AIActionType.BuildTrack && o.feasible,
      );
      expect(buildTrack).toBeDefined();
      expect(buildTrack!.segments).toHaveLength(1);
      expect(buildTrack!.estimatedCost).toBe(1);
    });

    it('should return infeasible BuildTrack when no segments found', () => {
      mockComputeBuild.mockReturnValue([]);
      const options = OptionGenerator.generate(makeSnapshot());
      const buildTrack = options.find((o) => o.action === AIActionType.BuildTrack);
      expect(buildTrack).toBeDefined();
      expect(buildTrack!.feasible).toBe(false);
    });

    it('should return infeasible BuildTrack when bot has no money', () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          money: 0,
        },
      });
      const options = OptionGenerator.generate(snapshot);
      const buildTrack = options.find((o) => o.action === AIActionType.BuildTrack);
      expect(buildTrack).toBeDefined();
      expect(buildTrack!.feasible).toBe(false);
      expect(buildTrack!.reason).toContain('No money');
    });
  });

  describe('start positions', () => {
    it('should use major city centers when bot has no track', () => {
      mockComputeBuild.mockReturnValue([]);
      const snapshot = makeSnapshot();

      OptionGenerator.generate(snapshot);

      // computeBuildSegments should have been called with major city positions
      expect(mockComputeBuild).toHaveBeenCalledTimes(1);
      const [startPositions] = mockComputeBuild.mock.calls[0];
      // Should have many positions (one per major city)
      expect(startPositions.length).toBeGreaterThan(0);
    });

    it('should use existing track endpoints when bot has track', () => {
      const existingSeg = makeSegment(29, 32, 29, 31, 1);
      mockComputeBuild.mockReturnValue([]);

      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          existingSegments: [existingSeg],
        },
      });

      OptionGenerator.generate(snapshot);

      expect(mockComputeBuild).toHaveBeenCalledTimes(1);
      const [startPositions] = mockComputeBuild.mock.calls[0];
      expect(startPositions).toEqual([
        { row: 29, col: 32 },
        { row: 29, col: 31 },
      ]);
    });
  });

  describe('budget', () => {
    it('should cap budget at 20M even if bot has more money', () => {
      mockComputeBuild.mockReturnValue([]);
      OptionGenerator.generate(makeSnapshot({ bot: { ...makeSnapshot().bot, money: 100 } }));

      const [, , budget] = mockComputeBuild.mock.calls[0];
      expect(budget).toBe(20);
    });

    it('should use bot money as budget when less than 20M', () => {
      mockComputeBuild.mockReturnValue([]);
      OptionGenerator.generate(makeSnapshot({ bot: { ...makeSnapshot().bot, money: 8 } }));

      const [, , budget] = mockComputeBuild.mock.calls[0];
      expect(budget).toBe(8);
    });
  });

  describe('estimatedCost', () => {
    it('should sum segment costs for estimatedCost', () => {
      const segs = [
        makeSegment(29, 32, 29, 31, 1),
        makeSegment(29, 31, 28, 31, 2),
      ];
      mockComputeBuild.mockReturnValue(segs);

      const options = OptionGenerator.generate(makeSnapshot());
      const buildTrack = options.find(
        (o) => o.action === AIActionType.BuildTrack && o.feasible,
      );
      expect(buildTrack!.estimatedCost).toBe(3);
    });
  });
});
