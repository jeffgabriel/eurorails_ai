import { LoadService } from '../services/loadService';
import { LoadState } from '../../shared/types/LoadTypes';

describe('LoadService', () => {
  let loadService: LoadService;

  beforeEach(() => {
    // Reset the singleton instance before each test
    loadService = LoadService.getInstance();
    loadService.reset();
  });

  describe('Load Configuration', () => {
    it('should load all configured load types', () => {
      const allStates = loadService.getAllLoadStates();
      
      // Verify we have all expected load types
      expect(allStates.map(state => state.loadType)).toEqual(
        expect.arrayContaining([
          'Bauxite', 'Beer', 'Cars', 'Flowers', 'Sheep', 'Cattle',
          'Cheese', 'Ham', 'Steel', 'Hops', 'Imports', 'China',
          'Tobacco', 'Iron', 'Tourists', 'Wheat', 'Coal', 'Wine',
          'Machinery', 'Marble'
        ])
      );
    });

    it('should initialize correct counts for loads', () => {
      const bauxiteState = loadService.getLoadState('Bauxite');
      const beerState = loadService.getLoadState('Beer');
      const coalState = loadService.getLoadState('Coal');

      expect(bauxiteState?.totalCount).toBe(5);
      expect(beerState?.totalCount).toBe(3);
      expect(coalState?.totalCount).toBe(6);
    });
  });

  describe('City Load Availability', () => {
    it('should correctly identify loads available in specific cities', () => {
      // Test München's available loads
      const münchenLoads = loadService.getAvailableLoadsForCity('München');
      expect(münchenLoads).toContain('Beer');
      expect(münchenLoads).toContain('Cars');
      expect(münchenLoads).not.toContain('Bauxite');

      // Test Birmingham's available loads
      const birminghamLoads = loadService.getAvailableLoadsForCity('Birmingham');
      expect(birminghamLoads).toContain('China');
      expect(birminghamLoads).toContain('Steel');
      expect(birminghamLoads).toContain('Tobacco');
      expect(birminghamLoads).toContain('Tourists');
    });

    it('should return empty array for unknown cities', () => {
      const unknownCityLoads = loadService.getAvailableLoadsForCity('NonExistentCity');
      expect(unknownCityLoads).toHaveLength(0);
    });

    it('should correctly check if specific loads are available at cities', () => {
      // Test valid combinations
      expect(loadService.isLoadAvailableAtCity('Beer', 'München')).toBe(true);
      expect(loadService.isLoadAvailableAtCity('Cars', 'München')).toBe(true);
      
      // Test invalid combinations
      expect(loadService.isLoadAvailableAtCity('Beer', 'Birmingham')).toBe(false);
      expect(loadService.isLoadAvailableAtCity('Bauxite', 'München')).toBe(false);
    });
  });

  describe('Load Pickup and Return', () => {
    it('should allow picking up available loads', () => {
      const loadType = 'Beer';
      const initialState = loadService.getLoadState(loadType);
      const initialCount = initialState?.availableCount ?? 0;

      const success = loadService.pickupLoad(loadType);
      expect(success).toBe(true);

      const newState = loadService.getLoadState(loadType);
      expect(newState?.availableCount).toBe(initialCount - 1);
    });

    it('should prevent picking up unavailable loads', () => {
      const loadType = 'Beer';
      // Pickup all available loads
      for (let i = 0; i < 3; i++) {
        loadService.pickupLoad(loadType);
      }

      // Try to pick up one more
      const success = loadService.pickupLoad(loadType);
      expect(success).toBe(false);

      const state = loadService.getLoadState(loadType);
      expect(state?.availableCount).toBe(0);
    });

    it('should allow returning previously picked up loads', () => {
      const loadType = 'Beer';
      // First pickup a load
      loadService.pickupLoad(loadType);
      
      const initialState = loadService.getLoadState(loadType);
      const initialCount = initialState?.availableCount ?? 0;

      const success = loadService.returnLoad(loadType);
      expect(success).toBe(true);

      const newState = loadService.getLoadState(loadType);
      expect(newState?.availableCount).toBe(initialCount + 1);
    });

    it('should prevent returning loads beyond total count', () => {
      const loadType = 'Beer';
      const state = loadService.getLoadState(loadType);
      const totalCount = state?.totalCount ?? 0;

      // Try to return when already at total count
      const success = loadService.returnLoad(loadType);
      expect(success).toBe(false);

      const newState = loadService.getLoadState(loadType);
      expect(newState?.availableCount).toBe(totalCount);
    });
  });

  describe('Reset Functionality', () => {
    it('should reset all load states to initial values', () => {
      const loadType = 'Beer';
      
      // Pickup some loads
      loadService.pickupLoad(loadType);
      loadService.pickupLoad(loadType);

      // Reset the service
      loadService.reset();

      // Verify state is back to initial
      const state = loadService.getLoadState(loadType);
      expect(state?.availableCount).toBe(state?.totalCount);
    });
  });
}); 