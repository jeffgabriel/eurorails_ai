import { LoadState, LoadType } from '../../shared/types/LoadTypes';
import { api } from '../lobby/shared/api';

export class LoadService {
  private static instance: LoadService;
  private loadStates: Map<string, LoadState> = new Map();
  private isLoaded: boolean = false;
  private droppedLoads: Map<string, LoadType[]> = new Map(); // city name -> array of load types

  private constructor() {}

  public static getInstance(): LoadService {
    if (!LoadService.instance) {
      LoadService.instance = new LoadService();
    }
    return LoadService.instance;
  }

  private getGameIdFromStorage(): string | null {
    try {
      const gameStr = localStorage.getItem('eurorails.currentGame');
      if (!gameStr) {
        return null;
      }
      const game = JSON.parse(gameStr);
      return game?.id || null;
    } catch (error) {
      console.warn('Failed to parse gameId from localStorage:', error);
      return null;
    }
  }

  public async loadInitialState(): Promise<void> {
    if (this.isLoaded) {
      return;
    }

    try {
      // Get gameId from localStorage
      const gameId = this.getGameIdFromStorage();
      
      const [states, droppedLoads] = await Promise.all([
        api.getLoadState(),
        api.getDroppedLoads(gameId || undefined)
      ]);
      
      // Initialize the load states map
      states.forEach(state => {
        this.loadStates.set(state.loadType, state);
      });

      // Initialize dropped loads map - group by city
      droppedLoads.forEach(drop => {
        const cityLoads = this.droppedLoads.get(drop.city_name) || [];
        cityLoads.push(drop.type);
        this.droppedLoads.set(drop.city_name, cityLoads);
      });
      
      this.isLoaded = true;
    } catch (error) {
      throw error;
    }
  }

  public getCityLoadDetails(city: string): Array<{ loadType: LoadType; count: number }> {
    if (!this.isLoaded) {
      return [];
    }
    
    const loadDetails = new Map<LoadType, { loadType: LoadType; count: number }>();
    
    // First check configured loads (static city configuration)
    this.loadStates.forEach(state => {
      if (state && state.cities && state.cities.includes(city)) {
        if (state.availableCount > 0) {
          loadDetails.set(state.loadType as LoadType, {
            loadType: state.loadType as LoadType,
            count: state.availableCount
          });
        }
      }
    });

    // Then check dropped loads in this city
    const droppedLoadsInCity = this.droppedLoads.get(city) || [];
    if (droppedLoadsInCity.length > 0) {
      // Count occurrences of each load type
      const dropCounts = new Map<LoadType, number>();
      droppedLoadsInCity.forEach(loadType => {
        const currentCount = dropCounts.get(loadType) || 0;
        dropCounts.set(loadType, currentCount + 1);
      });

      // Add dropped loads to the result
      dropCounts.forEach((count, loadType) => {
        const existing = loadDetails.get(loadType);
        if (existing) {
          // If this load type is also configured for this city, add to available count
          existing.count += count;
        } else {
          // If this is just a dropped load, add it as new
          loadDetails.set(loadType, {
            loadType,
            count
          });
        }
      });
    }

    const result = Array.from(loadDetails.values());
    return result;
  }

  public getAllLoadStates(): LoadState[] {
    return Array.from(this.loadStates.values());
  }

  /**
   * Pick up a load from a city
   * Server-authoritative: API call first, update local state only after success
   */
  public async pickupLoad(loadType: LoadType, city: string, gameIdOverride?: string): Promise<boolean> {
    try {
      // First check if this is a dropped load
      const droppedLoadsInCity = this.droppedLoads.get(city) || [];
      const isDroppedLoad = droppedLoadsInCity.includes(loadType);

      // Get gameId from localStorage
      const gameId = gameIdOverride || this.getGameIdFromStorage();
      if (!gameId) {
        console.error('[LoadService.pickupLoad] Missing gameId (neither override nor localStorage)');
        return false;
      }
      
      // Server-authoritative: Make API call first
      const result = await api.pickupLoad({
        loadType,
        city,
        gameId,
        isDropped: isDroppedLoad,
      });

      // Only update local state after API succeeds
      if (isDroppedLoad) {
        // Update local state for dropped loads
        const updatedDrops = droppedLoadsInCity.filter((type, index) => 
          index !== droppedLoadsInCity.indexOf(loadType));
        if (updatedDrops.length === 0) {
          this.droppedLoads.delete(city);
        } else {
          this.droppedLoads.set(city, updatedDrops);
        }
      } else {
        // Update the available count in load states
        const state = this.loadStates.get(loadType);
        if (state) {
          state.availableCount--;
          this.loadStates.set(loadType, state);
        }
      }

      // Update dropped loads from server response
      result.droppedLoads.forEach(drop => {
        const cityLoads = this.droppedLoads.get(drop.city_name) || [];
        if (!cityLoads.includes(drop.type)) {
          cityLoads.push(drop.type);
          this.droppedLoads.set(drop.city_name, cityLoads);
        }
      });

      return true;
    } catch (error) {
      console.error('[LoadService.pickupLoad] Failed:', error);
      return false;
    }
  }

  /**
   * Return a load to the global availability pool
   * Server-authoritative: API call first, update local state only after success
   */
  public async returnLoad(loadType: LoadType, gameIdOverride?: string): Promise<boolean> {
    try {
      // Get gameId from localStorage
      const gameId = gameIdOverride || this.getGameIdFromStorage();
      if (!gameId) {
        console.error('[LoadService.returnLoad] Missing gameId (neither override nor localStorage)');
        return false;
      }
      
      // Server-authoritative: Make API call first
      const result = await api.returnLoad({ loadType, gameId });

      // Only update local state after API succeeds
      const state = this.loadStates.get(loadType);
      if (state) {
        state.availableCount++;
        this.loadStates.set(loadType, state);
      }

      // Update dropped loads from server response
      result.droppedLoads.forEach(drop => {
        const cityLoads = this.droppedLoads.get(drop.city_name) || [];
        if (!cityLoads.includes(drop.type)) {
          cityLoads.push(drop.type);
          this.droppedLoads.set(drop.city_name, cityLoads);
        }
      });

      return true;
    } catch (error) {
      console.error('[LoadService.returnLoad] Failed:', error);
      return false;
    }
  }

  /**
   * Set a load in a city (drop a load)
   * Server-authoritative: API call first, update local state only after success
   */
  public async setLoadInCity(city: string, loadType: LoadType, gameIdOverride?: string): Promise<boolean> {
    try {
      // Get gameId from localStorage
      const gameId = gameIdOverride || this.getGameIdFromStorage();
      if (!gameId) {
        console.error('[LoadService.setLoadInCity] Missing gameId (neither override nor localStorage)');
        return false;
      }
      
      // Server-authoritative: Make API call first
      const result = await api.setLoadInCity({ city, loadType, gameId });

      // Only update local state after API succeeds
      result.droppedLoads.forEach(drop => {
        const cityLoads = this.droppedLoads.get(drop.city_name) || [];
        if (!cityLoads.includes(drop.type)) {
          cityLoads.push(drop.type);
          this.droppedLoads.set(drop.city_name, cityLoads);
        }
      });

      return true;
    } catch (error) {
      console.error('[LoadService.setLoadInCity] Failed:', error);
      return false;
    }
  }

  // Helper method to check if a city naturally produces a load type
  private cityProducesLoad(city: string, loadType: LoadType): boolean {
    const state = this.loadStates.get(loadType);
    return state ? state.cities.includes(city) : false;
  }
} 