import { ContextBuilder } from '../../services/ai/ContextBuilder';
import {
  GridPoint, TerrainType,
} from '../../../shared/types/GameTypes';

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getFerryEdges: jest.fn(),
  getMajorCityGroups: jest.fn().mockReturnValue([]),
  getMajorCityLookup: jest.fn().mockReturnValue(new Map()),
  computeEffectivePathLength: jest.fn().mockReturnValue(0),
}));

jest.mock('../../services/ai/MapTopology', () => ({
  hexDistance: jest.fn(),
  loadGridPoints: jest.fn().mockReturnValue([]),
  estimateHopDistance: jest.fn().mockReturnValue(0),
  estimatePathCost: jest.fn().mockReturnValue(0),
  computeLandmass: jest.fn().mockReturnValue(new Map()),
  computeFerryRouteInfo: jest.fn().mockReturnValue({}),
  makeKey: jest.fn((...args: unknown[]) => args.join(',')),
}));

import { getFerryEdges } from '../../../shared/services/majorCityGroups';
import { hexDistance } from '../../services/ai/MapTopology';

const mockedGetFerryEdges = getFerryEdges as jest.MockedFunction<typeof getFerryEdges>;
const mockedHexDistance = hexDistance as jest.MockedFunction<typeof hexDistance>;

// ── Helper factories ───────────────────────────────────────────────────────

/** Create a minimal GridPoint at a given row/col */
function makeGridPoint(
  row: number,
  col: number,
  overrides?: Partial<GridPoint>,
): GridPoint {
  return {
    id: `gp-${row}-${col}`,
    x: col * 40,
    y: row * 40,
    row,
    col,
    terrain: TerrainType.Clear,
    city: undefined,
    ...overrides,
  };
}

/** Create a GridPoint with a city */
function makeCityPoint(
  row: number,
  col: number,
  name: string,
  terrain: TerrainType = TerrainType.SmallCity,
  availableLoads: string[] = [],
): GridPoint {
  return makeGridPoint(row, col, {
    terrain,
    city: { type: terrain, name, availableLoads },
  });
}

// ── Ferry edge fixtures ────────────────────────────────────────────────────

// Channel ferries: Britain side (low rows) ↔ Continent side (high rows)
const CHANNEL_FERRY_EDGES = [
  { name: 'Plymouth_Cherbourg', pointA: { row: 8, col: 5 }, pointB: { row: 25, col: 6 }, cost: 8 },
  { name: 'Portsmouth_LeHavre', pointA: { row: 7, col: 10 }, pointB: { row: 26, col: 11 }, cost: 8 },
  { name: 'Dover_Calais', pointA: { row: 6, col: 15 }, pointB: { row: 27, col: 16 }, cost: 6 },
  { name: 'Harwich_Ijmuiden', pointA: { row: 5, col: 20 }, pointB: { row: 28, col: 22 }, cost: 8 },
];

// Irish Sea ferries: Ireland side (very low rows) ↔ Britain side (low rows)
const IRISH_SEA_FERRY_EDGES = [
  { name: 'Belfast_Stranraer', pointA: { row: 2, col: 3 }, pointB: { row: 6, col: 8 }, cost: 4 },
  { name: 'Dublin_Liverpool', pointA: { row: 3, col: 4 }, pointB: { row: 7, col: 12 }, cost: 6 },
];

const ALL_BARRIER_FERRIES = [...CHANNEL_FERRY_EDGES, ...IRISH_SEA_FERRY_EDGES];

// ── City grid points ───────────────────────────────────────────────────────

// Continent cities (high rows)
const paris = makeCityPoint(30, 10, 'Paris', TerrainType.MajorCity);
const berlin = makeCityPoint(28, 30, 'Berlin', TerrainType.MajorCity);

// Britain cities (low rows, close to channel ferry pointA endpoints)
const london = makeCityPoint(6, 12, 'London', TerrainType.MajorCity);

// Ireland cities (very low rows, close to Irish Sea ferry pointA endpoints)
const dublin = makeCityPoint(3, 5, 'Dublin', TerrainType.MajorCity);
const belfast = makeCityPoint(2, 4, 'Belfast', TerrainType.MajorCity);

const defaultGridPoints: GridPoint[] = [paris, berlin, london, dublin, belfast];

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ContextBuilder.countFerryCrossings', () => {
  const countFerryCrossings = (
    supplyCity: string | null,
    deliveryCity: string,
    gridPoints: GridPoint[],
  ): number =>
    (ContextBuilder as any).countFerryCrossings(supplyCity, deliveryCity, gridPoints);

  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetFerryEdges.mockReturnValue(ALL_BARRIER_FERRIES);

    // Simple Manhattan-like distance
    mockedHexDistance.mockImplementation(
      (r1: number, c1: number, r2: number, c2: number) =>
        Math.abs(r1 - r2) + Math.abs(c1 - c2),
    );
  });

  it('returns 0 when supplyCity is null', () => {
    const result = countFerryCrossings(null, 'Berlin', defaultGridPoints);
    expect(result).toBe(0);
    expect(mockedGetFerryEdges).not.toHaveBeenCalled();
  });

  it('returns 0 when supply city not found in gridPoints', () => {
    const result = countFerryCrossings('Atlantis', 'Berlin', defaultGridPoints);
    expect(result).toBe(0);
  });

  it('returns 0 when delivery city not found in gridPoints', () => {
    const result = countFerryCrossings('Paris', 'Atlantis', defaultGridPoints);
    expect(result).toBe(0);
  });

  it('returns 0 for same-landmass cities (both on continent)', () => {
    // Paris and Berlin are both on the continent side (high rows),
    // so they are closer to the same ferry endpoints
    const result = countFerryCrossings('Paris', 'Berlin', defaultGridPoints);
    expect(result).toBe(0);
  });

  it('returns 1 for continent → Britain (Channel crossing)', () => {
    // Paris (row 30) is closer to channel ferry pointB (continent side)
    // London (row 6) is closer to channel ferry pointA (Britain side)
    const result = countFerryCrossings('Paris', 'London', defaultGridPoints);
    expect(result).toBe(1);
  });

  it('returns 1 for Britain → Ireland Dublin (Irish Sea crossing)', () => {
    // London (row 6) is closer to Irish Sea ferry pointB (Britain side)
    // Dublin (row 3) is closer to Irish Sea ferry pointA (Ireland side)
    // For channel ferries, both are on the Britain side (low rows → closer to pointA)
    const result = countFerryCrossings('London', 'Dublin', defaultGridPoints);
    expect(result).toBe(1);
  });

  it('returns 2 for continent → Belfast (Channel + Irish Sea)', () => {
    // Paris (row 30) is on the continent → crosses Channel
    // Belfast (row 2) is in Ireland → also crosses Irish Sea
    const result = countFerryCrossings('Paris', 'Belfast', defaultGridPoints);
    expect(result).toBe(2);
  });

  it('returns 0 when getFerryEdges returns empty array', () => {
    mockedGetFerryEdges.mockReturnValue([]);
    const result = countFerryCrossings('Paris', 'London', defaultGridPoints);
    expect(result).toBe(0);
  });
});
