/**
 * JIRA-111: Ferry port name collision regression test.
 *
 * When a FerryPort shares a name with a nearby city (e.g., Newcastle ferry port
 * at (10,33) and Newcastle SmallCity at (9,32)), findCityMilepost must prefer
 * the real city milepost. Pure ferry ports (Dover, Calais) must still be returned.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────
jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  _resetCache: jest.fn(),
}));
jest.mock('../../../shared/services/trackUsageFees', () => ({
  buildUnionTrackGraph: jest.fn(() => ({ adjacency: new Map(), edgeOwners: new Map() })),
  computeTrackUsageForMove: jest.fn(() => ({ feeTotal: 0, ownersUsed: [], ownersPaid: [], isValid: false, path: [] })),
}));
jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(() => []),
}));
// PlanExecutor deleted — no longer needed
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => []),
  getMajorCityLookup: jest.fn(() => new Map()),
  computeEffectivePathLength: jest.fn((path: any[]) => path.length - 1),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { ActionResolver } from '../../services/ai/ActionResolver';
import { loadGridPoints } from '../../services/ai/MapTopology';
import { TerrainType } from '../../../shared/types/GameTypes';

const mockLoadGridPoints = loadGridPoints as jest.Mock;

// Access private static method via bracket notation
const findCityMilepost = (cityName: string, snapshot: any, forBuild = false) =>
  (ActionResolver as any).findCityMilepost(cityName, snapshot, forBuild);

const dummySnapshot = {
  bot: { position: null, existingSegments: [], playerId: 'bot1', trainType: 'Freight' },
  allPlayerTracks: [],
  ferryEdges: [],
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('JIRA-111: findCityMilepost — ferry port name collision', () => {
  it('should return SmallCity milepost and exclude FerryPort when both share same name', () => {
    mockLoadGridPoints.mockReturnValue(new Map([
      ['9,32', { row: 9, col: 32, terrain: TerrainType.SmallCity, name: 'Newcastle' }],
      ['10,33', { row: 10, col: 33, terrain: TerrainType.FerryPort, name: 'Newcastle' }],
    ]));

    const targets = findCityMilepost('Newcastle', dummySnapshot);

    expect(targets).toHaveLength(1);
    expect(targets[0]).toEqual({ row: 9, col: 32 });
  });

  it('should return FerryPort milepost when no regular city exists with that name (Dover)', () => {
    mockLoadGridPoints.mockReturnValue(new Map([
      ['12,46', { row: 12, col: 46, terrain: TerrainType.FerryPort, name: 'Dover' }],
    ]));

    const targets = findCityMilepost('Dover', dummySnapshot);

    expect(targets).toHaveLength(1);
    expect(targets[0]).toEqual({ row: 12, col: 46 });
  });

  it('should return multiple non-ferry mileposts when city has several (regression)', () => {
    mockLoadGridPoints.mockReturnValue(new Map([
      ['5,5', { row: 5, col: 5, terrain: TerrainType.SmallCity, name: 'TestCity' }],
      ['5,6', { row: 5, col: 6, terrain: TerrainType.SmallCity, name: 'TestCity' }],
      ['5,7', { row: 5, col: 7, terrain: TerrainType.FerryPort, name: 'TestCity' }],
    ]));

    const targets = findCityMilepost('TestCity', dummySnapshot);

    expect(targets).toHaveLength(2);
    expect(targets).toContainEqual({ row: 5, col: 5 });
    expect(targets).toContainEqual({ row: 5, col: 6 });
  });
});
