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
      console.log('Loading load configuration from file...');
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
      
      console.log('Loaded load configuration:', config);
      this.isLoaded = true;
      return config;
    } catch (error) {
      console.error('Failed to load load configuration:', error);
      throw error;
    }
  }

  private initializeLoadStates(): void {
    console.log('Initializing load states...');
    for (const [loadType, config] of Object.entries(this.loadConfiguration)) {
      this.loadStates.set(loadType, {
        loadType,
        availableCount: config.count,
        totalCount: config.count,
        cities: config.cities
      });
    }
    console.log('Initialized load states:', this.loadStates);
  }

  public async getLoadState(loadType: string): Promise<LoadState | undefined> {
    return this.loadStates.get(loadType);
  }

  public async getAllLoadStates(): Promise<LoadState[]> {
    console.log('Getting all load states...');
    const states = Array.from(this.loadStates.values());
    console.log('Returning load states:', states);
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
        'UPDATE load_chips SET is_dropped = false WHERE city_name = $1 AND type = $2 AND is_dropped = true',
        [city, loadType]
      );

      // Get updated dropped loads
      const droppedLoadsResult = await client.query(
        'SELECT city_name, type FROM load_chips WHERE is_dropped = true'
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

  public async returnLoad(city: string, loadType: LoadType): Promise<{
    loadState: LoadState;
    droppedLoads: Array<{ city_name: string; type: LoadType }>;
  }> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // If this was a dropped load, mark it as no longer dropped
      await client.query(
        'UPDATE load_chips SET is_dropped = false WHERE city_name = $1 AND type = $2 AND is_dropped = true',
        [city, loadType]
      );

      // Get updated dropped loads
      const droppedLoadsResult = await client.query(
        'SELECT city_name, type FROM load_chips WHERE is_dropped = true'
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

      // First, mark any existing dropped load in this city as returned
      await client.query(
        'UPDATE load_chips SET is_dropped = false WHERE city_name = $1 AND is_dropped = true',
        [city]
      );

      // Then create the new dropped load record
      await client.query(
        'INSERT INTO load_chips (game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, true)',
        [gameId, loadType, city]
      );

      // Get updated dropped loads
      const droppedLoadsResult = await client.query(
        'SELECT city_name, type FROM load_chips WHERE is_dropped = true'
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

  public async getDroppedLoads(): Promise<Array<{ city_name: string; type: LoadType }>> {
    try {
      const result = await db.query(
        'SELECT city_name, type FROM load_chips WHERE is_dropped = true'
      );
      return result.rows;
    } catch (error) {
      console.error('Error getting dropped loads:', error);
      throw error;
    }
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
    this.initializeLoadStates();
  }
}

// Export a singleton instance
export const loadService = LoadService.getInstance(); 