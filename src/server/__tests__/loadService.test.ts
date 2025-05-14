// Mock fs module before any imports
jest.mock('fs', () => ({
  readFileSync: jest.fn((path) => {
    if (path.includes('load_cities.json')) {
      return JSON.stringify({
        LoadConfiguration: [
          {
            Bauxite: ['Budapest', 'Beograd', 'Marseille'],
            count: 5
          },
          {
            Beer: ['München', 'Frankfurt', 'Praha'],
            count: 3
          },
          {
            Cars: ['München', 'Stuttgart', 'Torino'],
            count: 3
          }
        ]
      });
    }
    throw new Error(`Unexpected file read: ${path}`);
  })
}));

import { LoadService } from '../services/loadService';
import { LoadState, LoadType } from '../../shared/types/LoadTypes';
import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

// Import LoadService after setting up mocks

describe('LoadService', () => {
  let loadService: LoadService;
  let client: any;
  let gameId: string;

  beforeAll(async () => {
    client = await db.connect();
    gameId = uuidv4(); // Generate a valid UUID for the game
  });

  afterAll(async () => {
    await client.release();
  });

  beforeEach(async () => {
    // Clean up any existing test data
    await client.query('DELETE FROM load_chips');
    await client.query('DELETE FROM games');

    // Create a test game with the pre-generated UUID
    await client.query(
      'INSERT INTO games (id, status, current_player_index, max_players) VALUES ($1, $2, $3, $4)',
      [gameId, 'setup', 0, 6]
    );

    // Get a fresh instance of LoadService and reset it
    loadService = await LoadService.getInstance();
    loadService.reset();
  });

  afterEach(async () => {    // Clean up test data
    await client.query('DELETE FROM load_chips');
    await client.query('DELETE FROM games');
  });

  describe('Load Configuration', () => {
    it('should load all configured load types', async () => {
      const allStates = await loadService.getAllLoadStates();
      const loadedTypes = allStates.map(state => state.loadType);
      
      // Define the expected configured load types from our mock
      const expectedLoadTypes = [
        LoadType.Bauxite,
        LoadType.Beer,
        LoadType.Cars
      ];

      // Verify each expected load type is present
      for (const loadType of expectedLoadTypes) {
        expect(loadedTypes).toContain(loadType);
      }

      // Verify no unexpected load types from our configuration
      expect(loadedTypes.length).toBe(expectedLoadTypes.length);
    });

    it('should initialize correct counts for loads', async () => {
      const bauxiteState = await loadService.getLoadState(LoadType.Bauxite);
      const beerState = await loadService.getLoadState(LoadType.Beer);
      const carsState = await loadService.getLoadState(LoadType.Cars);

      expect(bauxiteState?.totalCount).toBe(5);
      expect(beerState?.totalCount).toBe(3);
      expect(carsState?.totalCount).toBe(3);
    });
  });

  describe('City Load Availability', () => {
    beforeEach(() => {
      // Reset the LoadService to ensure fresh state
      loadService.reset();
    });

    it('should correctly identify loads available in specific cities', () => {
      // Test München's available loads
      const münchenLoads = loadService.getAvailableLoadsForCity('München');
      expect(münchenLoads).toContain(LoadType.Beer);
      expect(münchenLoads).toContain(LoadType.Cars);
      expect(münchenLoads).not.toContain(LoadType.Bauxite);

      // Test Budapest's available loads
      const budapestLoads = loadService.getAvailableLoadsForCity('Budapest');
      expect(budapestLoads).toContain(LoadType.Bauxite);
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
      expect(loadService.isLoadAvailableAtCity(LoadType.Beer, 'Budapest')).toBe(false);
      expect(loadService.isLoadAvailableAtCity(LoadType.Bauxite, 'München')).toBe(false);
    });
  });

  describe('Database Operations', () => {
    describe('Dropped Loads', () => {
      it('should get all dropped loads', async () => {
        // Setup: Insert some test dropped loads
        await client.query(
          'INSERT INTO load_chips (game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, true)',
          [gameId, LoadType.Beer, 'München']
        );
        await client.query(
          'INSERT INTO load_chips (game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, true)',
          [gameId, LoadType.Cars, 'Stuttgart']
        );

        const droppedLoads = await loadService.getDroppedLoads();
        expect(droppedLoads).toHaveLength(2);
        expect(droppedLoads).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ city_name: 'München', type: LoadType.Beer }),
            expect.objectContaining({ city_name: 'Stuttgart', type: LoadType.Cars })
          ])
        );
      });

      it('should pick up a dropped load', async () => {
        // Setup: Insert a dropped load
        await client.query(
          'INSERT INTO load_chips (game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, true)',
          [gameId, LoadType.Beer, 'München']
        );

        const result = await loadService.pickupDroppedLoad('München', LoadType.Beer, gameId);
        
        // Check the load was picked up
        const droppedLoads = await client.query(
          'SELECT * FROM load_chips WHERE is_dropped = true'
        );
        expect(droppedLoads.rows).toHaveLength(0);

        // Check the returned state
        expect(result.loadState.loadType).toBe(LoadType.Beer);
        expect(result.droppedLoads).toHaveLength(0);
      });

      it('should handle returning a load to the tray', async () => {
        // Setup: Insert a dropped load
        await client.query(
          'INSERT INTO load_chips (game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, true)',
          [gameId, LoadType.Beer, 'München']
        );

        const result = await loadService.returnLoad('München', LoadType.Beer);
        
        // Check the load was returned
        const droppedLoads = await client.query(
          'SELECT * FROM load_chips WHERE is_dropped = true'
        );
        expect(droppedLoads.rows).toHaveLength(0);

        // Check the returned state
        expect(result.loadState.loadType).toBe(LoadType.Beer);
        expect(result.droppedLoads).toHaveLength(0);
      });

      it('should set a load in a city', async () => {
        const result = await loadService.setLoadInCity('München', LoadType.Beer, gameId);
        
        // Check the load was set
        const droppedLoads = await client.query(
          'SELECT * FROM load_chips WHERE is_dropped = true'
        );
        expect(droppedLoads.rows).toHaveLength(1);
        expect(droppedLoads.rows[0]).toEqual(
          expect.objectContaining({
            city_name: 'München',
            type: LoadType.Beer,
            is_dropped: true
          })
        );

        // Check the returned state
        expect(result.loadState.loadType).toBe(LoadType.Beer);
        expect(result.droppedLoads).toHaveLength(1);
      });

      it('should handle setting a load in a city that already has one', async () => {
        // Setup: Insert an existing dropped load
        await client.query(
          'INSERT INTO load_chips (game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, true)',
          [gameId, LoadType.Cars, 'München']
        );

        const result = await loadService.setLoadInCity('München', LoadType.Beer, gameId);
        
        // Check only the new load exists
        const droppedLoads = await client.query(
          'SELECT * FROM load_chips WHERE is_dropped = true'
        );
        expect(droppedLoads.rows).toHaveLength(1);
        expect(droppedLoads.rows[0]).toEqual(
          expect.objectContaining({
            city_name: 'München',
            type: LoadType.Beer,
            is_dropped: true
          })
        );

        // Check the returned state
        expect(result.loadState.loadType).toBe(LoadType.Beer);
        expect(result.droppedLoads).toHaveLength(1);
      });

      it('should handle errors in database operations', async () => {
        // Force a database error by using an invalid game ID
        await expect(
          loadService.setLoadInCity('München', LoadType.Beer, 'invalid-uuid')
        ).rejects.toThrow();
      });
    });

    describe('loadConfigurationFromFile', () => {
      it('should load the configuration correctly', async () => {
        const loadStates = await loadService.getAllLoadStates();
        expect(loadStates).toBeDefined();
        expect(loadStates.length).toBeGreaterThan(0);
        expect(loadStates[0].cities).toBeDefined();
        expect(loadStates[0].loadType).toBeDefined();
      });
    });

    describe('getAvailableLoadsForCity', () => {
      it('should return load availability for a city', () => {
        const cityName = 'London';
        const availability = loadService.getAvailableLoadsForCity(cityName);
        expect(availability).toBeDefined();
        expect(Array.isArray(availability)).toBe(true);
      });
    });

    describe('getDroppedLoads', () => {
      it('should return dropped loads from the database', async () => {
        // Insert a test load
        const loadType = LoadType.Cars;
        const cityName = 'London';
        await client.query(
          'INSERT INTO load_chips (id, game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, $4, true)',
          [uuidv4(), gameId, loadType, cityName]
        );

        const droppedLoads = await loadService.getDroppedLoads();
        expect(droppedLoads).toBeDefined();
        expect(droppedLoads.length).toBe(1);
        expect(droppedLoads[0].type).toBe(loadType);
        expect(droppedLoads[0].city_name).toBe(cityName);
      });
    });

    describe('setLoadInCity', () => {
      it('should add a dropped load to the database', async () => {
        const loadType = LoadType.Cars;
        const cityName = 'London';
        
        await loadService.setLoadInCity(cityName, loadType, gameId);

        const result = await client.query('SELECT * FROM load_chips WHERE game_id = $1', [gameId]);
        expect(result.rows.length).toBe(1);
        expect(result.rows[0].type).toBe(loadType);
        expect(result.rows[0].city_name).toBe(cityName);
      });
    });

    describe('returnLoad', () => {
      it('should remove a dropped load from the database', async () => {
        // Insert a test load first
        const loadType = LoadType.Cars;
        const cityName = 'London';
        await client.query(
          'INSERT INTO load_chips (id, game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, $4, true)',
          [uuidv4(), gameId, loadType, cityName]
        );

        await loadService.returnLoad(cityName, loadType);

        const result = await client.query('SELECT * FROM load_chips WHERE is_dropped = true');
        expect(result.rows.length).toBe(0);
      });
    });
  });
}); 