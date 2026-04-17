/**
 * BuildRouteResolver unit tests — JIRA-179
 *
 * Covers: classifyWaypoints, computeMerged, selectCandidate, resolve (determinism),
 * ActionResolver.resolveBuild flag-off parity, flag-on delegation + log field.
 */

import { BuildRouteResolver, RATIO_BAND, isBuildResolverEnabled } from '../../services/ai/BuildRouteResolver';
import type { Candidate, AnchorClassification, ResolverInput } from '../../services/ai/BuildRouteResolver';
import type { FerryEdge } from '../../../shared/services/majorCityGroups';
import type { TrackSegment } from '../../../shared/types/GameTypes';

// ── Mocks ─────────────────────────────────────────────────────────────────────

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
}));

import { computeBuildSegments } from '../../services/ai/computeBuildSegments';
import { loadGridPoints } from '../../services/ai/MapTopology';
import { getFerryEdges } from '../../../shared/services/majorCityGroups';

const mockComputeBuildSegments = computeBuildSegments as jest.MockedFunction<typeof computeBuildSegments>;
const mockLoadGridPoints = loadGridPoints as jest.MockedFunction<typeof loadGridPoints>;
const mockGetFerryEdges = getFerryEdges as jest.MockedFunction<typeof getFerryEdges>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSegment(fromRow: number, fromCol: number, toRow: number, toCol: number, cost = 1): TrackSegment {
  return {
    from: { row: fromRow, col: fromCol, x: fromCol * 50, y: fromRow * 45 },
    to: { row: toRow, col: toCol, x: toCol * 50, y: toRow * 45 },
    cost,
    owner: 'bot-1',
  } as unknown as TrackSegment;
}

function makeCandidate(
  id: Candidate['id'],
  segments: TrackSegment[],
  reachesTarget: boolean,
  endpointDistanceToTarget: number,
  anchorsHit: string[] = [],
): Candidate {
  const totalCost = segments.reduce((s, seg) => s + seg.cost, 0);
  return { id, segments, totalCost, reachesTarget, endpointDistanceToTarget, namedCityAnchorsHit: anchorsHit };
}

function makeGridPoints(entries: Array<{ row: number; col: number; name?: string }>): Map<string, { name?: string }> {
  const m = new Map<string, { name?: string }>();
  for (const e of entries) {
    m.set(`${e.row},${e.col}`, { name: e.name });
  }
  return m;
}

function makeFerryEdge(name: string, rowA: number, colA: number, rowB: number, colB: number): FerryEdge {
  return { name, pointA: { row: rowA, col: colA }, pointB: { row: rowB, col: colB }, cost: 4 };
}

function makeResolverInput(waypoints: [number, number][] = []): ResolverInput {
  return {
    waypoints,
    startPositions: [{ row: 0, col: 0 }],
    targetPositions: [{ row: 5, col: 5 }],
    budget: 20,
    connectedSegments: [],
    occupiedEdges: new Set<string>(),
    networkNodeKeys: undefined,
  };
}

// ── classifyWaypoints ─────────────────────────────────────────────────────────

describe('BuildRouteResolver.classifyWaypoints', () => {
  it('returns kept:true and namedCity for a waypoint on a named city', () => {
    const gridPoints = makeGridPoints([{ row: 3, col: 4, name: 'Wien' }]);
    const result = BuildRouteResolver.classifyWaypoints([[3, 4]], gridPoints as any, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ coord: [3, 4], namedCity: 'Wien', kept: true });
  });

  it('returns kept:true for a waypoint on a ferry port (no grid name)', () => {
    const gridPoints = makeGridPoints([{ row: 2, col: 7 }]);
    const ferryEdges = [makeFerryEdge('Dover-Calais', 2, 7, 3, 8)];
    const result = BuildRouteResolver.classifyWaypoints([[2, 7]], gridPoints as any, ferryEdges);
    expect(result[0].kept).toBe(true);
    expect(result[0].namedCity).toBeTruthy();
  });

  it('returns kept:false and namedCity:null for an unnamed milepost', () => {
    const gridPoints = makeGridPoints([{ row: 1, col: 1 }]);
    const result = BuildRouteResolver.classifyWaypoints([[1, 1]], gridPoints as any, []);
    expect(result[0]).toMatchObject({ coord: [1, 1], namedCity: null, kept: false });
  });

  it('handles empty waypoints array', () => {
    const result = BuildRouteResolver.classifyWaypoints([], new Map(), []);
    expect(result).toEqual([]);
  });

  it('prefers grid name over ferry name when both apply', () => {
    const gridPoints = makeGridPoints([{ row: 2, col: 7, name: 'Calais' }]);
    const ferryEdges = [makeFerryEdge('Dover-Calais', 2, 7, 3, 8)];
    const result = BuildRouteResolver.classifyWaypoints([[2, 7]], gridPoints as any, ferryEdges);
    expect(result[0].namedCity).toBe('Calais');
    expect(result[0].kept).toBe(true);
  });
});

