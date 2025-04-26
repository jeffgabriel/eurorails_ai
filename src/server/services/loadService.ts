import fs from 'fs';
import path from 'path';
import { LoadConfiguration, LoadState, RawLoadConfig, LoadType } from '../../shared/types/LoadTypes';

export class LoadService {
  private static instance: LoadService;
  private loadConfiguration: LoadConfiguration = {};
  private loadStates: Map<string, LoadState> = new Map();
  private isLoaded: boolean = false;

  private constructor() {
    this.loadConfiguration = this.loadConfigurationFromFile();
    this.initializeLoadStates();
  }

  public static getInstance(): LoadService {
    if (!LoadService.instance) {
      LoadService.instance = new LoadService();
    }
    return LoadService.instance;
  }

  private loadConfigurationFromFile(): LoadConfiguration {
    try {
      const configPath = path.resolve(__dirname, '../../../configuration/load_cities.json');
      const rawData = fs.readFileSync(configPath, 'utf8');
      const jsonData = JSON.parse(rawData) as RawLoadConfig;
      
      const config: LoadConfiguration = {};
      
      // Transform the raw configuration into our internal format
      for (const item of jsonData.LoadConfiguration) {
        const loadType = Object.keys(item).find(key => key !== 'count') as LoadType;
        if (loadType) {
          config[loadType] = {
            cities: item[loadType] as string[],
            count: item.count
          };
        }
      }
      
      this.isLoaded = true;
      return config;
    } catch (error) {
      console.error('Failed to load load configuration:', error);
      throw error;
    }
  }

  private initializeLoadStates(): void {
    for (const [loadType, config] of Object.entries(this.loadConfiguration)) {
      this.loadStates.set(loadType, {
        loadType,
        availableCount: config.count,
        totalCount: config.count,
        cities: config.cities
      });
    }
  }

  public getLoadState(loadType: string): LoadState | undefined {
    return this.loadStates.get(loadType);
  }

  public getAllLoadStates(): LoadState[] {
    return Array.from(this.loadStates.values());
  }

  public getAvailableLoadsForCity(city: string): string[] {
    return Object.entries(this.loadConfiguration)
      .filter(([_, config]) => config.cities.includes(city))
      .map(([loadType]) => loadType);
  }

  public pickupLoad(loadType: string): boolean {
    const state = this.loadStates.get(loadType);
    if (!state || state.availableCount <= 0) {
      return false;
    }

    state.availableCount--;
    return true;
  }

  public returnLoad(loadType: string): boolean {
    const state = this.loadStates.get(loadType);
    if (!state || state.availableCount >= state.totalCount) {
      return false;
    }

    state.availableCount++;
    return true;
  }

  public isLoadAvailableAtCity(loadType: string, city: string): boolean {
    const config = this.loadConfiguration[loadType];
    return config?.cities.includes(city) ?? false;
  }

  public setLoadInCity(loadType: string, city: string): boolean {
    // First check if there's already a load in this city
    const existingLoad = this.getLoadInCity(city);
    if (existingLoad) {
      // Return the existing load to the tray
      this.returnLoad(existingLoad);
    }

    // Set the new load in the city
    const state = this.loadStates.get(loadType);
    if (!state) {
      return false;
    }

    // If this city produces this load type, we don't need to track it separately
    if (this.isLoadAvailableAtCity(loadType, city)) {
      return true;
    }

    // Otherwise, we need to track that this load is now in this city
    state.cityLoads = state.cityLoads || new Map();
    state.cityLoads.set(city, loadType);
    return true;
  }

  public getLoadInCity(city: string): string | undefined {
    for (const state of this.loadStates.values()) {
      if (state.cityLoads?.get(city)) {
        return state.loadType;
      }
    }
    return undefined;
  }

  public reset(): void {
    this.initializeLoadStates();
  }
}

// Export a singleton instance
export const loadService = LoadService.getInstance(); 