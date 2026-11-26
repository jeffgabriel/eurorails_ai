import { db } from '../db';
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
        const loadType = Object.keys(item).find(key => key !== 'count');
        if (loadType && Object.values(LoadType).includes(loadType as LoadType)) {
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

  public async getLoadState(loadType: string): Promise<LoadState | undefined> {
    return this.loadStates.get(loadType);
  }

  public async getAllLoadStates(): Promise<LoadState[]> {
    const states = Array.from(this.loadStates.values());
    return states;
  }

  public getAvailableLoadsForCity(city: string): string[] {
    return Object.entries(this.loadConfiguration)
      .filter(([_, config]) => config.cities.includes(city))
      .map(([loadType]) => loadType);
  }

  public async getDroppedLoads(gameId: string): Promise<Array<{ city_name: string; type: LoadType }>> {
    try {
      const result = await db.query(
        'SELECT city_name, type FROM load_chips WHERE is_dropped = true AND game_id = $1',
        [gameId]
      );
      return result.rows;
    } catch (error) {
      console.error('Error getting dropped loads:', error);
      throw error;
    }
  }

  /**
   * Get the cities that produce a given load type.
   * Inverse of getAvailableLoadsForCity.
   */
  public getSourceCitiesForLoad(loadType: string): string[] {
    return this.loadConfiguration[loadType]?.cities ?? [];
  }

  public isLoadAvailableAtCity(loadType: string, city: string): boolean {
    const config = this.loadConfiguration[loadType];
    return config?.cities.includes(city) ?? false;
  }

  /** Number of chips of a load type in the game (0 for an unknown type). */
  public getTotalLoadCount(loadType: string): number {
    return this.loadConfiguration[loadType]?.count ?? 0;
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
    this.loadConfiguration = this.loadConfigurationFromFile();
    this.initializeLoadStates();
  }
}

// Export a singleton instance
export const loadService = LoadService.getInstance(); 