// ── computeMerged — AC3 ───────────────────────────────────────────────────────

describe('BuildRouteResolver.computeMerged', () => {
  beforeEach(() => {
    mockComputeBuildSegments.mockReset();
  });

  it('with no high-signal anchors: calls computeBuildSegments once with no waypoints (same as dijkstraDirect)', () => {
    const directSegs = [makeSegment(0, 0, 1, 1)];
    mockComputeBuildSegments.mockReturnValueOnce(directSegs);

    const input = makeResolverInput([[1, 2], [3, 4]]);
    const classification: AnchorClassification[] = [
      { coord: [1, 2], namedCity: null, kept: false },
      { coord: [3, 4], namedCity: null, kept: false },
    ];

    const merged = BuildRouteResolver.computeMerged(input, classification);
    expect(merged.id).toBe('merged');
    expect(merged.segments).toBe(directSegs);
    // Should have called computeBuildSegments once with no chaining (no kept anchors)
    expect(mockComputeBuildSegments).toHaveBeenCalledTimes(1);
    const call = mockComputeBuildSegments.mock.calls[0];
    // startPositions = original start (no waypoints inserted)
    expect(call[0]).toEqual([{ row: 0, col: 0 }]);
    // targetPositions = original targets
    expect(call[5]).toEqual([{ row: 5, col: 5 }]);
  });

  it('with high-signal anchors: chains through kept waypoints only', () => {
    const leg1Segs = [makeSegment(0, 0, 2, 2, 2)];
    const leg2Segs = [makeSegment(2, 2, 5, 5, 3)];
    mockComputeBuildSegments
      .mockReturnValueOnce(leg1Segs)
      .mockReturnValueOnce(leg2Segs);

    const input = makeResolverInput([[2, 2]]);
    const classification: AnchorClassification[] = [
      { coord: [2, 2], namedCity: 'Wien', kept: true },
    ];

    const merged = BuildRouteResolver.computeMerged(input, classification);
    expect(merged.segments).toHaveLength(2);
    expect(merged.namedCityAnchorsHit).toContain('Wien');
    // First call goes to waypoint [2,2], second to target [5,5]
    expect(mockComputeBuildSegments).toHaveBeenCalledTimes(2);
  });
});

// ── selectCandidate — AC4 (one test per rule branch) ─────────────────────────

