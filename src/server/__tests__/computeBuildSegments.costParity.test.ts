import { TrackSegment } from '../../shared/types/GameTypes';
import { computeBuildSegments } from '../services/ai/computeBuildSegments';
import { loadGridPoints, _resetCache, GridCoord } from '../services/MapTopology';
import { getMajorCityGroups, getMajorCityLookup, getFerryEdges } from '../../shared/services/majorCityGroups';
import { getTerrainBuildCost } from '../../shared/config/terrainCosts';
import { getWaterCrossingExtraCost } from '../../shared/config/waterCrossings';

/**
 * Parity test for issue #307 (shared track-cost module), updated for #308.
 *
 * `expectedBotSegmentCost` is the formula computeBuildSegments.buildSegment
 * used before #307: (ferry cost if the destination is a ferry port, else
 * destination terrain cost) + water-crossing surcharge, with the one change
 * #308 made on purpose: a ferry line is paid for once, so a segment into a
 * ferry port costs nothing (before the water surcharge) when the bot's
 * existing track already touches either port of that line. Every segment the
 * bot builder returns on the real map must carry exactly that cost.
 */
describe('computeBuildSegments segment cost parity with pre-#307 formula', () => {
  beforeEach(() => _resetCache());

  const ferryPortCosts = new Map<string, number>();
  const ferryPartner = new Map<string, string>();
  for (const ferry of getFerryEdges()) {
    const aKey = `${ferry.pointA.row},${ferry.pointA.col}`;
    const bKey = `${ferry.pointB.row},${ferry.pointB.col}`;
    ferryPortCosts.set(aKey, ferry.cost);
    ferryPortCosts.set(bKey, ferry.cost);
    ferryPartner.set(aKey, bKey);
    ferryPartner.set(bKey, aKey);
  }

  function expectedBotSegmentCost(from: GridCoord, to: GridCoord, existing: TrackSegment[]): number {
    const toKey = `${to.row},${to.col}`;
    const toData = loadGridPoints().get(toKey)!;
    const touched = new Set<string>(
      existing.flatMap(seg => [`${seg.from.row},${seg.from.col}`, `${seg.to.row},${seg.to.col}`]),
    );
    const ferryCost = ferryPortCosts.get(toKey);
    const lineAlreadyPaid = touched.has(toKey) || touched.has(ferryPartner.get(toKey) ?? '');
    const baseCost = ferryCost === undefined
      ? getTerrainBuildCost(toData.terrain)
      : (lineAlreadyPaid ? 0 : ferryCost);
    return baseCost + getWaterCrossingExtraCost(from, to);
  }

  const built: TrackSegment[] = [];

  function expectParity(segments: TrackSegment[], existing: TrackSegment[] = []): void {
    const mismatches: string[] = [];
    for (const seg of segments) {
      const expected = expectedBotSegmentCost(seg.from, seg.to, existing);
      if (seg.cost !== expected) {
        mismatches.push(
          `(${seg.from.row},${seg.from.col})->(${seg.to.row},${seg.to.col}): expected ${expected}, got ${seg.cost}`,
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
        expectParity(computeBuildSegments([], first, 300, 300, undefined, [ferry.pointB]), first);
        expectParity(computeBuildSegments([], first, 300, 300, undefined, [group.outposts[0]]), first);
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
