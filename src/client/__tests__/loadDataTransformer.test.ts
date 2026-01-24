import {
  parseResourceData,
  transformToCityData,
  LoadConfiguration,
  ResourceTableEntry
} from '../utils/loadDataTransformer';

describe('loadDataTransformer', () => {
  describe('parseResourceData', () => {
    it('should parse resource data with correct fields', () => {
      const config: LoadConfiguration = {
        LoadConfiguration: [
          { Bauxite: ['Budapest', 'Marseille'], count: 3 }
        ]
      };

      const result = parseResourceData(config);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'Bauxite',
        cities: ['Budapest', 'Marseille'],
        count: 3,
        iconKey: 'load-bauxite'
      });
    });

    it('should sort resources alphabetically by name', () => {
      const config: LoadConfiguration = {
        LoadConfiguration: [
          { Zinc: ['Vienna'], count: 2 },
          { Bauxite: ['Budapest'], count: 3 },
          { Coal: ['London'], count: 4 }
        ]
      };

      const result = parseResourceData(config);

      expect(result.map(r => r.name)).toEqual(['Bauxite', 'Coal', 'Zinc']);
    });

    it('should handle empty configuration', () => {
      const config: LoadConfiguration = { LoadConfiguration: [] };
      const result = parseResourceData(config);
      expect(result).toEqual([]);
    });

    it('should handle null/undefined configuration', () => {
      expect(parseResourceData(null as any)).toEqual([]);
      expect(parseResourceData(undefined as any)).toEqual([]);
      expect(parseResourceData({} as any)).toEqual([]);
    });

    it('should skip entries without valid resource key', () => {
      const config: LoadConfiguration = {
        LoadConfiguration: [
          { count: 3 } as any,  // No resource key
          { Bauxite: ['Budapest'], count: 3 }
        ]
      };

      const result = parseResourceData(config);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Bauxite');
    });

    it('should skip entries where cities is not an array', () => {
      const config: LoadConfiguration = {
        LoadConfiguration: [
          { Bauxite: 'not-an-array' as any, count: 3 },
          { Coal: ['London'], count: 4 }
        ]
      };

      const result = parseResourceData(config);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Coal');
    });

    it('should handle missing count field', () => {
      const config: LoadConfiguration = {
        LoadConfiguration: [
          { Bauxite: ['Budapest'] } as any
        ]
      };

      const result = parseResourceData(config);

      expect(result[0].count).toBe(0);
    });

    it('should generate correct iconKey from resource name', () => {
      const config: LoadConfiguration = {
        LoadConfiguration: [
          { 'Machine Parts': ['Berlin'], count: 2 }
        ]
      };

      const result = parseResourceData(config);

      expect(result[0].iconKey).toBe('load-machine parts');
    });
  });

  describe('transformToCityData', () => {
    it('should aggregate resources by city', () => {
      const resources: ResourceTableEntry[] = [
        { name: 'Bauxite', cities: ['Budapest', 'Vienna'], count: 3, iconKey: 'loads/Bauxite' },
        { name: 'Beer', cities: ['Budapest'], count: 4, iconKey: 'loads/Beer' }
      ];

      const result = transformToCityData(resources);

      const budapest = result.find(c => c.name === 'Budapest');
      expect(budapest).toBeDefined();
      expect(budapest!.resources).toContain('Bauxite');
      expect(budapest!.resources).toContain('Beer');
      expect(budapest!.resources).toHaveLength(2);

      const vienna = result.find(c => c.name === 'Vienna');
      expect(vienna).toBeDefined();
      expect(vienna!.resources).toEqual(['Bauxite']);
    });

    it('should sort cities alphabetically by name', () => {
      const resources: ResourceTableEntry[] = [
        { name: 'Bauxite', cities: ['Vienna', 'Budapest', 'Athens'], count: 3, iconKey: '' }
      ];

      const result = transformToCityData(resources);

      expect(result.map(c => c.name)).toEqual(['Athens', 'Budapest', 'Vienna']);
    });

    it('should sort resources alphabetically within each city', () => {
      const resources: ResourceTableEntry[] = [
        { name: 'Zinc', cities: ['Budapest'], count: 2, iconKey: '' },
        { name: 'Bauxite', cities: ['Budapest'], count: 3, iconKey: '' },
        { name: 'Coal', cities: ['Budapest'], count: 4, iconKey: '' }
      ];

      const result = transformToCityData(resources);

      expect(result[0].resources).toEqual(['Bauxite', 'Coal', 'Zinc']);
    });

    it('should handle empty resources array', () => {
      const result = transformToCityData([]);
      expect(result).toEqual([]);
    });

    it('should handle null/undefined input', () => {
      expect(transformToCityData(null as any)).toEqual([]);
      expect(transformToCityData(undefined as any)).toEqual([]);
    });

    it('should skip resources with invalid cities array', () => {
      const resources: ResourceTableEntry[] = [
        { name: 'Bauxite', cities: null as any, count: 3, iconKey: '' },
        { name: 'Coal', cities: ['London'], count: 4, iconKey: '' }
      ];

      const result = transformToCityData(resources);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('London');
    });
  });

  describe('integration', () => {
    it('should correctly transform sample load_cities.json structure', () => {
      // Sample data matching real structure
      const config: LoadConfiguration = {
        LoadConfiguration: [
          { Bauxite: ['Budapest', 'Marseille'], count: 3 },
          { Beer: ['Dublin', 'Frankfurt', 'Munchen', 'Praha'], count: 4 },
          { Cars: ['Manchester', 'Munchen', 'Stuttgart', 'Torino'], count: 3 }
        ]
      };

      const resources = parseResourceData(config);
      const cities = transformToCityData(resources);

      // Verify resources
      expect(resources).toHaveLength(3);
      expect(resources[0].name).toBe('Bauxite'); // Sorted first
      expect(resources[1].name).toBe('Beer');
      expect(resources[2].name).toBe('Cars');

      // Verify cities
      const munchen = cities.find(c => c.name === 'Munchen');
      expect(munchen).toBeDefined();
      expect(munchen!.resources).toContain('Beer');
      expect(munchen!.resources).toContain('Cars');
      expect(munchen!.resources).toHaveLength(2);
    });
  });
});