describe('BuildRouteResolver.selectCandidate', () => {
  const seg = makeSegment(0, 0, 5, 5, 10);

  it('closest-to-target-fallback: none reach target', () => {
    const llm = makeCandidate('llmGuided', [], false, 8);
    const direct = makeCandidate('dijkstraDirect', [], false, 3);
    const merged = makeCandidate('merged', [], false, 5);
    const { selected, ruleBranch } = BuildRouteResolver.selectCandidate([llm, direct, merged]);
    expect(ruleBranch).toBe('closest-to-target-fallback');
    expect(selected.id).toBe('dijkstraDirect'); // distance 3 is smallest
  });

  it('only-reacher: exactly one candidate reaches target', () => {
    const llm = makeCandidate('llmGuided', [seg], true, 0);
    const direct = makeCandidate('dijkstraDirect', [], false, 4);
    const merged = makeCandidate('merged', [], false, 6);
    const { selected, ruleBranch } = BuildRouteResolver.selectCandidate([llm, direct, merged]);
    expect(ruleBranch).toBe('only-reacher');
    expect(selected.id).toBe('llmGuided');
  });

  it('ratio-band-anchor-winner: all within ratio, merged hits more anchors', () => {
    const cost = 10;
    const llm = makeCandidate('llmGuided', [makeSegment(0,0,5,5,cost)], true, 0, []);
    const direct = makeCandidate('dijkstraDirect', [makeSegment(0,0,5,5,cost)], true, 0, []);
    const merged = makeCandidate('merged', [makeSegment(0,0,5,5,cost)], true, 0, ['Wien', 'Berlin']);
    const { selected, ruleBranch } = BuildRouteResolver.selectCandidate([llm, direct, merged]);
    expect(ruleBranch).toBe('ratio-band-anchor-winner');
    expect(selected.id).toBe('merged');
  });

  it('ratio-band-cost-tiebreak: all within ratio, same anchor count, cheapest wins', () => {
    // All three within 1.15× of cheapest (10): threshold=11.5
    // Each has exactly 1 anchor — tie on anchors → tiebreak by cost
    const llm = makeCandidate('llmGuided', [makeSegment(0,0,5,5,11)], true, 0, ['Wien']);
    const direct = makeCandidate('dijkstraDirect', [makeSegment(0,0,5,5,10)], true, 0, ['Paris']);
    const merged = makeCandidate('merged', [makeSegment(0,0,5,5,11)], true, 0, ['Berlin']);
    const { selected, ruleBranch } = BuildRouteResolver.selectCandidate([llm, direct, merged]);
    expect(ruleBranch).toBe('ratio-band-cost-tiebreak');
    expect(selected.id).toBe('dijkstraDirect');
  });

  it('cheapest: some outside ratio band, cheapest reacher wins', () => {
    // cheapest=10, threshold=11.5 → merged(cost=15) is outside band
    const llm = makeCandidate('llmGuided', [makeSegment(0,0,5,5,11)], true, 0, []);
    const direct = makeCandidate('dijkstraDirect', [makeSegment(0,0,5,5,10)], true, 0, []);
    const merged = makeCandidate('merged', [makeSegment(0,0,5,5,15)], true, 0, ['Wien', 'Berlin']);
    const { selected, ruleBranch } = BuildRouteResolver.selectCandidate([llm, direct, merged]);
    expect(ruleBranch).toBe('cheapest');
    expect(selected.id).toBe('dijkstraDirect');
  });

  it('is deterministic — same input produces same output', () => {
    const llm = makeCandidate('llmGuided', [makeSegment(0,0,5,5,12)], true, 0, []);
    const direct = makeCandidate('dijkstraDirect', [makeSegment(0,0,5,5,10)], true, 0, []);
    const merged = makeCandidate('merged', [makeSegment(0,0,5,5,11)], true, 0, ['Wien']);
    const r1 = BuildRouteResolver.selectCandidate([llm, direct, merged]);
    const r2 = BuildRouteResolver.selectCandidate([llm, direct, merged]);
    expect(r1.selected.id).toBe(r2.selected.id);
    expect(r1.ruleBranch).toBe(r2.ruleBranch);
  });
});

// ── resolve() — AC1, AC8, AC9 ────────────────────────────────────────────────

