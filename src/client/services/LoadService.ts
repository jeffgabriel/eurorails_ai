import { DroppedLoad, LoadState, LoadTrayChange, LoadType } from '../../shared/types/LoadTypes';
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
   * Change the local count of chips of a load type in the tray.
   * The server does not send tray counts; this keeps the local view in step
   * with an action the server has already accepted.
   */
  public adjustTrayCount(loadType: LoadType, delta: number): void {
    const state = this.loadStates.get(loadType);
    if (state) {
      state.availableCount = Math.max(0, Math.min(state.totalCount, state.availableCount + delta));
    }
  }

  /**
   * Apply the result of a load pickup, drop or undo the server has accepted:
   * the game's dropped chips replace the local ones, and the tray counts move
   * by the changes the server reports.
   */
  public applyServerUpdate(update: { droppedLoads: DroppedLoad[]; trayChanges: LoadTrayChange[] }): void {
    this.droppedLoads.clear();
    update.droppedLoads.forEach(drop => {
      const cityLoads = this.droppedLoads.get(drop.city_name) || [];
      cityLoads.push(drop.type);
      this.droppedLoads.set(drop.city_name, cityLoads);
    });
    update.trayChanges.forEach(change => {
      this.adjustTrayCount(change.loadType, change.delta);
    });
  }

  // Helper method to check if a city naturally produces a load type
  private cityProducesLoad(city: string, loadType: LoadType): boolean {
    const state = this.loadStates.get(loadType);
    return state ? state.cities.includes(city) : false;
  }
} 