import { LoadService } from '../services/loadService';
import { LoadState, LoadType } from '../../shared/types/LoadTypes';
import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';

describe('LoadService', () => {
  let loadService: LoadService;
  let client: any;
  let gameId: string;

  beforeAll(async () => {
    client = await db.connect();
  });

  afterAll(async () => {
    await client.release();
  });

  beforeEach(async () => {
    loadService = await LoadService.getInstance();
    // Create a test game
    const result = await db.query(
      'INSERT INTO games (status, current_player_index, max_players) VALUES ($1, $2, $3) RETURNING id',
      ['setup', 0, 6]
    );
    gameId = result.rows[0].id;

    // Clean up any existing test data
    await client.query('DELETE FROM load_chips');
  });

  afterEach(async () => {
    // Clean up test data
    await db.query('DELETE FROM games WHERE id = $1', [gameId]);
  });

  describe('Load Configuration', () => {
    it('should load all configured load types', async () => {
      const allStates = await loadService.getAllLoadStates();
      
      // Verify we have all expected load types
      expect(allStates.map(state => state.loadType)).toEqual(
        expect.arrayContaining(Object.values(LoadType))
      );
    });

    it('should initialize correct counts for loads', async () => {
      const bauxiteState = await loadService.getLoadState(LoadType.Bauxite);
      const beerState = await loadService.getLoadState(LoadType.Beer);
      const coalState = await loadService.getLoadState(LoadType.Coal);

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
          [gameId, LoadType.Coal, 'Birmingham']
        );

        const droppedLoads = await loadService.getDroppedLoads();
        expect(droppedLoads).toHaveLength(2);
        expect(droppedLoads).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ city_name: 'München', type: LoadType.Beer }),
            expect.objectContaining({ city_name: 'Birmingham', type: LoadType.Coal })
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
          [gameId, LoadType.Coal, 'München']
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
        const loadType = LoadType.Coal;
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
        const loadType = LoadType.Coal;
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
        const loadType = LoadType.Coal;
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