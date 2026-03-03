import {
  createMockMajorCityGroup,
  buildMockMajorCityLookup,
  MOCK_MAJOR_CITY_GROUPS,
  MOCK_MAJOR_CITY_LOOKUP,
} from './test-helpers';

describe('Shared Test Helpers', () => {
  describe('createMockMajorCityGroup', () => {
    it('creates a default Berlin group', () => {
      const group = createMockMajorCityGroup();
      expect(group.cityName).toBe('Berlin');
      expect(group.center).toEqual({ row: 10, col: 10 });
      expect(group.outposts).toHaveLength(4);
    });

    it('accepts overrides', () => {
      const group = createMockMajorCityGroup({
        cityName: 'Paris',
        center: { row: 5, col: 5 },
      });
      expect(group.cityName).toBe('Paris');
      expect(group.center).toEqual({ row: 5, col: 5 });
    });
  });

  describe('buildMockMajorCityLookup', () => {
    it('maps center and outposts to city name', () => {
      const group = createMockMajorCityGroup();
      const lookup = buildMockMajorCityLookup([group]);

      expect(lookup.get('10,10')).toBe('Berlin');
      expect(lookup.get('9,10')).toBe('Berlin');
      expect(lookup.get('11,10')).toBe('Berlin');
      expect(lookup.get('10,9')).toBe('Berlin');
      expect(lookup.get('10,11')).toBe('Berlin');
      expect(lookup.size).toBe(5);
    });

    it('handles multiple cities', () => {
      const lookup = buildMockMajorCityLookup(MOCK_MAJOR_CITY_GROUPS);
      expect(lookup.get('10,10')).toBe('Berlin');
      expect(lookup.get('30,30')).toBe('Vienna');
      expect(lookup.size).toBe(10);
    });
  });

  describe('MOCK_MAJOR_CITY_GROUPS', () => {
    it('contains Berlin and Vienna', () => {
      expect(MOCK_MAJOR_CITY_GROUPS).toHaveLength(2);
      expect(MOCK_MAJOR_CITY_GROUPS[0].cityName).toBe('Berlin');
      expect(MOCK_MAJOR_CITY_GROUPS[1].cityName).toBe('Vienna');
    });
  });

  describe('MOCK_MAJOR_CITY_LOOKUP', () => {
    it('is consistent with MOCK_MAJOR_CITY_GROUPS', () => {
      const expected = buildMockMajorCityLookup(MOCK_MAJOR_CITY_GROUPS);
      expect(MOCK_MAJOR_CITY_LOOKUP).toEqual(expected);
    });
  });
});
