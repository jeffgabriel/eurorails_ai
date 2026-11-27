/**
 * #312: server-computed movement cost and speed limit.
 *   - POST /api/players/move-train    (route, milepost count and per-turn limit come from the server)
 *   - POST /api/players/deliver-load  (the train must be in the delivery city)
 *
 * Isolation and cleanup (real database, shared with the other integration suites):
 *   - beforeAll inserts this suite's two users; afterAll deletes them by id.
 *   - Each test builds its own game with createGame(), which records the game id.
 *   - afterEach deletes only this suite's games, children first: turn_actions,
 *     movement_history, player_tracks, players, then games. It also drops the
 *     in-memory demand decks.
 *   - Rows are always selected by this suite's ids, never table-wide.
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import app from '../app';
import { db } from '../db';
import { PlayerService } from '../services/playerService';
import { DemandDeckService } from '../services/demandDeckService';
import { loadGridPoints } from '../services/MapTopology';
import { isCityMilepostOf } from '../services/trainMovement';
import { getFerryEdges } from '../../shared/services/majorCityGroups';
import { TerrainType, TrainType } from '../../shared/types/GameTypes';

type Node = { row: number; col: number };

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

function segment(from: Node, to: Node): object {
  return {
    from: { x: 0, y: 0, row: from.row, col: from.col, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: to.row, col: to.col, terrain: TerrainType.Clear },
    cost: 1,
  };
}

/** A straight line of `edges` segments along an off-map row (no cities, no ferries). */
function line(row: number, startCol: number, edges: number): object[] {
  const segments: object[] = [];
  for (let i = 0; i < edges; i++) {
    segments.push(segment({ row, col: startCol + i }, { row, col: startCol + i + 1 }));
  }
  return segments;
}

function cityMilepost(cityName: string): Node {
  for (const point of loadGridPoints().values()) {
    if (isCityMilepostOf(point.row, point.col, cityName)) return { row: point.row, col: point.col };
  }
  throw new Error(`No city milepost found for ${cityName}`);
}

function firstMilepostWithTerrain(terrain: TerrainType): Node {
  for (const point of loadGridPoints().values()) {
    if (point.terrain === terrain) return { row: point.row, col: point.col };
  }
  throw new Error(`No milepost with terrain ${terrain}`);
}

