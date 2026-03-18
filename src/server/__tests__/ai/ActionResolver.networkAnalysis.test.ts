/**
 * ActionResolver.networkAnalysis.test.ts — Integration tests for network analysis in resolveBuild.
 *
 * Tests the JIRA-113 integration: pre-build analysis (findNearestNetworkPoint)
 * and post-build validation (detectParallelPath) within ActionResolver.resolveBuild().
 */

import { ActionResolver } from '../../services/ai/ActionResolver';
import {
  WorldSnapshot,
  GameContext,
  LLMActionIntent,
  AIActionType,
  TrackSegment,
  TrainType,
  TerrainType,
  TurnPlanBuildTrack,
} from '../../../shared/types/GameTypes';
import type { GridPointData } from '../../services/ai/MapTopology';

// ─── Mock modules ────────────────────────────────────────────────────────────

jest.mock('../../services/ai/computeBuildSegments');
jest.mock('../../../shared/services/trackUsageFees');
jest.mock('../../services/ai/MapTopology');
jest.mock('../../services/ai/NetworkBuildAnalyzer');
jest.mock('../../../shared/services/majorCityGroups', () => {
  const actual = jest.requireActual('../../../shared/services/majorCityGroups');
  return {
    ...actual,
    getMajorCityGroups: jest.fn(),
    getMajorCityLookup: jest.fn(),
    getFerryEdges: jest.fn().mockReturnValue([]),
    computeEffectivePathLength: jest.fn().mockReturnValue(1),
  };
});

import { computeBuildSegments } from '../../services/ai/computeBuildSegments';
import { loadGridPoints, hexDistance, makeKey } from '../../services/ai/MapTopology';
import { getMajorCityGroups, getMajorCityLookup } from '../../../shared/services/majorCityGroups';
import { NetworkBuildAnalyzer } from '../../services/ai/NetworkBuildAnalyzer';

const mockComputeBuildSegments = computeBuildSegments as jest.MockedFunction<typeof computeBuildSegments>;
const mockLoadGridPoints = loadGridPoints as jest.MockedFunction<typeof loadGridPoints>;
const mockGetMajorCityGroups = getMajorCityGroups as jest.MockedFunction<typeof getMajorCityGroups>;
const mockGetMajorCityLookup = getMajorCityLookup as jest.MockedFunction<typeof getMajorCityLookup>;
const mockHexDistance = hexDistance as jest.MockedFunction<typeof hexDistance>;
const mockMakeKey = makeKey as jest.MockedFunction<typeof makeKey>;
const mockShouldSkipAnalysis = NetworkBuildAnalyzer.shouldSkipAnalysis as jest.MockedFunction<typeof NetworkBuildAnalyzer.shouldSkipAnalysis>;
const mockFindNearestNetworkPoint = NetworkBuildAnalyzer.findNearestNetworkPoint as jest.MockedFunction<typeof NetworkBuildAnalyzer.findNearestNetworkPoint>;
const mockDetectParallelPath = NetworkBuildAnalyzer.detectParallelPath as jest.MockedFunction<typeof NetworkBuildAnalyzer.detectParallelPath>;
const mockLogNearestPointResult = NetworkBuildAnalyzer.logNearestPointResult as jest.MockedFunction<typeof NetworkBuildAnalyzer.logNearestPointResult>;
const mockLogParallelDetection = NetworkBuildAnalyzer.logParallelDetection as jest.MockedFunction<typeof NetworkBuildAnalyzer.logParallelDetection>;
const mockLogRerouteDecision = NetworkBuildAnalyzer.logRerouteDecision as jest.MockedFunction<typeof NetworkBuildAnalyzer.logRerouteDecision>;
const mockLogRerouteFallback = NetworkBuildAnalyzer.logRerouteFallback as jest.MockedFunction<typeof NetworkBuildAnalyzer.logRerouteFallback>;
const mockLogAnalysisError = NetworkBuildAnalyzer.logAnalysisError as jest.MockedFunction<typeof NetworkBuildAnalyzer.logAnalysisError>;

// ─── Factory helpers ─────────────────────────────────────────────────────────

