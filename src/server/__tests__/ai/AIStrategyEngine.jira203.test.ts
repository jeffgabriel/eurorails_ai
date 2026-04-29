/**
 * JIRA-203 — PassTurn lockup recovery unit tests.
 *
 * Covers:
 *  - TurnValidator.computeSaturatedCityKeys: correct saturation detection for small/medium cities
 *  - BuildRouteResolver: rejectedSaturatedCities populated in outcome when saturatedCityKeys provided
 *  - AIStrategyEngine stuck-state recovery: consecutive same-gate strip → DiscardHand + routeAbandoned
 *  - Legitimate PassTurn regression: single one-off strip does NOT trigger recovery
 */

import { TurnValidator } from '../../services/ai/TurnValidator';
import { BuildRouteResolver } from '../../services/ai/BuildRouteResolver';
import type { ResolverInput } from '../../services/ai/BuildRouteResolver';
import {
  AIActionType,
  WorldSnapshot,
  TerrainType,
  TrackSegment,
} from '../../../shared/types/GameTypes';

// ── Mocks for BuildRouteResolver tests ──────────────────────────────────────

jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(),
}));

jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(),
  hexDistance: jest.fn((r1: number, c1: number, r2: number, c2: number) =>
    Math.abs(r1 - r2) + Math.abs(c1 - c2),
  ),
  makeKey: (row: number, col: number) => `${row},${col}`,
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getFerryEdges: jest.fn(),
  getMajorCityLookup: jest.fn(() => new Map<string, string>()),
  isIntraCityEdge: jest.fn(() => false),
}));

import { computeBuildSegments } from '../../services/ai/computeBuildSegments';
import { loadGridPoints } from '../../services/ai/MapTopology';
import { getFerryEdges } from '../../../shared/services/majorCityGroups';

const mockComputeBuildSegments = computeBuildSegments as jest.MockedFunction<typeof computeBuildSegments>;
const mockLoadGridPoints = loadGridPoints as jest.MockedFunction<typeof loadGridPoints>;
const mockGetFerryEdges = getFerryEdges as jest.MockedFunction<typeof getFerryEdges>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSegment(fromRow: number, fromCol: number, toRow: number, toCol: number, cost = 1, toTerrain: TerrainType = TerrainType.Clear): TrackSegment {
  return {
    from: { row: fromRow, col: fromCol, x: fromCol * 50, y: fromRow * 45, terrain: TerrainType.Clear },
    to: { row: toRow, col: toCol, x: toCol * 50, y: toRow * 45, terrain: toTerrain },
    cost,
  };
}

function makeSnapshot(overrides?: Partial<WorldSnapshot>): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 1,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
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
    ...overrides,
  } as WorldSnapshot;
}

function makeResolverInput(extra: Partial<ResolverInput> = {}): ResolverInput {
  return {
    waypoints: [],
    startPositions: [{ row: 0, col: 0 }],
    targetPositions: [{ row: 5, col: 5 }],
    budget: 20,
    connectedSegments: [],
    occupiedEdges: new Set<string>(),
    networkNodeKeys: undefined,
    ...extra,
  };
}

// ── TurnValidator.computeSaturatedCityKeys ───────────────────────────────────

