import {
  transformToCityData,
  ResourceTableEntry
} from '../utils/loadDataTransformer';

describe('loadDataTransformer', () => {
  describe('transformToCityData', () => {
    it('should aggregate resources by city', () => {
      const resources: ResourceTableEntry[] = [
        { name: 'Bauxite', cities: ['Budapest', 'Vienna'], count: 3, iconKey: 'load-bauxite' },
        { name: 'Beer', cities: ['Budapest'], count: 4, iconKey: 'load-beer' }
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
        { name: 'Bauxite', cities: ['Vienna', 'Budapest', 'Athens'], count: 3, iconKey: 'load-bauxite' }
      ];

      const result = transformToCityData(resources);

      expect(result.map(c => c.name)).toEqual(['Athens', 'Budapest', 'Vienna']);
    });

    it('should sort resources alphabetically within each city', () => {
      const resources: ResourceTableEntry[] = [
        { name: 'Zinc', cities: ['Budapest'], count: 2, iconKey: 'load-zinc' },
        { name: 'Bauxite', cities: ['Budapest'], count: 3, iconKey: 'load-bauxite' },
        { name: 'Coal', cities: ['Budapest'], count: 4, iconKey: 'load-coal' }
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
        { name: 'Bauxite', cities: null as any, count: 3, iconKey: 'load-bauxite' },
        { name: 'Coal', cities: ['London'], count: 4, iconKey: 'load-coal' }
      ];

      const result = transformToCityData(resources);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('London');
    });

    it('should handle resources available in multiple cities', () => {
      const resources: ResourceTableEntry[] = [
        { name: 'Beer', cities: ['Dublin', 'Frankfurt', 'Munchen', 'Praha'], count: 4, iconKey: 'load-beer' },
        { name: 'Cars', cities: ['Manchester', 'Munchen', 'Stuttgart', 'Torino'], count: 3, iconKey: 'load-cars' }
      ];

      const result = transformToCityData(resources);

      // Munchen should have both Beer and Cars
      const munchen = result.find(c => c.name === 'Munchen');
      expect(munchen).toBeDefined();
      expect(munchen!.resources).toContain('Beer');
      expect(munchen!.resources).toContain('Cars');
      expect(munchen!.resources).toHaveLength(2);

      // Dublin should only have Beer
      const dublin = result.find(c => c.name === 'Dublin');
      expect(dublin).toBeDefined();
      expect(dublin!.resources).toEqual(['Beer']);
    });
  });
});