function makeSegment(fromRow: number, fromCol: number, toRow: number, toCol: number, cost = 1): TrackSegment {
  return {
    from: { x: fromCol * 50, y: fromRow * 45, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: toCol * 50, y: toRow * 45, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost,
  };
}

function makeWorldSnapshot(overrides: Partial<WorldSnapshot['bot']> = {}): WorldSnapshot {
  const defaultSegments = [
    makeSegment(5, 5, 5, 6),
    makeSegment(5, 6, 5, 7),
    makeSegment(5, 7, 5, 8),
  ];
  return {
    gameId: 'game-1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot',
      money: 50,
      position: { row: 5, col: 5 },
      existingSegments: defaultSegments,
      demandCards: [1, 2, 3],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: { skillLevel: 'medium' },
      ferryHalfSpeed: false,
      connectedMajorCityCount: 0,
      ...overrides,
    } as WorldSnapshot['bot'],
    allPlayerTracks: [
      { playerId: 'bot-1', segments: overrides.existingSegments ?? defaultSegments },
    ],
    loadAvailability: {},
  };
}

function makeGameContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { city: 'TestCity', row: 5, col: 5 },
    money: 50,
    trainType: TrainType.Freight,
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
    totalMajorCities: 20,
    trackSummary: '3 segments',
    turnBuildCost: 0,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'operate',
    turnNumber: 5,
    ...overrides,
  };
}

function setupGridPoints(): void {
  const grid = new Map<string, GridPointData>();
  grid.set('10,10', { row: 10, col: 10, terrain: TerrainType.MajorCity, name: 'Berlin' });
  grid.set('5,5', { row: 5, col: 5, terrain: TerrainType.Clear });
  mockLoadGridPoints.mockReturnValue(grid);
}

