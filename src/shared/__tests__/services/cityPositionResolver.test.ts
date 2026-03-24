import { getCityNameAtPosition, isPositionAtCity } from '../../services/cityPositionResolver';
import { getMajorCityLookup } from '../../services/majorCityGroups';

// Mock majorCityGroups to control test data without loading real mileposts
jest.mock('../../services/majorCityGroups', () => ({
  getMajorCityLookup: jest.fn(),
}));

const mockGetMajorCityLookup = getMajorCityLookup as jest.MockedFunction<typeof getMajorCityLookup>;

describe('cityPositionResolver', () => {
  let majorCityLookup: Map<string, string>;
  let gridPoints: Map<string, { name?: string }>;

  beforeEach(() => {
    // Major city: Berlin with center at (10,20) and outpost at (10,21)
    majorCityLookup = new Map([
      ['10,20', 'Berlin'],
      ['10,21', 'Berlin'],
      ['30,40', 'Paris'],
    ]);
    mockGetMajorCityLookup.mockReturnValue(majorCityLookup);

    // Grid points with small/medium cities and plain terrain
    gridPoints = new Map([
      ['5,5', { name: 'Kiel' }],         // Small city
      ['7,8', { name: 'Braunschweig' }], // Medium city
      ['15,15', {}],                       // Clear terrain (no name)
      ['10,20', { name: 'Berlin' }],      // Also in major city lookup
    ]);
  });

  describe('getCityNameAtPosition', () => {
    it('returns major city name for center milepost', () => {
      expect(getCityNameAtPosition(10, 20, gridPoints)).toBe('Berlin');
    });

    it('returns major city name for outpost milepost', () => {
      expect(getCityNameAtPosition(10, 21, gridPoints)).toBe('Berlin');
    });

    it('returns major city name even if gridPoints also has a name', () => {
      // Major city lookup takes precedence
      expect(getCityNameAtPosition(10, 20, gridPoints)).toBe('Berlin');
    });

    it('returns small/medium city name from gridPoints', () => {
      expect(getCityNameAtPosition(5, 5, gridPoints)).toBe('Kiel');
    });

    it('returns medium city name from gridPoints', () => {
      expect(getCityNameAtPosition(7, 8, gridPoints)).toBe('Braunschweig');
    });

    it('returns null for clear terrain (no name in gridPoints)', () => {
      expect(getCityNameAtPosition(15, 15, gridPoints)).toBeNull();
    });

    it('returns null for position not in any map', () => {
      expect(getCityNameAtPosition(99, 99, gridPoints)).toBeNull();
    });
  });

  describe('isPositionAtCity', () => {
    it('returns true for major city center', () => {
      expect(isPositionAtCity(10, 20, 'Berlin', gridPoints)).toBe(true);
    });

    it('returns true for major city outpost', () => {
      expect(isPositionAtCity(10, 21, 'Berlin', gridPoints)).toBe(true);
    });

    it('returns false for wrong city name at major city position', () => {
      expect(isPositionAtCity(10, 20, 'Paris', gridPoints)).toBe(false);
    });

    it('returns true for small/medium city', () => {
      expect(isPositionAtCity(5, 5, 'Kiel', gridPoints)).toBe(true);
    });

    it('returns false for wrong city name at small city position', () => {
      expect(isPositionAtCity(5, 5, 'Berlin', gridPoints)).toBe(false);
    });

    it('returns false for position not at any city', () => {
      expect(isPositionAtCity(99, 99, 'Berlin', gridPoints)).toBe(false);
    });

    it('returns false for clear terrain', () => {
      expect(isPositionAtCity(15, 15, 'Berlin', gridPoints)).toBe(false);
    });
  });
});
