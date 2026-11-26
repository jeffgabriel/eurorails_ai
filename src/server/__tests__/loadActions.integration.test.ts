/**
 * #310: server-authoritative load pickup and drop for human players.
 *   - POST /api/players/pickup-load
 *   - POST /api/players/drop-load
 *   - POST /api/players/undo-last-action  (pickup and drop entries)
 *
 * Map facts these tests rely on (configuration/gridPoints.json, load_cities.json):
 *   - Stuttgart: small city at row 32, col 44; produces Cars (3 chips)
 *   - Ruhr: major city, centre at row 25, col 41, outpost at row 24, col 42; produces Steel
 *   - Berlin: major city, centre at row 24, col 52; produces nothing
 *   - row 24, col 50 is not a city
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import app from '../app';
import { db } from '../db';
import { activeEffectManager } from '../services/ActiveEffectManager';
import { getCityMilepointKey } from '../services/restrictionPredicates';
import { LoadService } from '../services/loadService';
import { LoadType } from '../../shared/types/LoadTypes';

async function runQuery<T = any>(queryFn: (client: any) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await queryFn(client);
  } finally {
    client.release();
  }
}

function tokenFor(userId: string): string {
  const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ userId, email: `${userId}@example.com`, username: userId, iat: now, exp: now + 15 * 60 }, JWT_SECRET);
}

interface GridPosition {
  row: number;
  col: number;
}

const STUTTGART: GridPosition = { row: 32, col: 44 };
const RUHR_OUTPOST: GridPosition = { row: 24, col: 42 };
const BERLIN: GridPosition = { row: 24, col: 52 };
const OPEN_COUNTRY: GridPosition = { row: 24, col: 50 };

describe('Load pickup and drop (#310)', () => {
  const activeUserId = uuidv4();
  const waitingUserId = uuidv4();
  const outsiderId = uuidv4();
  const userIds = [activeUserId, waitingUserId, outsiderId];
  const activeToken = tokenFor(activeUserId);
  const waitingToken = tokenFor(waitingUserId);
  const outsiderToken = tokenFor(outsiderId);

  let gameId: string;
  let activePlayerId: string;
  let waitingPlayerId: string;
  let gameIds: string[] = [];

  /** Creates a two-player game; the first player ("active") is the current player. */
  async function createGame(status: string = 'active'): Promise<void> {
    gameId = uuidv4();
    activePlayerId = uuidv4();
    waitingPlayerId = uuidv4();
    await runQuery(async (client) => {
      await client.query(
        'INSERT INTO games (id, status, current_player_index, created_by) VALUES ($1, $2, 0, $3)',
        [gameId, status, activeUserId]
      );
      const seats: Array<[string, string, string, string]> = [
        [activePlayerId, activeUserId, 'Active', '#ff0000'],
        [waitingPlayerId, waitingUserId, 'Waiting', '#0000ff'],
      ];
      for (let i = 0; i < seats.length; i++) {
        const [id, userId, name, color] = seats[i];
        await client.query(
          `INSERT INTO players (id, user_id, game_id, name, color, money, train_type, created_at)
           VALUES ($1, $2, $3, $4, $5, 50, 'freight', NOW() + ($6 || ' seconds')::interval)`,
          [id, userId, gameId, name, color, String(i)]
        );
      }
    });
    gameIds.push(gameId);
  }

  async function setTrain(
    playerId: string,
    train: { at?: GridPosition | null; loads?: LoadType[]; trainType?: string },
  ): Promise<void> {
    if (train.at !== undefined) {
      await db.query(
        'UPDATE players SET position_row = $1, position_col = $2 WHERE id = $3',
        [train.at?.row ?? null, train.at?.col ?? null, playerId]
      );
    }
    if (train.loads !== undefined) {
      await db.query('UPDATE players SET loads = $1 WHERE id = $2', [train.loads, playerId]);
    }
    if (train.trainType !== undefined) {
      await db.query('UPDATE players SET train_type = $1 WHERE id = $2', [train.trainType, playerId]);
    }
  }

  async function dropChip(city: string, loadType: LoadType): Promise<void> {
    await db.query(
      'INSERT INTO load_chips (game_id, type, city_name, is_dropped) VALUES ($1, $2, $3, true)',
      [gameId, loadType, city]
    );
  }

  async function loadsOf(playerId: string): Promise<LoadType[]> {
    const result = await db.query('SELECT loads FROM players WHERE id = $1', [playerId]);
    return result.rows[0].loads as LoadType[];
  }

  async function droppedChips(): Promise<Array<{ city_name: string; type: string }>> {
    const result = await db.query(
      'SELECT city_name, type FROM load_chips WHERE game_id = $1 AND is_dropped = true ORDER BY city_name, type',
      [gameId]
    );
    return result.rows;
  }

  async function loggedActions(playerId: string): Promise<any[]> {
    const result = await db.query(
      'SELECT actions FROM turn_actions WHERE game_id = $1 AND player_id = $2',
      [gameId, playerId]
    );
    return result.rows.flatMap((row: { actions: any[] }) => row.actions);
  }

  function post(route: string, token: string | null, body: Record<string, unknown>): request.Test {
    const req = request(app).post(`/api/players/${route}`);
    if (token) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req.send(body);
  }

  beforeAll(async () => {
    await runQuery(async (client) => {
      for (const id of userIds) {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, true)',
          [id, `la-${id.slice(0, 8)}`, `${id}@example.com`, 'hash']
        );
      }
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await runQuery(async (client) => {
      await client.query('DELETE FROM turn_actions WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM load_chips WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM players WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    });
    gameIds = [];
  });

  afterAll(async () => {
    await runQuery((client) => client.query('DELETE FROM users WHERE id = ANY($1)', [userIds]));
  });

  it('relies on map facts that hold', () => {
    const loadService = LoadService.getInstance();
    expect(loadService.isLoadAvailableAtCity(LoadType.Cars, 'Stuttgart')).toBe(true);
    expect(loadService.getTotalLoadCount(LoadType.Cars)).toBe(3);
    expect(loadService.isLoadAvailableAtCity(LoadType.Steel, 'Ruhr')).toBe(true);
    expect(loadService.isLoadAvailableAtCity(LoadType.Steel, 'Stuttgart')).toBe(false);
    expect(loadService.getAvailableLoadsForCity('Berlin')).toEqual([]);
    expect(getCityMilepointKey('Stuttgart')).toBe(`${STUTTGART.row},${STUTTGART.col}`);
  });

  describe('POST /api/players/pickup-load', () => {
    const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      gameId,
      city: 'Stuttgart',
      loadType: LoadType.Cars,
      ...overrides,
    });

    it('returns 401 without a token', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART });
      const res = await post('pickup-load', null, body());
      expect(res.status).toBe(401);
      expect(await loadsOf(activePlayerId)).toEqual([]);
    });

    it('returns 400 when a field is missing or the load type is unknown', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART });

      const missingCity = await post('pickup-load', activeToken, body({ city: undefined }));
      expect(missingCity.status).toBe(400);
      const badLoad = await post('pickup-load', activeToken, body({ loadType: 'Gold' }));
      expect(badLoad.status).toBe(400);
      const badGame = await post('pickup-load', activeToken, body({ gameId: 'not-a-uuid' }));
      expect(badGame.status).toBe(400);

      expect(await loadsOf(activePlayerId)).toEqual([]);
    });

    it('returns 403 for a user who is not in the game', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART });
      const res = await post('pickup-load', outsiderToken, body());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotAMember');
      expect(await loadsOf(activePlayerId)).toEqual([]);
    });

    it('returns 403 when it is not the user\'s turn', async () => {
      await createGame();
      await setTrain(waitingPlayerId, { at: STUTTGART });
      const res = await post('pickup-load', waitingToken, body());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotYourTurn');
      expect(await loadsOf(waitingPlayerId)).toEqual([]);
    });

    it.each(['setup', 'initialBuild', 'completed'])('returns 409 while the game is %s', async (status) => {
      await createGame(status);
      await setTrain(activePlayerId, { at: STUTTGART });
      const res = await post('pickup-load', activeToken, body());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('WrongStatus');
      expect(await loadsOf(activePlayerId)).toEqual([]);
    });

    it('returns 409 when the train is at another city', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: BERLIN });
      const res = await post('pickup-load', activeToken, body());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TrainNotAtCity');
      expect(await loadsOf(activePlayerId)).toEqual([]);
    });

    it('returns 409 when the train has not been placed', async () => {
      await createGame();
      const res = await post('pickup-load', activeToken, body());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TrainNotAtCity');
    });

    it('returns 409 when the train is full', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART, loads: [LoadType.Wine, LoadType.Beer] });
      const res = await post('pickup-load', activeToken, body());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NoCapacity');
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Wine, LoadType.Beer]);
    });

    it('lets a Heavy Freight take a third load', async () => {
      await createGame();
      await setTrain(activePlayerId, {
        at: STUTTGART,
        loads: [LoadType.Wine, LoadType.Beer],
        trainType: 'heavy_freight',
      });
      const res = await post('pickup-load', activeToken, body());
      expect(res.status).toBe(200);
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Wine, LoadType.Beer, LoadType.Cars]);
    });

    it('returns 409 when the city does not produce the load and none is dropped there', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART });
      const res = await post('pickup-load', activeToken, body({ loadType: LoadType.Steel }));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LoadNotAvailable');
      expect(await loadsOf(activePlayerId)).toEqual([]);
    });

    it('does not take a chip dropped in a different city', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART });
      await dropChip('Berlin', LoadType.Steel);
      const res = await post('pickup-load', activeToken, body({ loadType: LoadType.Steel }));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LoadNotAvailable');
      expect(await droppedChips()).toEqual([{ city_name: 'Berlin', type: LoadType.Steel }]);
    });

    it('returns 409 when every chip of the load is on a train or lying in a city', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART });
      await setTrain(waitingPlayerId, { loads: [LoadType.Cars, LoadType.Cars] });
      await dropChip('Berlin', LoadType.Cars);
      const res = await post('pickup-load', activeToken, body());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NoChipsLeft');
      expect(await loadsOf(activePlayerId)).toEqual([]);
    });

    it('returns 409 and writes nothing when a Strike covers the city', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: BERLIN });
      await dropChip('Berlin', LoadType.Cars);
      jest.spyOn(activeEffectManager, 'getPickupDeliveryRestrictions').mockResolvedValue([
        // The key the restriction check uses for the city (for a major city, one of its mileposts).
        { type: 'no_pickup_delivery_in_zone', zone: [getCityMilepointKey('Berlin')] },
      ] as any);

      const res = await post('pickup-load', activeToken, body({ city: 'Berlin' }));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('COASTAL_STRIKE_BLOCKED');
      expect(await loadsOf(activePlayerId)).toEqual([]);
      expect(await droppedChips()).toEqual([{ city_name: 'Berlin', type: LoadType.Cars }]);
      expect(await loggedActions(activePlayerId)).toEqual([]);
    });

    it('picks up a load the city produces and logs it for undo', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART, loads: [LoadType.Wine] });

      const res = await post('pickup-load', activeToken, body());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        updatedLoads: [LoadType.Wine, LoadType.Cars],
        droppedLoads: [],
        trayChanges: [{ loadType: LoadType.Cars, delta: -1 }],
      });
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Wine, LoadType.Cars]);
      expect(await loggedActions(activePlayerId)).toEqual([
        { kind: 'pickup', city: 'Stuttgart', loadType: LoadType.Cars, source: 'tray' },
      ]);
    });

    it('acts on the session user\'s player, whatever player the body names', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART });
      await setTrain(waitingPlayerId, { at: STUTTGART });

      const res = await post('pickup-load', activeToken, body({ playerId: waitingPlayerId }));

      expect(res.status).toBe(200);
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Cars]);
      expect(await loadsOf(waitingPlayerId)).toEqual([]);
    });

    it('picks up at any milepost of a major city', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: RUHR_OUTPOST });
      const res = await post('pickup-load', activeToken, body({ city: 'Ruhr', loadType: LoadType.Steel }));
      expect(res.status).toBe(200);
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Steel]);
    });

    it('picks up a chip dropped in a city that does not produce it', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: BERLIN });
      await dropChip('Berlin', LoadType.Cars);

      const res = await post('pickup-load', activeToken, body({ city: 'Berlin' }));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        updatedLoads: [LoadType.Cars],
        droppedLoads: [],
        trayChanges: [],
      });
      expect(await droppedChips()).toEqual([]);
      expect(await loggedActions(activePlayerId)).toEqual([
        { kind: 'pickup', city: 'Berlin', loadType: LoadType.Cars, source: 'city' },
      ]);
    });
  });

  describe('POST /api/players/drop-load', () => {
    const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      gameId,
      city: 'Berlin',
      loadType: LoadType.Cars,
      ...overrides,
    });

    it('returns 401 without a token', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: BERLIN, loads: [LoadType.Cars] });
      const res = await post('drop-load', null, body());
      expect(res.status).toBe(401);
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Cars]);
    });

    it('returns 403 for a user who is not in the game', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: BERLIN, loads: [LoadType.Cars] });
      const res = await post('drop-load', outsiderToken, body());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotAMember');
      expect(await droppedChips()).toEqual([]);
    });

    it('returns 403 when it is not the user\'s turn', async () => {
      await createGame();
      await setTrain(waitingPlayerId, { at: BERLIN, loads: [LoadType.Cars] });
      const res = await post('drop-load', waitingToken, body());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotYourTurn');
      expect(await loadsOf(waitingPlayerId)).toEqual([LoadType.Cars]);
      expect(await droppedChips()).toEqual([]);
    });

    it('returns 409 while the game is not active', async () => {
      await createGame('completed');
      await setTrain(activePlayerId, { at: BERLIN, loads: [LoadType.Cars] });
      const res = await post('drop-load', activeToken, body());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('WrongStatus');
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Cars]);
    });

    it('returns 409 when the train is at another city', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART, loads: [LoadType.Cars] });
      const res = await post('drop-load', activeToken, body());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TrainNotAtCity');
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Cars]);
      expect(await droppedChips()).toEqual([]);
    });

    it('returns 409 when the train is not at a city', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: OPEN_COUNTRY, loads: [LoadType.Cars] });
      const res = await post('drop-load', activeToken, body());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TrainNotAtCity');
      expect(await droppedChips()).toEqual([]);
    });

    it('returns 409 when the train does not carry the load', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: BERLIN, loads: [LoadType.Wine] });
      const res = await post('drop-load', activeToken, body());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LoadNotCarried');
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Wine]);
      expect(await droppedChips()).toEqual([]);
    });

    it('returns a load to the tray when the city produces it', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART, loads: [LoadType.Cars, LoadType.Wine] });

      const res = await post('drop-load', activeToken, body({ city: 'Stuttgart' }));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        updatedLoads: [LoadType.Wine],
        droppedLoads: [],
        trayChanges: [{ loadType: LoadType.Cars, delta: 1 }],
      });
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Wine]);
      expect(await droppedChips()).toEqual([]);
      expect(await loggedActions(activePlayerId)).toEqual([
        { kind: 'drop', city: 'Stuttgart', loadType: LoadType.Cars, placement: 'tray', displaced: [] },
      ]);
    });

    it('leaves the load in a city that does not produce it', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: BERLIN, loads: [LoadType.Cars] });

      const res = await post('drop-load', activeToken, body());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        updatedLoads: [],
        droppedLoads: [{ city_name: 'Berlin', type: LoadType.Cars }],
        trayChanges: [],
      });
      expect(await droppedChips()).toEqual([{ city_name: 'Berlin', type: LoadType.Cars }]);
    });

    it('returns the chip already in the city to the tray; the new load stays', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: BERLIN, loads: [LoadType.Cars] });
      await dropChip('Berlin', LoadType.Steel);
      await dropChip('Stuttgart', LoadType.Wine);

      const res = await post('drop-load', activeToken, body());

      expect(res.status).toBe(200);
      expect(res.body.updatedLoads).toEqual([]);
      expect(res.body.trayChanges).toEqual([{ loadType: LoadType.Steel, delta: 1 }]);
      // The chip in the other city is untouched.
      expect(await droppedChips()).toEqual([
        { city_name: 'Berlin', type: LoadType.Cars },
        { city_name: 'Stuttgart', type: LoadType.Wine },
      ]);
      expect(await loggedActions(activePlayerId)).toEqual([
        { kind: 'drop', city: 'Berlin', loadType: LoadType.Cars, placement: 'city', displaced: [LoadType.Steel] },
      ]);
    });

    it('drops one copy when the train carries two of the load', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: BERLIN, loads: [LoadType.Cars, LoadType.Cars] });
      const res = await post('drop-load', activeToken, body());
      expect(res.status).toBe(200);
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Cars]);
    });
  });

  describe('POST /api/players/undo-last-action for load actions', () => {
    it('undoes a pickup from the tray', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART, loads: [LoadType.Wine] });
      await post('pickup-load', activeToken, { gameId, city: 'Stuttgart', loadType: LoadType.Cars }).expect(200);

      const res = await post('undo-last-action', activeToken, { gameId });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        kind: 'pickup',
        updatedLoads: [LoadType.Wine],
        droppedLoads: [],
        trayChanges: [{ loadType: LoadType.Cars, delta: 1 }],
      });
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Wine]);
      expect(await loggedActions(activePlayerId)).toEqual([]);
    });

    it('undoes a pickup of a dropped chip by putting the chip back in the city', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: BERLIN });
      await dropChip('Berlin', LoadType.Cars);
      await post('pickup-load', activeToken, { gameId, city: 'Berlin', loadType: LoadType.Cars }).expect(200);
      expect(await droppedChips()).toEqual([]);

      const res = await post('undo-last-action', activeToken, { gameId });

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('pickup');
      expect(res.body.trayChanges).toEqual([]);
      expect(res.body.droppedLoads).toEqual([{ city_name: 'Berlin', type: LoadType.Cars }]);
      expect(await loadsOf(activePlayerId)).toEqual([]);
      expect(await droppedChips()).toEqual([{ city_name: 'Berlin', type: LoadType.Cars }]);
    });

    it('undoes a drop to the tray', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART, loads: [LoadType.Cars] });
      await post('drop-load', activeToken, { gameId, city: 'Stuttgart', loadType: LoadType.Cars }).expect(200);

      const res = await post('undo-last-action', activeToken, { gameId });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        kind: 'drop',
        updatedLoads: [LoadType.Cars],
        droppedLoads: [],
        trayChanges: [{ loadType: LoadType.Cars, delta: -1 }],
      });
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Cars]);
    });

    it('undoes a drop into a city and restores the chip it displaced', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: BERLIN, loads: [LoadType.Cars] });
      await dropChip('Berlin', LoadType.Steel);
      await post('drop-load', activeToken, { gameId, city: 'Berlin', loadType: LoadType.Cars }).expect(200);

      const res = await post('undo-last-action', activeToken, { gameId });

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('drop');
      expect(res.body.updatedLoads).toEqual([LoadType.Cars]);
      expect(res.body.trayChanges).toEqual([{ loadType: LoadType.Steel, delta: -1 }]);
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Cars]);
      expect(await droppedChips()).toEqual([{ city_name: 'Berlin', type: LoadType.Steel }]);
      expect(await loggedActions(activePlayerId)).toEqual([]);
    });

    it('undoes load actions newest first', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART, loads: [LoadType.Wine] });
      await post('pickup-load', activeToken, { gameId, city: 'Stuttgart', loadType: LoadType.Cars }).expect(200);
      await post('drop-load', activeToken, { gameId, city: 'Stuttgart', loadType: LoadType.Wine }).expect(200);
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Cars]);
      expect(await droppedChips()).toEqual([{ city_name: 'Stuttgart', type: LoadType.Wine }]);

      const first = await post('undo-last-action', activeToken, { gameId });
      expect(first.body.kind).toBe('drop');
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Cars, LoadType.Wine]);
      expect(await droppedChips()).toEqual([]);

      const second = await post('undo-last-action', activeToken, { gameId });
      expect(second.body.kind).toBe('pickup');
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Wine]);

      const third = await post('undo-last-action', activeToken, { gameId });
      expect(third.status).toBe(400);
    });

    it('returns 409 when a smaller train can no longer take the dropped load back', async () => {
      await createGame();
      await setTrain(activePlayerId, {
        at: BERLIN,
        loads: [LoadType.Cars, LoadType.Wine, LoadType.Beer],
        trainType: 'heavy_freight',
      });
      await post('drop-load', activeToken, { gameId, city: 'Berlin', loadType: LoadType.Cars }).expect(200);
      await setTrain(activePlayerId, { trainType: 'fast_freight' });

      const res = await post('undo-last-action', activeToken, { gameId });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NoCapacity');
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Wine, LoadType.Beer]);
      expect(await droppedChips()).toEqual([{ city_name: 'Berlin', type: LoadType.Cars }]);
    });

    it('does not let another player undo the action', async () => {
      await createGame();
      await setTrain(activePlayerId, { at: STUTTGART });
      await post('pickup-load', activeToken, { gameId, city: 'Stuttgart', loadType: LoadType.Cars }).expect(200);

      const res = await post('undo-last-action', waitingToken, { gameId });

      expect(res.status).toBe(403);
      expect(await loadsOf(activePlayerId)).toEqual([LoadType.Cars]);
    });
  });

  describe('removed routes', () => {
    it.each(['pickup', 'return', 'setInCity'])('POST /api/loads/%s no longer exists', async (route) => {
      await createGame();
      await setTrain(activePlayerId, { at: BERLIN });

      const res = await request(app)
        .post(`/api/loads/${route}`)
        .set('Authorization', `Bearer ${activeToken}`)
        .send({ gameId, city: 'Berlin', loadType: LoadType.Cars });

      expect(res.status).toBe(404);
      expect(await droppedChips()).toEqual([]);
    });
  });
});