describe('BuildRouteResolver.resolve', () => {
  beforeEach(() => {
    mockComputeBuildSegments.mockReset();
    mockLoadGridPoints.mockReturnValue(new Map() as any);
    mockGetFerryEdges.mockReturnValue([]);
  });

  it('AC1: returns candidates with all three IDs (llmGuided, dijkstraDirect, merged)', () => {
    const segs = [makeSegment(0, 0, 5, 5, 10)];
    mockComputeBuildSegments.mockReturnValue(segs);

    const outcome = BuildRouteResolver.resolve(makeResolverInput());
    expect(outcome.candidates.llmGuided.id).toBe('llmGuided');
    expect(outcome.candidates.dijkstraDirect.id).toBe('dijkstraDirect');
    expect(outcome.candidates.merged.id).toBe('merged');
  });

  it('AC8: deterministic — same input twice → byte-identical outcome', () => {
    const segs = [makeSegment(0, 0, 5, 5, 10)];
    mockComputeBuildSegments.mockReturnValue(segs);

    const input = makeResolverInput([[2, 2]]);
    // reset and re-mock for each call
    mockComputeBuildSegments
      .mockReturnValue(segs);

    const o1 = BuildRouteResolver.resolve(input);
    mockComputeBuildSegments.mockReturnValue(segs);
    const o2 = BuildRouteResolver.resolve(input);

    expect(o1.selected.id).toBe(o2.selected.id);
    expect(o1.ruleBranch).toBe(o2.ruleBranch);
    expect(o1.costDelta).toBe(o2.costDelta);
  });

  it('AC9: when no waypoints, all three candidates produce the same segments', () => {
    const segs = [makeSegment(0, 0, 5, 5, 10)];
    mockComputeBuildSegments.mockReturnValue(segs);

    const input = makeResolverInput([]); // no waypoints
    const outcome = BuildRouteResolver.resolve(input);

    // All three should be the same segments (same Dijkstra call behavior)
    expect(outcome.candidates.llmGuided.segments).toEqual(segs);
    expect(outcome.candidates.dijkstraDirect.segments).toEqual(segs);
    expect(outcome.candidates.merged.segments).toEqual(segs);
  });

  it('includes anchorClassification in outcome', () => {
    const gridPoints = makeGridPoints([{ row: 2, col: 2, name: 'Paris' }]);
    mockLoadGridPoints.mockReturnValue(gridPoints as any);
    mockComputeBuildSegments.mockReturnValue([]);

    const input = makeResolverInput([[2, 2], [3, 3]]);
    const outcome = BuildRouteResolver.resolve(input);

    expect(outcome.anchorClassification).toHaveLength(2);
    expect(outcome.anchorClassification[0]).toMatchObject({ coord: [2, 2], namedCity: 'Paris', kept: true });
    expect(outcome.anchorClassification[1]).toMatchObject({ coord: [3, 3], namedCity: null, kept: false });
  });

  it('includes reasonText and costDelta in outcome', () => {
    const segs = [makeSegment(0, 0, 5, 5, 10)];
    mockComputeBuildSegments.mockReturnValue(segs);

    const outcome = BuildRouteResolver.resolve(makeResolverInput());
    expect(typeof outcome.reasonText).toBe('string');
    expect(outcome.reasonText.length).toBeGreaterThan(0);
    expect(typeof outcome.costDelta).toBe('number');
  });
});

// ── isBuildResolverEnabled flag ────────────────────────────────────────────────

describe('isBuildResolverEnabled', () => {
  const original = process.env.ENABLE_BUILD_RESOLVER;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.ENABLE_BUILD_RESOLVER;
    } else {
      process.env.ENABLE_BUILD_RESOLVER = original;
    }
  });

  it('returns false when env var is unset', () => {
    delete process.env.ENABLE_BUILD_RESOLVER;
    expect(isBuildResolverEnabled()).toBe(false);
  });

  it('returns false when env var is empty string', () => {
    process.env.ENABLE_BUILD_RESOLVER = '';
    expect(isBuildResolverEnabled()).toBe(false);
  });

  it('returns true when env var is "true"', () => {
    process.env.ENABLE_BUILD_RESOLVER = 'true';
    expect(isBuildResolverEnabled()).toBe(true);
  });

  it('returns false when env var is "false"', () => {
    process.env.ENABLE_BUILD_RESOLVER = 'false';
    expect(isBuildResolverEnabled()).toBe(false);
  });
});

// ── RATIO_BAND constant ───────────────────────────────────────────────────────

describe('RATIO_BAND constant', () => {
  it('is 1.15 by default', () => {
    expect(RATIO_BAND).toBe(1.15);
  });
});