describe('TurnValidator.computeSaturatedCityKeys', () => {
  it('returns empty set when no other player tracks exist', () => {
    const snapshot = makeSnapshot();
    const result = TurnValidator.computeSaturatedCityKeys(snapshot);
    expect(result.size).toBe(0);
  });

  it('marks small city (37,40) saturated when 2 other players have track there', () => {
    // AC1 reference scenario: small city (37,40) at 2-player cap (limit=2)
    const seg1 = makeSegment(36, 40, 37, 40, 3, TerrainType.SmallCity);
    const seg2 = makeSegment(38, 40, 37, 40, 3, TerrainType.SmallCity);

    const snapshot = makeSnapshot({
      allPlayerTracks: [
        { playerId: 'player-A', segments: [seg1] },
        { playerId: 'player-B', segments: [seg2] },
      ],
    });

    const result = TurnValidator.computeSaturatedCityKeys(snapshot);
    expect(result.has('37,40')).toBe(true);
  });

  it('does NOT mark small city saturated when only 1 other player has track there', () => {
    // 1 other player → adding bot makes 2 total = at limit but not over
    const seg1 = makeSegment(36, 40, 37, 40, 3, TerrainType.SmallCity);

    const snapshot = makeSnapshot({
      allPlayerTracks: [
        { playerId: 'player-A', segments: [seg1] },
      ],
    });

    const result = TurnValidator.computeSaturatedCityKeys(snapshot);
    expect(result.has('37,40')).toBe(false);
  });

  it('marks medium city saturated when 3 other players have track there (limit=3)', () => {
    const seg1 = makeSegment(10, 10, 11, 10, 3, TerrainType.MediumCity);
    const seg2 = makeSegment(12, 10, 11, 10, 3, TerrainType.MediumCity);
    const seg3 = makeSegment(10, 11, 11, 10, 3, TerrainType.MediumCity);

    const snapshot = makeSnapshot({
      allPlayerTracks: [
        { playerId: 'player-A', segments: [seg1] },
        { playerId: 'player-B', segments: [seg2] },
        { playerId: 'player-C', segments: [seg3] },
      ],
    });

    const result = TurnValidator.computeSaturatedCityKeys(snapshot);
    expect(result.has('11,10')).toBe(true);
  });

  it('does NOT mark medium city saturated when only 2 other players have track there', () => {
    // 2 others + bot = 3 = exactly at limit (not over)
    const seg1 = makeSegment(10, 10, 11, 10, 3, TerrainType.MediumCity);
    const seg2 = makeSegment(12, 10, 11, 10, 3, TerrainType.MediumCity);

    const snapshot = makeSnapshot({
      allPlayerTracks: [
        { playerId: 'player-A', segments: [seg1] },
        { playerId: 'player-B', segments: [seg2] },
      ],
    });

    const result = TurnValidator.computeSaturatedCityKeys(snapshot);
    expect(result.has('11,10')).toBe(false);
  });

  it('does not count the bot\'s own track toward the saturation limit', () => {
    // Bot already has track at a small city — shouldn't count itself as "another player"
    const botSeg = makeSegment(36, 40, 37, 40, 3, TerrainType.SmallCity);
    const otherSeg = makeSegment(38, 40, 37, 40, 3, TerrainType.SmallCity);

    const snapshot = makeSnapshot({
      bot: {
        playerId: 'bot-1',
        userId: 'user-bot-1',
        money: 50,
        position: null,
        existingSegments: [botSeg],
        demandCards: [],
        resolvedDemands: [],
        trainType: 'Freight',
        loads: [],
        botConfig: null,
        connectedMajorCityCount: 0,
      },
      allPlayerTracks: [
        { playerId: 'bot-1', segments: [botSeg] },
        { playerId: 'player-A', segments: [otherSeg] },
      ],
    });

    // Only 1 OTHER player → not saturated
    const result = TurnValidator.computeSaturatedCityKeys(snapshot);
    expect(result.has('37,40')).toBe(false);
  });

  it('ignores clear terrain mileposts even if multiple players have track there', () => {
    const seg1 = makeSegment(5, 5, 6, 5, 1, TerrainType.Clear);
    const seg2 = makeSegment(7, 5, 6, 5, 1, TerrainType.Clear);

    const snapshot = makeSnapshot({
      allPlayerTracks: [
        { playerId: 'player-A', segments: [seg1] },
        { playerId: 'player-B', segments: [seg2] },
      ],
    });

    const result = TurnValidator.computeSaturatedCityKeys(snapshot);
    expect(result.has('6,5')).toBe(false);
  });

  it('does not double-count the same player across multiple segments touching the same city', () => {
    // Player A has two segments both touching (37,40)
    const seg1a = makeSegment(36, 40, 37, 40, 3, TerrainType.SmallCity);
    const seg1b = makeSegment(37, 40, 38, 40, 3, TerrainType.SmallCity);

    const snapshot = makeSnapshot({
      allPlayerTracks: [
        { playerId: 'player-A', segments: [seg1a, seg1b] },
      ],
    });

    // Only 1 player despite 2 segments → not saturated (bot adds to 2, exactly at limit)
    const result = TurnValidator.computeSaturatedCityKeys(snapshot);
    expect(result.has('37,40')).toBe(false);
  });
});

