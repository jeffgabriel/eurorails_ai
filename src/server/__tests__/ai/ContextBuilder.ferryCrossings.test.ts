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
  loadGridPoints: jest.fn().mockReturnValue(new Map()),
  estimateHopDistance: jest.fn().mockReturnValue(0),
  estimatePathCost: jest.fn().mockReturnValue(0),
  computeLandmass: jest.fn().mockReturnValue(new Set()),
  computeFerryRouteInfo: jest.fn().mockReturnValue({}),
  makeKey: jest.fn((...args: unknown[]) => args.join(',')),
}));

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

// ── City grid points ───────────────────────────────────────────────────────
// Region classification is by city NAME, not coordinates, so positions are arbitrary.

// Continent cities
const paris = makeCityPoint(30, 10, 'Paris', TerrainType.MajorCity);
const berlin = makeCityPoint(28, 30, 'Berlin', TerrainType.MajorCity);
const beograd = makeCityPoint(48, 62, 'Beograd', TerrainType.MajorCity);
const hamburg = makeCityPoint(20, 47, 'Hamburg', TerrainType.MajorCity);
const stuttgart = makeCityPoint(32, 44, 'Stuttgart', TerrainType.MajorCity);
const porto = makeCityPoint(41, 7, 'Porto', TerrainType.MajorCity);

// Britain cities
const london = makeCityPoint(6, 12, 'London', TerrainType.MajorCity);

// Ireland cities
const dublin = makeCityPoint(3, 5, 'Dublin', TerrainType.MajorCity);
const belfast = makeCityPoint(2, 4, 'Belfast', TerrainType.MajorCity);

const defaultGridPoints: GridPoint[] = [
  paris, berlin, beograd, hamburg, stuttgart, porto, london, dublin, belfast,
];

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
  });

  it('returns 0 when supplyCity is null', () => {
    const result = countFerryCrossings(null, 'Berlin', defaultGridPoints);
    expect(result).toBe(0);
  });

  it('returns 0 for same-region cities (both on continent)', () => {
    const result = countFerryCrossings('Paris', 'Berlin', defaultGridPoints);
    expect(result).toBe(0);
  });

  it('returns 1 for continent → Britain (Channel crossing)', () => {
    const result = countFerryCrossings('Paris', 'London', defaultGridPoints);
    expect(result).toBe(1);
  });

  it('returns 1 for Britain → Ireland Dublin (Irish Sea crossing)', () => {
    const result = countFerryCrossings('London', 'Dublin', defaultGridPoints);
    expect(result).toBe(1);
  });

  it('returns 2 for continent → Belfast (Channel + Irish Sea)', () => {
    const result = countFerryCrossings('Paris', 'Belfast', defaultGridPoints);
    expect(result).toBe(2);
  });

  // ── Regression tests for false-positive routes ──────────────────────────

  it('returns 0 for Beograd → Hamburg (both on continent, was false positive)', () => {
    const result = countFerryCrossings('Beograd', 'Hamburg', defaultGridPoints);
    expect(result).toBe(0);
  });

  it('returns 0 for Stuttgart → Porto (both on continent, was false positive)', () => {
    const result = countFerryCrossings('Stuttgart', 'Porto', defaultGridPoints);
    expect(result).toBe(0);
  });
});

describe('ContextBuilder.isFerryOnRoute', () => {
  const isFerryOnRoute = (
    supplyCity: string | null,
    deliveryCity: string,
    gridPoints: GridPoint[],
  ): boolean =>
    (ContextBuilder as any).isFerryOnRoute(supplyCity, deliveryCity, gridPoints);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns false when supplyCity is null', () => {
    const result = isFerryOnRoute(null, 'Berlin', defaultGridPoints);
    expect(result).toBe(false);
  });

  it('returns true when delivery city is a ferry port', () => {
    const ferryPortCity = makeCityPoint(10, 10, 'FerryTown', TerrainType.FerryPort);
    const result = isFerryOnRoute('Paris', 'FerryTown', [...defaultGridPoints, ferryPortCity]);
    expect(result).toBe(true);
  });

  it('returns false for Beograd → Hamburg (both continent, was false positive)', () => {
    const result = isFerryOnRoute('Beograd', 'Hamburg', defaultGridPoints);
    expect(result).toBe(false);
  });

  it('returns false for Stuttgart → Porto (both continent, was false positive)', () => {
    const result = isFerryOnRoute('Stuttgart', 'Porto', defaultGridPoints);
    expect(result).toBe(false);
  });

  it('returns false for Paris → Berlin (both continent)', () => {
    const result = isFerryOnRoute('Paris', 'Berlin', defaultGridPoints);
    expect(result).toBe(false);
  });

  it('returns true for London → Paris (Channel crossing)', () => {
    const result = isFerryOnRoute('London', 'Paris', defaultGridPoints);
    expect(result).toBe(true);
  });

  it('returns true for Dublin → London (Irish Sea crossing)', () => {
    const result = isFerryOnRoute('Dublin', 'London', defaultGridPoints);
    expect(result).toBe(true);
  });

  it('returns true for Belfast → Paris (crosses both barriers)', () => {
    const result = isFerryOnRoute('Belfast', 'Paris', defaultGridPoints);
    expect(result).toBe(true);
  });
});
