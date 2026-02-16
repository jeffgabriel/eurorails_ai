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

  public async pickupDroppedLoad(city: string, loadType: LoadType, gameId: string): Promise<{
    loadState: LoadState;
    droppedLoads: Array<{ city_name: string; type: LoadType }>;
  }> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Check if this is a dropped load being picked up
      await client.query(
        'UPDATE load_chips SET is_dropped = false WHERE city_name = $1 AND type = $2 AND game_id = $3 AND is_dropped = true',
        [city, loadType, gameId]
      );

      // Get updated dropped loads for this game
      const droppedLoadsResult = await client.query(
        'SELECT city_name, type FROM load_chips WHERE is_dropped = true AND game_id = $1',
        [gameId]
      );

      await client.query('COMMIT');

      const state = this.loadStates.get(loadType);
      if (!state) {
        throw new Error(`Load type ${loadType} not found`);
      }

      return {
        loadState: {
          ...state,
          availableCount: state.availableCount - 1
        },
        droppedLoads: droppedLoadsResult.rows
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async returnLoad(city: string | undefined, loadType: LoadType, gameId: string): Promise<{
    loadState: LoadState;
    droppedLoads: Array<{ city_name: string; type: LoadType }>;
  }> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // If this was a dropped load, mark it as no longer dropped
      // NOTE: city may be omitted by older clients; in that case we cannot clear a specific dropped record.
      if (typeof city === 'string' && city.length > 0) {
        await client.query(
          'UPDATE load_chips SET is_dropped = false WHERE city_name = $1 AND type = $2 AND game_id = $3 AND is_dropped = true',
          [city, loadType, gameId]
        );
      }

      // Get updated dropped loads for this game
      const droppedLoadsResult = await client.query(
        'SELECT city_name, type FROM load_chips WHERE is_dropped = true AND game_id = $1',
        [gameId]
      );

      await client.query('COMMIT');

      const state = this.loadStates.get(loadType);
      if (!state) {
        throw new Error(`Load type ${loadType} not found`);
      }

      return {
        loadState: {
          ...state,
          availableCount: state.availableCount + 1
        },
        droppedLoads: droppedLoadsResult.rows
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async setLoadInCity(city: string, loadType: LoadType, gameId: string): Promise<{
    loadState: LoadState;
    droppedLoads: Array<{ city_name: string; type: LoadType }>;
  }> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // First, mark any existing dropped load in this city as returned (for this game)
      await client.query(
        'UPDATE load_chips SET is_dropped = false WHERE city_name = $1 AND game_id = $2 AND is_dropped = true',
        [city, gameId]
      );

      // Then create the new dropped load record
      await client.query(
        'INSERT INTO load_chips (game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, true)',
        [gameId, loadType, city]
      );

      // Get updated dropped loads for this game
      const droppedLoadsResult = await client.query(
        'SELECT city_name, type FROM load_chips WHERE is_dropped = true AND game_id = $1',
        [gameId]
      );

      await client.query('COMMIT');

      const state = this.loadStates.get(loadType);
      if (!state) {
        throw new Error(`Load type ${loadType} not found`);
      }

      return {
        loadState: {
          ...state,
          availableCount: state.availableCount - 1
        },
        droppedLoads: droppedLoadsResult.rows
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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