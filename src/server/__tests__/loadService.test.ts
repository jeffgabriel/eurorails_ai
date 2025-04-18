import { LoadService } from '../services/loadService';
import { LoadState, LoadType } from '../../shared/types/LoadTypes';

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
        expect.arrayContaining(Object.values(LoadType))
      );
    });

    it('should initialize correct counts for loads', () => {
      const bauxiteState = loadService.getLoadState(LoadType.Bauxite);
      const beerState = loadService.getLoadState(LoadType.Beer);
      const coalState = loadService.getLoadState(LoadType.Coal);

      expect(bauxiteState?.totalCount).toBe(5);
      expect(beerState?.totalCount).toBe(3);
      expect(coalState?.totalCount).toBe(6);
    });
  });

  describe('City Load Availability', () => {
    it('should correctly identify loads available in specific cities', () => {
      // Test München's available loads
      const münchenLoads = loadService.getAvailableLoadsForCity('München');
      expect(münchenLoads).toContain(LoadType.Beer);
      expect(münchenLoads).toContain(LoadType.Cars);
      expect(münchenLoads).not.toContain(LoadType.Bauxite);

      // Test Birmingham's available loads
      const birminghamLoads = loadService.getAvailableLoadsForCity('Birmingham');
      expect(birminghamLoads).toContain(LoadType.China);
      expect(birminghamLoads).toContain(LoadType.Steel);
      expect(birminghamLoads).toContain(LoadType.Tobacco);
      expect(birminghamLoads).toContain(LoadType.Tourists);
    });

    it('should return empty array for unknown cities', () => {
      const unknownCityLoads = loadService.getAvailableLoadsForCity('NonExistentCity');
      expect(unknownCityLoads).toHaveLength(0);
    });

    it('should correctly check if specific loads are available at cities', () => {
      // Test valid combinations
      expect(loadService.isLoadAvailableAtCity(LoadType.Beer, 'München')).toBe(true);
      expect(loadService.isLoadAvailableAtCity(LoadType.Cars, 'München')).toBe(true);
      
      // Test invalid combinations
      expect(loadService.isLoadAvailableAtCity(LoadType.Beer, 'Birmingham')).toBe(false);
      expect(loadService.isLoadAvailableAtCity(LoadType.Bauxite, 'München')).toBe(false);
    });
  });

  describe('Load Pickup and Return', () => {
    it('should allow picking up available loads', () => {
      const loadType = LoadType.Beer;
      const initialState = loadService.getLoadState(loadType);
      const initialCount = initialState?.availableCount ?? 0;

      const success = loadService.pickupLoad(loadType);
      expect(success).toBe(true);

      const newState = loadService.getLoadState(loadType);
      expect(newState?.availableCount).toBe(initialCount - 1);
    });

    it('should prevent picking up unavailable loads', () => {
      const loadType = LoadType.Beer;
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
      const loadType = LoadType.Beer;
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
      const loadType = LoadType.Beer;
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
      const loadType = LoadType.Beer;
      
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