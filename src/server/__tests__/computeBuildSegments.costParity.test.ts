import { TrackSegment } from '../../shared/types/GameTypes';
import { computeBuildSegments } from '../services/ai/computeBuildSegments';
import { loadGridPoints, _resetCache, GridCoord } from '../services/MapTopology';
import { getMajorCityGroups, getMajorCityLookup, getFerryEdges } from '../../shared/services/majorCityGroups';
import { getTerrainBuildCost } from '../../shared/config/terrainCosts';
import { getWaterCrossingExtraCost } from '../../shared/config/waterCrossings';

/**
 * Parity test for issue #307 (shared track-cost module, no behaviour change).
 *
 * `legacyBotSegmentCost` is the formula computeBuildSegments.buildSegment used
 * before the refactor: (ferry cost if the destination is a ferry port, else
 * destination terrain cost) + water-crossing surcharge. Every segment the bot
 * builder returns on the real map must still carry exactly that cost.
 */
describe('computeBuildSegments segment cost parity with pre-#307 formula', () => {
  beforeEach(() => _resetCache());

  const ferryPortCosts = new Map<string, number>();
  for (const ferry of getFerryEdges()) {
    ferryPortCosts.set(`${ferry.pointA.row},${ferry.pointA.col}`, ferry.cost);
    ferryPortCosts.set(`${ferry.pointB.row},${ferry.pointB.col}`, ferry.cost);
  }

  function legacyBotSegmentCost(from: GridCoord, to: GridCoord): number {
    const toData = loadGridPoints().get(`${to.row},${to.col}`)!;
    const baseCost = ferryPortCosts.get(`${to.row},${to.col}`) ?? getTerrainBuildCost(toData.terrain);
    return baseCost + getWaterCrossingExtraCost(from, to);
  }

  const built: TrackSegment[] = [];

  function expectParity(segments: TrackSegment[]): void {
    const mismatches: string[] = [];
    for (const seg of segments) {
      const expected = legacyBotSegmentCost(seg.from, seg.to);
      if (seg.cost !== expected) {
        mismatches.push(
          `(${seg.from.row},${seg.from.col})->(${seg.to.row},${seg.to.col}): legacy ${expected}, now ${seg.cost}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
    built.push(...segments);
  }

  const groups = getMajorCityGroups();

  it('untargeted builds from every major city', () => {
    for (const group of groups) {
      expectParity(computeBuildSegments([group.center], [], 20));
    }
  });

  it('targeted builds between major cities', () => {
    for (let i = 0; i < groups.length; i++) {
      const target = groups[(i + 1) % groups.length].center;
      expectParity(computeBuildSegments([groups[i].center], [], 200, 200, undefined, [target]));
    }
  });

  it('targeted builds to every ferry port from every major city', () => {
    for (const ferry of getFerryEdges()) {
      for (const port of [ferry.pointA, ferry.pointB]) {
        for (const group of groups) {
          expectParity(computeBuildSegments([group.center], [], 300, 300, undefined, [port]));
        }
      }
    }
  });

  it('continuation builds into a ferry port and a major city the bot already touches', () => {
    for (const ferry of getFerryEdges()) {
      for (const group of groups.slice(0, 3)) {
        const first = computeBuildSegments([group.center], [], 300, 300, undefined, [ferry.pointA]);
        expectParity(first);
        if (first.length === 0) continue;
        // Build again with that track in place, toward the far port and back to the start city.
        expectParity(computeBuildSegments([], first, 300, 300, undefined, [ferry.pointB]));
        expectParity(computeBuildSegments([], first, 300, 300, undefined, [group.outposts[0]]));
      }
    }
  });

  it('exercised ferry-port, major-city and water-crossing segments', () => {
    const majorCityLookup = getMajorCityLookup();
    const toKeys = built.map(seg => `${seg.to.row},${seg.to.col}`);
    expect(built.length).toBeGreaterThan(500);
    expect(toKeys.some(key => ferryPortCosts.has(key))).toBe(true);
    expect(toKeys.some(key => majorCityLookup.has(key))).toBe(true);
    expect(built.some(seg => getWaterCrossingExtraCost(seg.from, seg.to) === 2)).toBe(true);
    expect(built.some(seg => getWaterCrossingExtraCost(seg.from, seg.to) === 3)).toBe(true);
  });
});