function setupMajorCities(): void {
  mockGetMajorCityGroups.mockReturnValue([
    { cityName: 'Berlin', center: { row: 10, col: 10 }, outposts: [{ row: 10, col: 11 }] },
  ] as any);
  mockGetMajorCityLookup.mockReturnValue(
    new Map([['Berlin', { cityName: 'Berlin', center: { row: 10, col: 10 }, outposts: [{ row: 10, col: 11 }] }]]) as any,
  );
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  setupGridPoints();
  setupMajorCities();
  mockHexDistance.mockReturnValue(5);
  mockMakeKey.mockImplementation((row: number, col: number) => `${row},${col}`);
  // Default: analysis enabled
  mockShouldSkipAnalysis.mockReturnValue(false);
  // Default: no nearby network point
  mockFindNearestNetworkPoint.mockReturnValue(null);
  // Default: no parallel path
  mockDetectParallelPath.mockReturnValue({ isParallel: false, parallelSegmentCount: 0 });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ActionResolver.resolveBuild — network analysis integration', () => {
  describe('backward compatibility (small network)', () => {
    it('skips analysis when shouldSkipAnalysis returns true', async () => {
      mockShouldSkipAnalysis.mockReturnValue(true);
      const resultSegments = [makeSegment(5, 5, 6, 6)];
      mockComputeBuildSegments.mockReturnValue(resultSegments);

      const snapshot = makeWorldSnapshot({ existingSegments: [makeSegment(5, 5, 5, 6)] });
      const intent: LLMActionIntent = { action: AIActionType.BuildTrack, details: { toward: 'Berlin' }, reasoning: '', planHorizon: '' };

      const result = await ActionResolver.resolve(intent, snapshot, makeGameContext());

      expect(result.success).toBe(true);
      expect(mockFindNearestNetworkPoint).not.toHaveBeenCalled();
      expect(mockDetectParallelPath).not.toHaveBeenCalled();
    });

    it('skips analysis when bot has no track', async () => {
      const resultSegments = [makeSegment(10, 10, 10, 11)];
      mockComputeBuildSegments.mockReturnValue(resultSegments);

      const snapshot = makeWorldSnapshot({ existingSegments: [], position: null });
      const intent: LLMActionIntent = { action: AIActionType.BuildTrack, details: { toward: 'Berlin' }, reasoning: '', planHorizon: '' };

      const result = await ActionResolver.resolve(intent, snapshot, makeGameContext(), 'Berlin');

      expect(result.success).toBe(true);
      // No track means hasTrack=false, so network analysis is skipped
      expect(mockShouldSkipAnalysis).not.toHaveBeenCalled();
    });
  });

  describe('pre-build analysis (findNearestNetworkPoint)', () => {
    it('calls findNearestNetworkPoint when bot has track and analysis enabled', async () => {
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 8, 6, 8)]);

      const intent: LLMActionIntent = { action: AIActionType.BuildTrack, details: { toward: 'Berlin' }, reasoning: '', planHorizon: '' };
      await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      expect(mockFindNearestNetworkPoint).toHaveBeenCalledTimes(1);
      expect(mockLogNearestPointResult).toHaveBeenCalledTimes(1);
    });

    it('augments startPositions when nearby network point found within budget', async () => {
      mockFindNearestNetworkPoint.mockReturnValue({
        point: { row: 8, col: 8 },
        distance: 3,
        buildCost: 5,
      });
      mockComputeBuildSegments.mockReturnValue([makeSegment(8, 8, 9, 9)]);

      const intent: LLMActionIntent = { action: AIActionType.BuildTrack, details: { toward: 'Berlin' }, reasoning: '', planHorizon: '' };
      await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      // computeBuildSegments should be called with augmented startPositions
      expect(mockComputeBuildSegments).toHaveBeenCalled();
      const callArgs = mockComputeBuildSegments.mock.calls[0];
      const startPositions = callArgs[0];
      // The nearby point should be in startPositions
      expect(startPositions).toContainEqual({ row: 8, col: 8 });
    });
  });

  describe('post-build validation (detectParallelPath)', () => {
    it('calls detectParallelPath after segments are computed', async () => {
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 8, 6, 8), makeSegment(6, 8, 7, 8)]);

      const intent: LLMActionIntent = { action: AIActionType.BuildTrack, details: { toward: 'Berlin' }, reasoning: '', planHorizon: '' };
      await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      expect(mockDetectParallelPath).toHaveBeenCalledTimes(1);
      expect(mockLogParallelDetection).toHaveBeenCalledTimes(1);
    });

    it('re-runs computeBuildSegments when parallel detected with waypoint', async () => {
      const originalSegments = [makeSegment(5, 8, 6, 8, 3), makeSegment(6, 8, 7, 8, 3)];
      const reroutedSegments = [makeSegment(5, 7, 6, 7, 2)];

      mockComputeBuildSegments
        .mockReturnValueOnce(originalSegments)  // first call: original path
        .mockReturnValueOnce(reroutedSegments); // second call: rerouted path

      mockDetectParallelPath.mockReturnValue({
        isParallel: true,
        parallelSegmentCount: 4,
        suggestedWaypoint: { row: 6, col: 7 },
        existingTrackNearby: [{ row: 6, col: 7 }],
      });

      const intent: LLMActionIntent = { action: AIActionType.BuildTrack, details: { toward: 'Berlin' }, reasoning: '', planHorizon: '' };
      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      expect(result.success).toBe(true);
      expect(mockComputeBuildSegments).toHaveBeenCalledTimes(2);
      expect(mockLogRerouteDecision).toHaveBeenCalled();
      // Should use rerouted segments
      const plan = result.plan as TurnPlanBuildTrack;
      expect(plan.segments).toEqual(reroutedSegments);
    });

    it('falls back to original path when rerouted exceeds budget', async () => {
      const originalSegments = [makeSegment(5, 8, 6, 8, 5)];
      const expensiveReroutedSegments = [makeSegment(5, 7, 6, 7, 100)]; // way over budget

      mockComputeBuildSegments
        .mockReturnValueOnce(originalSegments)
        .mockReturnValueOnce(expensiveReroutedSegments);

      mockDetectParallelPath.mockReturnValue({
        isParallel: true,
        parallelSegmentCount: 3,
        suggestedWaypoint: { row: 6, col: 7 },
        existingTrackNearby: [{ row: 6, col: 7 }],
      });

      const intent: LLMActionIntent = { action: AIActionType.BuildTrack, details: { toward: 'Berlin' }, reasoning: '', planHorizon: '' };
      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      expect(result.success).toBe(true);
      expect(mockLogRerouteFallback).toHaveBeenCalled();
      // Should fall back to original segments
      const plan = result.plan as TurnPlanBuildTrack;
      expect(plan.segments).toEqual(originalSegments);
    });
  });

  describe('JIRA-128: parallel track prevention wiring', () => {
    it('passes networkNodeKeys as existingTrackIndex to computeBuildSegments', async () => {
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 8, 6, 8)]);

      const intent: LLMActionIntent = { action: AIActionType.BuildTrack, details: { toward: 'Berlin' }, reasoning: '', planHorizon: '' };
      await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      expect(mockComputeBuildSegments).toHaveBeenCalled();
      const callArgs = mockComputeBuildSegments.mock.calls[0];
      // existingTrackIndex is the 8th parameter (index 7)
      const existingTrackIndex = callArgs[7] as Set<string> | undefined;
      expect(existingTrackIndex).toBeInstanceOf(Set);
      // Should contain all network node keys from existing segments (5,5 5,6 5,7 5,8)
      expect(existingTrackIndex!.has('5,5')).toBe(true);
      expect(existingTrackIndex!.has('5,6')).toBe(true);
      expect(existingTrackIndex!.has('5,7')).toBe(true);
      expect(existingTrackIndex!.has('5,8')).toBe(true);
    });

    it('does not pass existingTrackIndex when analysis is skipped', async () => {
      mockShouldSkipAnalysis.mockReturnValue(true);
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 5, 6, 6)]);

      const snapshot = makeWorldSnapshot({ existingSegments: [makeSegment(5, 5, 5, 6)] });
      const intent: LLMActionIntent = { action: AIActionType.BuildTrack, details: { toward: 'Berlin' }, reasoning: '', planHorizon: '' };
      await ActionResolver.resolve(intent, snapshot, makeGameContext());

      const callArgs = mockComputeBuildSegments.mock.calls[0];
      const existingTrackIndex = callArgs[7];
      expect(existingTrackIndex).toBeUndefined();
    });

    it('replaces sources with waypoint-only on parallel reroute (not append)', async () => {
      const originalSegments = [makeSegment(5, 8, 6, 8, 3), makeSegment(6, 8, 7, 8, 3)];
      const reroutedSegments = [makeSegment(5, 7, 6, 7, 2)];

      mockComputeBuildSegments
        .mockReturnValueOnce(originalSegments)
        .mockReturnValueOnce(reroutedSegments);

      mockDetectParallelPath.mockReturnValue({
        isParallel: true,
        parallelSegmentCount: 4,
        suggestedWaypoint: { row: 6, col: 7 },
        existingTrackNearby: [{ row: 6, col: 7 }],
      });

      const intent: LLMActionIntent = { action: AIActionType.BuildTrack, details: { toward: 'Berlin' }, reasoning: '', planHorizon: '' };
      await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      // Second call is the reroute
      expect(mockComputeBuildSegments).toHaveBeenCalledTimes(2);
      const rerouteCallArgs = mockComputeBuildSegments.mock.calls[1];
      const rerouteStartPositions = rerouteCallArgs[0];
      // Should be ONLY the waypoint, not appended to original sources
      expect(rerouteStartPositions).toEqual([{ row: 6, col: 7 }]);
      // Should also pass existingTrackIndex
      const rerouteExistingTrackIndex = rerouteCallArgs[7] as Set<string> | undefined;
      expect(rerouteExistingTrackIndex).toBeInstanceOf(Set);
    });
  });

  describe('graceful degradation', () => {
    it('continues normally when findNearestNetworkPoint throws', async () => {
      mockFindNearestNetworkPoint.mockImplementation(() => { throw new Error('BFS exploded'); });
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 8, 6, 8)]);

      const intent: LLMActionIntent = { action: AIActionType.BuildTrack, details: { toward: 'Berlin' }, reasoning: '', planHorizon: '' };
      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      expect(result.success).toBe(true);
      expect(mockLogAnalysisError).toHaveBeenCalled();
    });

    it('continues normally when detectParallelPath throws', async () => {
      mockDetectParallelPath.mockImplementation(() => { throw new Error('Detection failed'); });
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 8, 6, 8)]);

      const intent: LLMActionIntent = { action: AIActionType.BuildTrack, details: { toward: 'Berlin' }, reasoning: '', planHorizon: '' };
      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      expect(result.success).toBe(true);
      expect(mockLogAnalysisError).toHaveBeenCalled();
    });
  });
});
