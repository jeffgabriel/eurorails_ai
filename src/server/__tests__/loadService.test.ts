// Test Cleanup Strategy: Serial Execution Required
// This test file interacts heavily with the database and must run serially to avoid deadlocks.
// Run with: npm test -- --runInBand src/server/__tests__/loadService.test.ts
// Or set maxWorkers=1 in jest config for all database tests.

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
import { LoadType } from '../../shared/types/LoadTypes';
import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { cleanDatabase } from '../db/index';


// Import LoadService after setting up mocks

describe('LoadService', () => {
  let loadService: LoadService;
  let gameId: string;

  beforeAll(async () => {
    await cleanDatabase();
    gameId = uuidv4(); // Generate a valid UUID for the game
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  beforeEach(async () => {
    // Get a connection for this specific test
    const client = await db.connect();
    try {
      await ensureTestGameExists(client, gameId);
    } finally {
      client.release();
    }
    
    // Get a fresh instance of LoadService and reset it
    loadService = await LoadService.getInstance();
    loadService.reset();
  });

  afterEach(async () => {
    // Get a connection for cleanup
    const client = await db.connect();
    try {
      // Clean up all test data in dependency order (child tables first)
      await client.query('DELETE FROM load_chips WHERE game_id = $1', [gameId]);
    } finally {
      client.release();
    }
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
        // Setup: Insert some test dropped loads using the service
        await runQuery(async (client) => {
          await ensureTestGameExists(client, gameId);
        });
        await loadService.setLoadInCity('München', LoadType.Beer, gameId);
        await loadService.setLoadInCity('Stuttgart', LoadType.Cars, gameId);

        const droppedLoads = await loadService.getDroppedLoads(gameId);
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
        const client = await db.connect();
        try {
          await ensureTestGameExists(client, gameId);
          await client.query(
            'INSERT INTO load_chips (game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, true)',
            [gameId, LoadType.Beer, 'München']
          );
        } finally {
          client.release();
        }

        const result = await loadService.pickupDroppedLoad('München', LoadType.Beer, gameId);
        
        // Check the load was picked up
        const checkClient = await db.connect();
        try {
          const droppedLoads = await checkClient.query(
            'SELECT * FROM load_chips WHERE is_dropped = true AND game_id = $1',
            [gameId]
          );
          expect(droppedLoads.rows).toHaveLength(0);
        } finally {
          checkClient.release();
        }

        // Check the returned state
        expect(result.loadState.loadType).toBe(LoadType.Beer);
        expect(result.droppedLoads).toHaveLength(0);
      });

      it('should handle returning a load to the tray', async () => {
        // Setup: Insert a dropped load
        await runQuery(async (client) => {
          await ensureTestGameExists(client, gameId);
          await client.query(
            'INSERT INTO load_chips (game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, true)',
            [gameId, LoadType.Beer, 'München']
          );
        });

        const result = await loadService.returnLoad('München', LoadType.Beer, gameId);
        
        // Check the load was returned
        await runQuery(async (client) => {
          const droppedLoads = await client.query(
            'SELECT * FROM load_chips WHERE is_dropped = true AND game_id = $1',
            [gameId]
          );
          expect(droppedLoads.rows).toHaveLength(0);
        });

        // Check the returned state
        expect(result.loadState.loadType).toBe(LoadType.Beer);
        expect(result.droppedLoads).toHaveLength(0);
      });

      it('should set a load in a city', async () => {
        await runQuery(async (client) => {
          await ensureTestGameExists(client, gameId);
        });
        const result = await loadService.setLoadInCity('München', LoadType.Beer, gameId);
        
        // Check the load was set using the service API
        const droppedLoads = await loadService.getDroppedLoads(gameId);
        expect(droppedLoads).toHaveLength(1);
        expect(droppedLoads[0]).toEqual(
          expect.objectContaining({
            city_name: 'München',
            type: LoadType.Beer
          })
        );

        // Check the returned state
        expect(result.loadState.loadType).toBe(LoadType.Beer);
        expect(result.droppedLoads).toHaveLength(1);
      });

      it('should handle setting a load in a city that already has one', async () => {
        // Setup: Insert an existing dropped load
        await runQuery(async (client) => {
          await ensureTestGameExists(client, gameId);
          await client.query(
            'INSERT INTO load_chips (game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, true)',
            [gameId, LoadType.Cars, 'München']
          );
        });

        const result = await loadService.setLoadInCity('München', LoadType.Beer, gameId);
        
        // Check only the new load exists
        await runQuery(async (client) => {
          const droppedLoads = await client.query(
            'SELECT * FROM load_chips WHERE is_dropped = true AND game_id = $1',
            [gameId]
          );
          expect(droppedLoads.rows).toHaveLength(1);
          expect(droppedLoads.rows[0]).toEqual(
            expect.objectContaining({
              city_name: 'München',
              type: LoadType.Beer,
              is_dropped: true
            })
          );
        });

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
        await runQuery(async (client) => {
          await client.query(
            'INSERT INTO load_chips (id, game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, $4, true)',
            [uuidv4(), gameId, loadType, cityName]
          );
        });

        const droppedLoads = await loadService.getDroppedLoads(gameId);
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

        await runQuery(async (client) => {
          const result = await client.query('SELECT * FROM load_chips WHERE game_id = $1', [gameId]);
          expect(result.rows.length).toBe(1);
          expect(result.rows[0].type).toBe(loadType);
          expect(result.rows[0].city_name).toBe(cityName);
        });
      });
    });

    describe('returnLoad', () => {
      it('should remove a dropped load from the database', async () => {
        // Insert a test load first
        const loadType = LoadType.Cars;
        const cityName = 'London';
        await runQuery(async (client) => {
          await client.query(
            'INSERT INTO load_chips (id, game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, $4, true)',
            [uuidv4(), gameId, loadType, cityName]
          );
        });

        await loadService.returnLoad(cityName, loadType, gameId);

        await runQuery(async (client) => {
          const result = await client.query('SELECT * FROM load_chips WHERE is_dropped = true AND game_id = $1', [gameId]);
          expect(result.rows.length).toBe(0);
        });
      });
    });
  });

  describe('Initial Load Availability', () => {
    let loadService: LoadService;

    beforeEach(async () => {
      loadService = await LoadService.getInstance();
      loadService.reset();
    });

    it('Each city should only have the loads configured in load_cities.json', () => {
      // Read the config file directly
      const fs = require('fs');
      const path = require('path');
      const configPath = path.resolve(__dirname, '../../../configuration/load_cities.json');
      const configFile = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configFile);
      const cityToLoads: Record<string, string[]> = {};
      for (const item of config.LoadConfiguration) {
        for (const key of Object.keys(item)) {
          if (key !== 'count') {
            for (const city of item[key]) {
              if (!cityToLoads[city]) cityToLoads[city] = [];
              cityToLoads[city].push(key);
            }
          }
        }
      }
      for (const [city, expectedLoads] of Object.entries(cityToLoads)) {
        const actualLoads = loadService.getAvailableLoadsForCity(city);
        expect(actualLoads.sort()).toEqual(expectedLoads.sort());
      }
    });
  });
});

// Helper to ensure the game exists before inserting into child tables
async function ensureTestGameExists(client: any, gameId: string) {
  await client.query(
    'INSERT INTO games (id, status) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
    [gameId, 'setup']
  );
}

// Helper to run a query with automatic connection management
async function runQuery<T = any>(queryFn: (client: any) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await queryFn(client);
  } finally {
    client.release();
  }
} 