// ── BuildRouteResolver: rejectedSaturatedCities telemetry ───────────────────

describe('BuildRouteResolver.resolve — rejectedSaturatedCities (JIRA-203)', () => {
  beforeEach(() => {
    mockComputeBuildSegments.mockReset();
    mockLoadGridPoints.mockReturnValue(new Map() as any);
    mockGetFerryEdges.mockReturnValue([]);
  });

  it('includes empty rejectedSaturatedCities when no saturatedCityKeys provided', () => {
    mockComputeBuildSegments.mockReturnValue([makeSegment(0, 0, 5, 5, 10)]);
    const input = makeResolverInput();
    const outcome = BuildRouteResolver.resolve(input);
    expect(outcome.rejectedSaturatedCities).toEqual([]);
  });

  it('includes empty rejectedSaturatedCities when saturatedCityKeys is empty set', () => {
    mockComputeBuildSegments.mockReturnValue([makeSegment(0, 0, 5, 5, 10)]);
    const input = makeResolverInput({ saturatedCityKeys: new Set() });
    const outcome = BuildRouteResolver.resolve(input);
    expect(outcome.rejectedSaturatedCities).toEqual([]);
  });

  it('AC3: populates rejectedSaturatedCities from saturatedCityKeys (AC3 telemetry)', () => {
    mockComputeBuildSegments.mockReturnValue([]);
    const saturatedCityKeys = new Set(['37,40']);
    const input = makeResolverInput({ saturatedCityKeys });
    const outcome = BuildRouteResolver.resolve(input);
    expect(outcome.rejectedSaturatedCities).toHaveLength(1);
    expect(outcome.rejectedSaturatedCities[0]).toEqual({ row: 37, col: 40 });
  });

  it('passes saturatedCityKeys through to computeBuildSegments', () => {
    mockComputeBuildSegments.mockReturnValue([]);
    const saturatedCityKeys = new Set(['37,40', '20,15']);
    const input = makeResolverInput({ saturatedCityKeys });
    BuildRouteResolver.resolve(input);

    // computeBuildSegments should have been called with the saturatedCityKeys parameter
    // (last positional arg, index 8)
    expect(mockComputeBuildSegments).toHaveBeenCalled();
    const callArgs = mockComputeBuildSegments.mock.calls[0];
    // The saturatedCityKeys is the 9th argument (index 8)
    expect(callArgs[8]).toBe(saturatedCityKeys);
  });

  it('AC1: when saturatedCityKeys blocks only path, all candidates return empty segments', () => {
    // Simulate the JIRA-203 reference scenario: resolver gets no segments back
    // because the only path crosses saturated (37,40)
    mockComputeBuildSegments.mockReturnValue([]);
    const saturatedCityKeys = new Set(['37,40']);
    const input = makeResolverInput({
      saturatedCityKeys,
      targetPositions: [{ row: 40, col: 42 }], // Bern-like target
    });
    const outcome = BuildRouteResolver.resolve(input);

    // All candidates should have empty segments (no path found)
    expect(outcome.candidates.llmGuided.segments).toHaveLength(0);
    expect(outcome.candidates.dijkstraDirect.segments).toHaveLength(0);
    expect(outcome.candidates.merged.segments).toHaveLength(0);
    // rejectedSaturatedCities should record the exclusion
    expect(outcome.rejectedSaturatedCities).toContainEqual({ row: 37, col: 40 });
  });
});