describe('Movement enforcement (#312)', () => {
  const moverUserId = uuidv4();
  const opponentUserId = uuidv4();
  const userIds = [moverUserId, opponentUserId];
  const moverToken = tokenFor(moverUserId);

  // The mover's track: 13 mileposts in a straight line from START.
  const ROW = 1000;
  const START: Node = { row: ROW, col: 1000 };
  const at = (mileposts: number): Node => ({ row: ROW, col: START.col + mileposts });

  let gameId: string;
  let moverPlayerId: string;
  let opponentPlayerId: string;
  let gameIds: string[] = [];

  /** Creates an active game: the mover (current player) and an opponent. */
  async function createGame(opts: {
    position?: Node | null;
    trainType?: TrainType;
    moverSegments?: object[];
    opponentSegments?: object[];
    isBot?: boolean;
  } = {}): Promise<void> {
    gameId = uuidv4();
    moverPlayerId = uuidv4();
    opponentPlayerId = uuidv4();
    const position = opts.position === undefined ? START : opts.position;
    await runQuery(async (client) => {
      await client.query(
        'INSERT INTO games (id, status, current_player_index, created_by) VALUES ($1, $2, $3, $4)',
        [gameId, 'active', 0, moverUserId]
      );
      await client.query(
        `INSERT INTO players (id, user_id, game_id, name, color, money, train_type,
                              position_row, position_col, position_x, position_y,
                              current_turn_number, is_bot, created_at)
         VALUES ($1, $2, $3, 'Mover', '#ff0000', 50, $4, $5, $6, $7, $8, 1, $9, NOW())`,
        [
          moverPlayerId, moverUserId, gameId, opts.trainType ?? TrainType.Freight,
          position?.row ?? null, position?.col ?? null, position ? 0 : null, position ? 0 : null,
          opts.isBot ?? false,
        ]
      );
      await client.query(
        `INSERT INTO players (id, user_id, game_id, name, color, money, train_type, current_turn_number, created_at)
         VALUES ($1, $2, $3, 'Opponent', '#0000ff', 50, $4, 1, NOW() + interval '1 second')`,
        [opponentPlayerId, opponentUserId, gameId, TrainType.Freight]
      );
      const tracks: Array<[string, object[]]> = [
        [moverPlayerId, opts.moverSegments ?? line(ROW, START.col, 13)],
        [opponentPlayerId, opts.opponentSegments ?? []],
      ];
      for (const [playerId, segments] of tracks) {
        if (segments.length === 0) continue;
        await client.query(
          'INSERT INTO player_tracks (game_id, player_id, segments, total_cost) VALUES ($1, $2, $3, $4)',
          [gameId, playerId, JSON.stringify(segments), segments.length]
        );
      }
    });
    gameIds.push(gameId);
  }

  function move(to: Node, extra: Record<string, unknown> = {}): request.Test {
    return request(app)
      .post('/api/players/move-train')
      .set('Authorization', `Bearer ${moverToken}`)
      .send({ gameId, to: { ...to, x: 0, y: 0 }, ...extra });
  }

  async function moverRow(): Promise<any> {
    const result = await db.query('SELECT * FROM players WHERE id = $1', [moverPlayerId]);
    return result.rows[0];
  }

  async function storedCosts(turnNumber: number = 1): Promise<number[]> {
    const result = await db.query(
      'SELECT movement_path FROM movement_history WHERE player_id = $1 AND game_id = $2 AND turn_number = $3',
      [moverPlayerId, gameId, turnNumber]
    );
    const path: Array<{ cost: number }> = result.rows[0]?.movement_path ?? [];
    return path.map((seg) => seg.cost);
  }

  async function reportedRemainingMovement(): Promise<number> {
    const players = await PlayerService.getPlayers(gameId, moverUserId);
    const mover = players.find((p) => p.id === moverPlayerId);
    if (!mover) throw new Error('mover not found');
    return mover.trainState.remainingMovement;
  }

  beforeAll(async () => {
    await runQuery(async (client) => {
      for (const id of userIds) {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, true)',
          [id, `mv-${id.slice(0, 8)}`, `${id}@example.com`, 'hash']
        );
      }
    });
  });

  afterEach(async () => {
    await runQuery(async (client) => {
      await client.query('DELETE FROM turn_actions WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM movement_history WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM player_tracks WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM players WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    });
    gameIds = [];
    DemandDeckService.destroyAllInstances();
  });

  afterAll(async () => {
    await runQuery((client) => client.query('DELETE FROM users WHERE id = ANY($1)', [userIds]));
  });

  describe('speed limit', () => {
    it('rejects a move past the train speed and changes nothing', async () => {
      await createGame();

      const res = await move(at(10));

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/beyond the 9 of 9 mileposts left/);
      const row = await moverRow();
      expect(row.position_col).toBe(START.col);
      expect(await storedCosts()).toEqual([]);
      expect(await reportedRemainingMovement()).toBe(9);
    });

    it('allows a move of exactly the train speed, then nothing more', async () => {
      await createGame();

      const full = await move(at(9));
      expect(full.status).toBe(200);
      expect(full.body.milepostsMoved).toBe(9);
      expect(full.body.remainingMovement).toBe(0);

      const extra = await move(at(10));
      expect(extra.status).toBe(400);
      expect((await moverRow()).position_col).toBe(at(9).col);
      expect(await reportedRemainingMovement()).toBe(0);
    });

    it('uses the speed of the train type', async () => {
      await createGame({ trainType: TrainType.FastFreight });

      expect((await move(at(13))).status).toBe(400);
      const res = await move(at(12));
      expect(res.status).toBe(200);
      expect(res.body.milepostsMoved).toBe(12);
      expect(res.body.remainingMovement).toBe(0);
    });

    it('rejects repeated small moves once they sum past the limit', async () => {
      await createGame();

      expect((await move(at(4))).status).toBe(200);
      const second = await move(at(8));
      expect(second.status).toBe(200);
      expect(second.body.remainingMovement).toBe(1);

      // 2 more would make 10
      const third = await move(at(10));
      expect(third.status).toBe(400);
      expect(third.body.details).toMatch(/beyond the 1 of 9 mileposts left/);
      expect((await moverRow()).position_col).toBe(at(8).col);

      // the last milepost is still available
      expect((await move(at(9))).status).toBe(200);
      expect(await storedCosts()).toEqual([4, 4, 1]);
      expect(await reportedRemainingMovement()).toBe(0);
    });

    it('starts a new budget when the turn number changes', async () => {
      await createGame();
      expect((await move(at(9))).status).toBe(200);
      expect((await move(at(10))).status).toBe(400);

      // What endTurnForUser (humans) and BotTurnTrigger (bots) do between two turns of a player.
      await db.query('UPDATE players SET current_turn_number = 2 WHERE id = $1', [moverPlayerId]);

      expect(await reportedRemainingMovement()).toBe(9);
      const res = await move(at(13));
      expect(res.status).toBe(200);
      expect(res.body.milepostsMoved).toBe(4);
      expect(await storedCosts(1)).toEqual([9]);
      expect(await storedCosts(2)).toEqual([4]);
    });

    it('gives the movement back when the move is undone', async () => {
      await createGame();
      expect((await move(at(9))).status).toBe(200);

      const undo = await request(app)
        .post('/api/players/undo-last-action')
        .set('Authorization', `Bearer ${moverToken}`)
        .send({ gameId });
      expect(undo.status).toBe(200);
      expect(await reportedRemainingMovement()).toBe(9);

      expect((await move(at(9))).status).toBe(200);
      expect((await move(at(10))).status).toBe(400);
    });

    it('returns 400 for an unconnected destination', async () => {
      await createGame();
      const res = await move({ row: 1500, col: 1500 });
      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/No valid path/);
    });
  });

  describe('database connections', () => {
    // A pooled read inside the transaction needs a second connection while the first
    // holds the player and game row locks; under load that can exhaust the pool.
    // pool.query() checks a connection out through pool.connect(), so one connect()
    // call means everything ran on the transaction's own client.
    it('moves a train on a single connection', async () => {
      await createGame();
      const connectSpy = jest.spyOn(db, 'connect');
      try {
        const result = await PlayerService.moveTrainForUser({ gameId, userId: moverUserId, to: at(3) });
        expect(result.milepostsMoved).toBe(3);
        expect(connectSpy).toHaveBeenCalledTimes(1);
      } finally {
        connectSpy.mockRestore();
      }
    });

    it('checks a delivery on a single connection', async () => {
      await createGame({ position: cityMilepost('Berlin') });
      const connectSpy = jest.spyOn(db, 'connect');
      try {
        // Card 1 is not in the (empty) hand: the delivery is refused after the
        // restriction read, before any card is drawn.
        await expect(
          PlayerService.deliverLoadForUser(gameId, moverUserId, 'Berlin', 'Coal' as any, 1),
        ).rejects.toThrow('Demand card not in hand');
        expect(connectSpy).toHaveBeenCalledTimes(1);
      } finally {
        connectSpy.mockRestore();
      }
    });
  });

  describe('client movementCost', () => {
    it('ignores a negative movementCost', async () => {
      await createGame();

      const first = await move(at(5), { movementCost: -100 });
      expect(first.status).toBe(200);
      expect(first.body.milepostsMoved).toBe(5);
      expect(await storedCosts()).toEqual([5]);
      expect(await reportedRemainingMovement()).toBe(4);

      // 5 used, 4 left: the negative cost bought nothing
      expect((await move(at(10), { movementCost: -100 })).status).toBe(400);
    });

    it('ignores a zero movementCost', async () => {
      await createGame();

      expect((await move(at(5), { movementCost: 0 })).status).toBe(200);
      expect((await move(at(9), { movementCost: 0 })).status).toBe(200);
      expect(await storedCosts()).toEqual([5, 4]);
      expect(await reportedRemainingMovement()).toBe(0);
      expect((await move(at(10), { movementCost: 0 })).status).toBe(400);
    });

    it('ignores a movementCost that overstates the move', async () => {
      await createGame();

      expect((await move(at(2), { movementCost: 9 })).status).toBe(200);
      expect(await storedCosts()).toEqual([2]);
      expect((await move(at(9), { movementCost: 9 })).status).toBe(200);
    });

    it('does not let a negative cost already in the history raise the budget', async () => {
      await createGame();
      await db.query(
        'INSERT INTO movement_history (player_id, game_id, turn_number, movement_path) VALUES ($1, $2, 1, $3)',
        [moverPlayerId, gameId, JSON.stringify([{ from: null, to: START, cost: -50 }])]
      );

      expect(await reportedRemainingMovement()).toBe(9);
      expect((await move(at(10))).status).toBe(400);
      expect((await move(at(9))).status).toBe(200);
    });
  });

  describe('route choice', () => {
    // The mover's own route from START to at(5) is 5 mileposts; the opponent owns a direct shortcut.
    const shortcut = [segment(START, at(5))];

    it('uses the own route, with no fee, when it fits in the movement left', async () => {
      await createGame({ opponentSegments: shortcut });

      const res = await move(at(5));

      expect(res.status).toBe(200);
      expect(res.body.milepostsMoved).toBe(5);
      expect(res.body.feeTotal).toBe(0);
      expect((await moverRow()).money).toBe(50);
    });

    /** The train is at at(8), having already used 4 of its 9 mileposts coming from at(12). */
    async function createGameWithFiveMilepostsLeft(): Promise<void> {
      await createGame({ opponentSegments: shortcut, position: at(8) });
      await db.query(
        'INSERT INTO movement_history (player_id, game_id, turn_number, movement_path) VALUES ($1, $2, 1, $3)',
        [moverPlayerId, gameId, JSON.stringify([{ from: at(12), to: at(8), cost: 4 }])]
      );
    }

    async function opponentMoney(): Promise<number> {
      const result = await db.query('SELECT money FROM players WHERE id = $1', [opponentPlayerId]);
      return result.rows[0].money;
    }

    it('refuses the move, and charges nothing, when only an opponent shortcut the fee preview does not show would fit', async () => {
      await createGameWithFiveMilepostsLeft();

      // at(8) -> START with 5 left: the own line is 8 mileposts, too far. Own track to
      // at(5) and then the opponent shortcut would be 3 + 1 = 4, but the client's fee
      // preview (the unbounded own route) shows no fee, so that route is not taken.
      const res = await move(START);

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/beyond the 5 of 9 mileposts left/);
      const row = await moverRow();
      expect(row.money).toBe(50);
      expect(row.position_col).toBe(at(8).col);
      expect(await opponentMoney()).toBe(50);
      expect(await storedCosts()).toEqual([4]);
      const actions = await db.query('SELECT 1 FROM turn_actions WHERE game_id = $1', [gameId]);
      expect(actions.rows).toHaveLength(0);
    });

    it('takes the opponent shortcut, at no new fee, when that opponent was already paid this turn', async () => {
      await createGameWithFiveMilepostsLeft();
      await db.query(
        'INSERT INTO turn_actions (player_id, game_id, turn_number, actions) VALUES ($1, $2, 1, $3::jsonb)',
        [
          moverPlayerId,
          gameId,
          JSON.stringify([{
            kind: 'move',
            from: at(12),
            to: at(8),
            ownersPaid: [{ playerId: opponentPlayerId, amount: 4 }],
            feeTotal: 4,
          }]),
        ]
      );

      const res = await move(START);

      expect(res.status).toBe(200);
      expect(res.body.milepostsMoved).toBe(4);
      expect(res.body.feeTotal).toBe(0);
      expect((await moverRow()).money).toBe(50);
      expect(await opponentMoney()).toBe(50);
    });

    it('charges once for a route that needs opponent track, and not again for a second move over it', async () => {
      // Own track START..at(3); the only way on to at(7) is the opponent's line.
      await createGame({
        moverSegments: line(ROW, START.col, 3),
        opponentSegments: line(ROW, at(3).col, 4),
      });

      const first = await move(at(5));
      expect(first.status).toBe(200);
      expect(first.body.milepostsMoved).toBe(5);
      expect(first.body.feeTotal).toBe(4);
      expect(first.body.ownersPaid).toEqual([{ playerId: opponentPlayerId, amount: 4 }]);
      expect((await moverRow()).money).toBe(46);
      expect(await opponentMoney()).toBe(54);

      const second = await move(at(7));
      expect(second.status).toBe(200);
      expect(second.body.milepostsMoved).toBe(2);
      expect(second.body.feeTotal).toBe(0);
      expect((await moverRow()).money).toBe(46);
      expect(await opponentMoney()).toBe(54);
    });
  });

  describe('major city and ferry', () => {
    it('does not count movement inside one major city', async () => {
      // Berlin outpost -> centre -> outpost, no track
      await createGame({ position: { row: 24, col: 51 }, moverSegments: [] });

      const res = await move({ row: 24, col: 53 });

      expect(res.status).toBe(200);
      expect(res.body.milepostsMoved).toBe(0);
      expect(res.body.remainingMovement).toBe(9);
    });

    it('moves a bot that starts on a ferry port across at half rate (#314)', async () => {
      // The bot planner starts counting from the paired port, then calls moveTrainForUser
      // with the train still at the port it arrived at, and no movementCost.
      const ferry = getFerryEdges()[0];
      const landing: Node = { row: 2000, col: 2000 };
      const moverSegments = [segment(ferry.pointB, landing), ...line(2000, 2000, 9)];
      await createGame({ position: ferry.pointA, moverSegments, isBot: true });

      await expect(
        PlayerService.moveTrainForUser({ gameId, userId: moverUserId, to: { row: 2000, col: 2005 } }),
      ).rejects.toThrow(/Invalid move/);

      const result = await PlayerService.moveTrainForUser({
        gameId,
        userId: moverUserId,
        to: { row: 2000, col: 2004, x: 0, y: 0 },
      });

      expect(result.milepostsMoved).toBe(5);
      expect(result.remainingMovement).toBe(0);
      expect(result.halfRateApplied).toBe(true);
      expect((await moverRow()).position_col).toBe(2004);
    });
  });

  describe('first placement', () => {
    it('rejects a first placement on a milepost that is not a city', async () => {
      await createGame({ position: null });

      const res = await move(firstMilepostWithTerrain(TerrainType.Clear));

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/must start at a city/);
      expect((await moverRow()).position_row).toBeNull();
    });

    it.each([
      ['a ferry port', (): Node => firstMilepostWithTerrain(TerrainType.FerryPort)],
      ['a point off the map', (): Node => ({ row: 5000, col: 5000 })],
      // Having track there does not make it a city.
      ['a non-city point on the mover\'s own track', (): Node => at(3)],
    ])('rejects a first placement on %s as not a city', async (_label, destination) => {
      await createGame({ position: null });

      const res = await move(destination());

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/must start at a city/);
      expect((await moverRow()).position_row).toBeNull();
    });

    it('rejects coordinates that are not integers', async () => {
      await createGame({ position: null });

      const res = await move({ row: 24.5, col: 52 });

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(/Invalid destination/);
    });

    it.each([
      ['a major city centre', 'Berlin'],
      ['a medium city', 'Praha'],
      ['a small city', 'Lyon'],
    ])('accepts a first placement on %s, at no movement cost', async (_label, cityName) => {
      await createGame({ position: null });
      const city = cityMilepost(cityName);

      const res = await move(city);

      expect(res.status).toBe(200);
      expect(res.body.milepostsMoved).toBe(0);
      expect(res.body.remainingMovement).toBe(9);
      const row = await moverRow();
      expect({ row: row.position_row, col: row.position_col }).toEqual(city);
    });
  });

  describe('deliver-load', () => {
    const cardId = 1;

    function demand(): { city: string; resource: string; payment: number } {
      const card = DemandDeckService.getCard(cardId);
      if (!card) throw new Error('Expected demand card 1 to exist');
      return card.demands[0];
    }

    async function giveLoadAndCard(): Promise<void> {
      await db.query(
        'UPDATE players SET hand = $1, loads = $2 WHERE id = $3',
        [[cardId, 2, 3], [demand().resource], moverPlayerId]
      );
    }

    function deliver(): request.Test {
      const d = demand();
      return request(app)
        .post('/api/players/deliver-load')
        .set('Authorization', `Bearer ${moverToken}`)
        .send({ gameId, city: d.city, loadType: d.resource, cardId });
    }

    async function expectNothingDelivered(): Promise<void> {
      const row = await moverRow();
      expect(row.money).toBe(50);
      expect(row.loads).toEqual([demand().resource]);
      expect(row.hand).toEqual([cardId, 2, 3]);
    }

    it('rejects a delivery when the train is in another city', async () => {
      const wrongCity = demand().city === 'Berlin' ? 'Paris' : 'Berlin';
      await createGame({ position: cityMilepost(wrongCity) });
      await giveLoadAndCard();

      const res = await deliver();

      expect(res.status).toBe(400);
      expect(res.body.details).toBe(`Invalid delivery: train is not at ${demand().city}`);
      await expectNothingDelivered();
    });

    it('rejects a delivery when the train is not at a city', async () => {
      await createGame();
      await giveLoadAndCard();

      expect((await deliver()).status).toBe(400);
      await expectNothingDelivered();
    });

    it('rejects a delivery when the train has not been placed', async () => {
      await createGame({ position: null });
      await giveLoadAndCard();

      expect((await deliver()).status).toBe(400);
      await expectNothingDelivered();
    });

    it('accepts the delivery when the train is in the delivery city', async () => {
      await createGame({ position: cityMilepost(demand().city) });
      await giveLoadAndCard();

      const res = await deliver();

      // Asserted on the response, not the row: the replacement draw can turn up an
      // event card (Excess Profit Tax) that changes the stored money afterwards.
      expect(res.status).toBe(200);
      expect(res.body.payment).toBe(demand().payment);
      expect(res.body.updatedMoney).toBe(50 + demand().payment);
      expect(res.body.updatedLoads).toEqual([]);
    });
  });

  // ── #314 ───────────────────────────────────────────────────────────────────

  async function startNextTurn(): Promise<void> {
    await db.query('UPDATE players SET current_turn_number = current_turn_number + 1 WHERE id = $1', [moverPlayerId]);
  }

  describe('ferry crossing (#314)', () => {
    const ferry = getFerryEdges()[0];
    const landing: Node = { row: 2000, col: 2000 };
    const ferryTrack = (): object[] => [segment(ferry.pointB, landing), ...line(2000, 2000, 9)];

    it('crosses as the first move of the turn for no mileposts, then moves at half rate', async () => {
      await createGame({ position: ferry.pointA, moverSegments: ferryTrack() });

      const crossing = await move(ferry.pointB);
      expect(crossing.status).toBe(200);
      expect(crossing.body.milepostsMoved).toBe(0);
      expect(crossing.body.remainingMovement).toBe(5);
      expect(crossing.body.halfRateApplied).toBe(true);
      expect(await reportedRemainingMovement()).toBe(5);

      expect((await move({ row: 2000, col: 2005 })).status).toBe(400); // 6 mileposts
      const onward = await move({ row: 2000, col: 2004 });
      expect(onward.status).toBe(200);
      expect(onward.body.remainingMovement).toBe(0);
    });

    it('does not cross back in the same turn', async () => {
      await createGame({ position: ferry.pointA, moverSegments: ferryTrack() });
      expect((await move(ferry.pointB)).status).toBe(200);

      const back = await move(ferry.pointA);

      expect(back.status).toBe(400);
      expect(back.body.details).toMatch(/end its turn on a ferry port/);
      expect((await moverRow()).position_row).toBe(ferry.pointB.row);
    });

    it('makes a train that reaches the port wait for its next turn', async () => {
      await createGame({ position: { row: 2000, col: 2002 }, moverSegments: ferryTrack() });

      // straight through the ferry
      const through = await move(ferry.pointA);
      expect(through.status).toBe(400);
      expect(through.body.details).toMatch(/end its turn on a ferry port/);

      // to the port, then across in the same turn
      const toPort = await move(ferry.pointB);
      expect(toPort.status).toBe(200);
      expect(toPort.body.remainingMovement).toBe(6);
      expect((await move(ferry.pointA)).status).toBe(400);

      await startNextTurn();
      const crossing = await move(ferry.pointA);
      expect(crossing.status).toBe(200);
      expect(crossing.body.remainingMovement).toBe(5);
    });

    it('treats a port it does not cross from as an ordinary milepost', async () => {
      // track runs through port B: (2000,2002) .. landing .. port B .. (3000,1)
      const moverSegments = [...ferryTrack(), segment(ferry.pointB, { row: 3000, col: 1 })];
      await createGame({ position: { row: 2000, col: 2002 }, moverSegments });

      const res = await move({ row: 3000, col: 1 });

      expect(res.status).toBe(200);
      expect(res.body.milepostsMoved).toBe(4);
      expect(res.body.halfRateApplied).toBe(false);
    });

    it('lets the crossing be undone and made again', async () => {
      await createGame({ position: ferry.pointA, moverSegments: ferryTrack() });
      expect((await move(ferry.pointB)).status).toBe(200);

      const undo = await request(app)
        .post('/api/players/undo-last-action')
        .set('Authorization', `Bearer ${moverToken}`)
        .send({ gameId });
      expect(undo.status).toBe(200);
      expect(await reportedRemainingMovement()).toBe(9);

      expect((await move(ferry.pointB)).status).toBe(200);
    });
  });

  describe('reversal (#314)', () => {
    async function lastTraversedEdge(): Promise<{ from: Node; to: Node } | undefined> {
      const players = await PlayerService.getPlayers(gameId, moverUserId);
      return players.find((p) => p.id === moverPlayerId)?.trainState.lastTraversedEdge;
    }

    it('refuses to go straight back away from a city, and allows going on', async () => {
      await createGame();
      expect((await move(at(3))).status).toBe(200);

      const back = await move(at(2));
      expect(back.status).toBe(400);
      expect(back.body.details).toMatch(/can only reverse at cities or ferry ports/);
      expect((await moverRow()).position_col).toBe(at(3).col);
      expect(await lastTraversedEdge()).toMatchObject({ from: at(2), to: at(3) });

      expect((await move(at(5))).status).toBe(200);
      expect((await move(at(1))).status).toBe(400);
    });

    it('accepts a sharp turn onto a branch, one milepost at a time (#324)', async () => {
      // branch off at(1) whose row/col delta points "backwards" from the edge just travelled
      const branch: Node = { row: ROW + 1, col: START.col };
      await createGame({ moverSegments: [...line(ROW, START.col, 13), segment(at(1), branch)] });

      expect((await move(at(1))).status).toBe(200);
      expect((await move(branch)).status).toBe(200);
    });

    it('allows reversing on a city milepost', async () => {
      const city = cityMilepost('Berlin');
      await createGame({ moverSegments: [segment(at(0), at(1)), segment(at(1), city)] });

      expect((await move(city)).status).toBe(200);
      expect(await lastTraversedEdge()).toBeUndefined();
      expect((await move(at(0))).status).toBe(200);
    });

    it('keeps the direction into the next turn, and frees it after a turn standing still', async () => {
      await createGame();
      expect((await move(at(3))).status).toBe(200);

      await startNextTurn();
      expect((await move(at(1))).status).toBe(400);
      expect(await lastTraversedEdge()).toMatchObject({ from: at(2), to: at(3) });

      await startNextTurn();
      expect(await lastTraversedEdge()).toBeUndefined();
      expect((await move(at(1))).status).toBe(200);
    });

    it('restores the earlier direction when a move is undone', async () => {
      await createGame();
      expect((await move(at(3))).status).toBe(200);
      expect((await move(at(5))).status).toBe(200);
      await request(app)
        .post('/api/players/undo-last-action')
        .set('Authorization', `Bearer ${moverToken}`)
        .send({ gameId })
        .expect(200);

      expect((await move(at(2))).status).toBe(400);
      expect((await move(at(4))).status).toBe(200);
    });
  });
});