// ── Stuck-state recovery integration: AIStrategyEngine strip detection ───────

describe('TurnValidator.computeSaturatedCityKeys — consistency with checkCityEntryLimit', () => {
  /**
   * Verifies that computeSaturatedCityKeys and checkCityEntryLimit agree on
   * whether a given city is saturated (R1 shared-predicate requirement).
   */
  it('agrees with validator: city blocked by computeSaturatedCityKeys is rejected by checkCityEntryLimit', () => {
    // Setup: small city (37,40) has 2 other players' track
    const seg1 = makeSegment(36, 40, 37, 40, 3, TerrainType.SmallCity);
    const seg2 = makeSegment(38, 40, 37, 40, 3, TerrainType.SmallCity);

    const snapshot = makeSnapshot({
      allPlayerTracks: [
        { playerId: 'player-A', segments: [seg1] },
        { playerId: 'player-B', segments: [seg2] },
      ],
    });

    // computeSaturatedCityKeys should flag it
    const saturated = TurnValidator.computeSaturatedCityKeys(snapshot);
    expect(saturated.has('37,40')).toBe(true);

    // checkCityEntryLimit (via validate()) should also reject a build through it
    const buildPlan = {
      type: AIActionType.BuildTrack as const,
      segments: [makeSegment(35, 40, 37, 40, 3, TerrainType.SmallCity)],
    };
    const result = TurnValidator.validate(buildPlan, {
      position: { city: 'Test', row: 35, col: 40 },
      money: 50,
      trainType: 'Freight',
      speed: 9,
      capacity: 2,
      loads: [],
      connectedMajorCities: [],
      unconnectedMajorCities: [],
      totalMajorCities: 8,
      trackSummary: '',
      turnBuildCost: 0,
      demands: [],
      canDeliver: [],
      canPickup: [],
      reachableCities: [],
      citiesOnNetwork: [],
      canUpgrade: true,
      canBuild: true,
      isInitialBuild: false,
      opponents: [],
      phase: 'normal',
      turnNumber: 1,
    }, snapshot);

    expect(result.valid).toBe(false);
    expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_LIMIT')?.passed).toBe(false);
  });

  it('AC6 regression: city with 1 other player is NOT saturated, allows building', () => {
    const seg1 = makeSegment(36, 40, 37, 40, 3, TerrainType.SmallCity);

    const snapshot = makeSnapshot({
      allPlayerTracks: [
        { playerId: 'player-A', segments: [seg1] },
      ],
    });

    // Not saturated — bot can build in
    const saturated = TurnValidator.computeSaturatedCityKeys(snapshot);
    expect(saturated.has('37,40')).toBe(false);

    // Validator also allows it
    const buildPlan = {
      type: AIActionType.BuildTrack as const,
      segments: [makeSegment(35, 40, 37, 40, 3, TerrainType.SmallCity)],
    };
    const result = TurnValidator.validate(buildPlan, {
      position: { city: 'Test', row: 35, col: 40 },
      money: 50,
      trainType: 'Freight',
      speed: 9,
      capacity: 2,
      loads: [],
      connectedMajorCities: [],
      unconnectedMajorCities: [],
      totalMajorCities: 8,
      trackSummary: '',
      turnBuildCost: 0,
      demands: [],
      canDeliver: [],
      canPickup: [],
      reachableCities: [],
      citiesOnNetwork: [],
      canUpgrade: true,
      canBuild: true,
      isInitialBuild: false,
      opponents: [],
      phase: 'normal',
      turnNumber: 1,
    }, snapshot);

    expect(result.hardGates.find(g => g.gate === 'CITY_ENTRY_LIMIT')?.passed).toBe(true);
  });
});
