/**
 * #308: server-validated track building.
 *   - POST /api/tracks/build         (caller's turn; body { gameId, path })
 *   - POST /api/tracks/undo-segment  (caller's turn; body { gameId })
 *   - PlayerService.buildTrackForPlayer (bots) through the same validation
 *
 * Mileposts used (row,col), all on the real map:
 * - Berlin mileposts (24,51), (23,51), (23,52); clear (24,50), (23,50), (25,50)
 *   next to (24,51); (23,52)->(23,53) crosses a river.
 * - Milano milepost (41,42) next to alpine (40,43) and mountain (41,43).
 * - Portsmouth–Le Havre ferry (4M): ports (21,28) and (25,29). London milepost
 *   (20,30) -> clear (20,29) -> port (21,28); far side (25,29), (25,30), (26,30).
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import app from '../app';
import { db } from '../db';
import { activeEffectManager } from '../services/ActiveEffectManager';
import { PlayerService } from '../services/playerService';
import { TrackService } from '../services/trackService';
import { TrackBuildError, TrackBuildErrorCode } from '../services/trackBuild';
import { getWaterCrossingExtraCost } from '../../shared/config/waterCrossings';
import { TerrainType, TrackSegment, TrainType } from '../../shared/types/GameTypes';

async function runQuery<T>(queryFn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await queryFn(client);
  } finally {
    client.release();
  }
}

function tokenFor(userId: string): string {
  // Set by the Jest setup file; no fallback, matching AuthService.
  const JWT_SECRET = process.env.JWT_SECRET as string;
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ userId, email: `${userId}@example.com`, username: userId, iat: now, exp: now + 15 * 60 }, JWT_SECRET);
}

type Coord = { row: number; col: number };
const p = (row: number, col: number): Coord => ({ row, col });
const water = (from: Coord, to: Coord): number => getWaterCrossingExtraCost(from, to);

/** A stored segment between two mileposts; pixel/terrain fields are not read by the rules. */
function seg(from: Coord, to: Coord, cost: number = 1): TrackSegment {
  return {
    from: { ...from, x: 0, y: 0, terrain: TerrainType.Clear },
    to: { ...to, x: 0, y: 0, terrain: TerrainType.Clear },
    cost,
  };
}

const edgesOf = (segments: TrackSegment[]): string[] =>
  segments.map((s: TrackSegment): string => `${s.from.row},${s.from.col}->${s.to.row},${s.to.col}`);

describe('Server-validated track building (#308)', () => {
  const firstId = uuidv4();
  const secondId = uuidv4();
  const outsiderId = uuidv4();
  const userIds = [firstId, secondId, outsiderId];
  const firstToken = tokenFor(firstId);
  const secondToken = tokenFor(secondId);
  const outsiderToken = tokenFor(outsiderId);

  let gameId: string;
  let firstPlayerId: string;
  let secondPlayerId: string;
  let gameIds: string[] = [];

  /** Creates a two-player game; the first player (seat 0) is on turn 3 with 50M. */
  async function createGame(
    opts: { status?: string; currentPlayerIndex?: number; money?: number } = {},
  ): Promise<void> {
    const { status = 'active', currentPlayerIndex = 0, money = 50 } = opts;
    gameId = uuidv4();
    firstPlayerId = uuidv4();
    secondPlayerId = uuidv4();
    await runQuery(async (client) => {
      await client.query(
        'INSERT INTO games (id, status, current_player_index, created_by) VALUES ($1, $2, $3, $4)',
        [gameId, status, currentPlayerIndex, firstId],
      );
      const seats: Array<[string, string, string, string, number]> = [
        [firstPlayerId, firstId, 'First', '#ff0000', money],
        [secondPlayerId, secondId, 'Second', '#0000ff', 50],
      ];
      for (let i = 0; i < seats.length; i++) {
        const [id, userId, name, color, seatMoney] = seats[i];
        await client.query(
          `INSERT INTO players (id, user_id, game_id, name, color, money, current_turn_number, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 3, NOW() + ($7 || ' seconds')::interval)`,
          [id, userId, gameId, name, color, seatMoney, String(i)],
        );
      }
    });
    gameIds.push(gameId);
  }

  /** Writes a player's track row directly, as track built on earlier turns. */
  async function storeTrack(playerId: string, segments: TrackSegment[], turnBuildCost: number = 0): Promise<void> {
    const totalCost = segments.reduce((sum: number, s: TrackSegment): number => sum + s.cost, 0);
    await db.query(
      `INSERT INTO player_tracks (game_id, player_id, segments, total_cost, turn_build_cost)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (game_id, player_id)
       DO UPDATE SET segments = $3, total_cost = $4, turn_build_cost = $5`,
      [gameId, playerId, JSON.stringify(segments), totalCost, turnBuildCost],
    );
  }

  async function trackRow(playerId: string): Promise<{ segments: TrackSegment[]; totalCost: number; turnBuildCost: number } | null> {
    const result = await db.query(
      'SELECT segments, total_cost, turn_build_cost FROM player_tracks WHERE game_id = $1 AND player_id = $2',
      [gameId, playerId],
    );
    if (result.rows.length === 0) return null;
    return {
      segments: result.rows[0].segments,
      totalCost: Number(result.rows[0].total_cost),
      turnBuildCost: Number(result.rows[0].turn_build_cost),
    };
  }

  async function moneyOf(playerId: string): Promise<number> {
    const result = await db.query('SELECT money FROM players WHERE id = $1', [playerId]);
    return Number(result.rows[0].money);
  }

  async function turnActions(playerId: string): Promise<Array<{ kind: string }>> {
    const result = await db.query(
      'SELECT actions FROM turn_actions WHERE game_id = $1 AND player_id = $2 AND turn_number = 3',
      [gameId, playerId],
    );
    return result.rows[0]?.actions ?? [];
  }

  function build(token: string | undefined, path: unknown, extra: object = {}): request.Test {
    const req = request(app).post('/api/tracks/build').send({ gameId, path, ...extra });
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  function undo(token?: string): request.Test {
    const req = request(app).post('/api/tracks/undo-segment').send({ gameId });
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  function settle(token: string): request.Test {
    return request(app)
      .post('/api/players/settle-build-cost')
      .set('Authorization', `Bearer ${token}`)
      .send({ gameId });
  }

  /**
   * Runs `action` while every pooled connection but one is held. A transaction
   * that reads through the pool as well as its own connection would wait on
   * the pool forever here, so the action is given a deadline.
   */
  async function withOneFreeConnection<T>(action: () => PromiseLike<T>): Promise<T> {
    const poolSize = parseInt(process.env.DB_MAX_CONNECTIONS || '10');
    const held: PoolClient[] = [];
    let timer: NodeJS.Timeout | undefined;
    let pending: Promise<T> | undefined;
    try {
      for (let i = 0; i < poolSize - 1; i++) {
        held.push(await db.connect());
      }
      pending = Promise.resolve(action());
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Request needed more than one pooled connection')), 3000);
      });
      return await Promise.race([pending, deadline]);
    } finally {
      clearTimeout(timer);
      held.forEach(client => client.release());
      // Let a stalled request finish now that connections are free.
      await pending?.then(() => undefined, () => undefined);
    }
  }

  beforeAll(async () => {
    await runQuery(async (client) => {
      for (const id of userIds) {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, true)',
          [id, `tb-${id.slice(0, 8)}`, `${id}@example.com`, 'hash'],
        );
      }
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await runQuery(async (client) => {
      await client.query('DELETE FROM turn_actions WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM player_tracks WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM players WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    });
    gameIds = [];
  });

  afterAll(async () => {
    await runQuery((client) => client.query('DELETE FROM users WHERE id = ANY($1)', [userIds]));
  });

  describe('POST /api/tracks/build — who may build', () => {
    const path = [p(24, 51), p(24, 50)];

    it('returns 401 without a token', async () => {
      await createGame();
      const res = await build(undefined, path);
      expect(res.status).toBe(401);
      expect(await trackRow(firstPlayerId)).toBeNull();
    });

    it('returns 400 without a valid gameId', async () => {
      const res = await request(app)
        .post('/api/tracks/build')
        .set('Authorization', `Bearer ${firstToken}`)
        .send({ gameId: 'not-a-uuid', path });
      expect(res.status).toBe(400);
    });

    it('returns 400 InvalidPath for a path that is not a list of mileposts', async () => {
      await createGame();
      for (const bad of [undefined, 'x', [p(24, 51)], [p(24, 51), { row: '24', col: 50 }]]) {
        const res = await build(firstToken, bad);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('InvalidPath');
      }
      expect(await trackRow(firstPlayerId)).toBeNull();
    });

    it('returns 403 for a user outside the game', async () => {
      await createGame();
      const res = await build(outsiderToken, path);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotAMember');
    });

    it('returns 403 when it is not the caller\'s turn', async () => {
      await createGame();
      const res = await build(secondToken, path);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotYourTurn');
      expect(await trackRow(secondPlayerId)).toBeNull();
    });

    it('returns 409 while the game is in setup', async () => {
      await createGame({ status: 'setup' });
      const res = await build(firstToken, path);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('WrongStatus');
    });

    it('builds during the initial build turns', async () => {
      await createGame({ status: 'initialBuild' });
      const res = await build(firstToken, path);
      expect(res.status).toBe(200);
      expect(res.body.cost).toBe(1);
    });

    it('builds for the session\'s player and ignores a client-sent playerId and costs', async () => {
      await createGame();
      const res = await build(
        firstToken,
        [{ row: 41, col: 42, cost: 0 }, { row: 40, col: 43, cost: 0, terrain: TerrainType.Clear }],
        { playerId: secondPlayerId, cost: 0, turnBuildCost: 0 },
      );
      expect(res.status).toBe(200);
      expect(res.body.cost).toBe(5); // alpine, priced by the server
      expect(await trackRow(secondPlayerId)).toBeNull();
      expect((await trackRow(firstPlayerId))?.segments).toHaveLength(1);
    });
  });

  describe('POST /api/tracks/build — legal builds', () => {
    it('builds from a major city milepost and defers the charge to settlement', async () => {
      await createGame();
      const res = await build(firstToken, [p(24, 51), p(24, 50)]);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ cost: 1, turnBuildCost: 1, money: 50 });
      expect(res.body.segments).toHaveLength(1);
      expect(res.body.segments[0]).toMatchObject({
        from: { row: 24, col: 51, terrain: TerrainType.MajorCity },
        to: { row: 24, col: 50, terrain: TerrainType.Clear },
        cost: 1,
      });

      const row = await trackRow(firstPlayerId);
      expect(row).toMatchObject({ totalCost: 1, turnBuildCost: 1 });
      expect(edgesOf(row!.segments)).toEqual(['24,51->24,50']);
      expect(await moneyOf(firstPlayerId)).toBe(50); // not charged yet
      expect((await turnActions(firstPlayerId)).map(a => a.kind)).toEqual(['build']);
    });

    it('is charged exactly once, at settlement', async () => {
      await createGame();
      expect((await build(firstToken, [p(41, 42), p(40, 43)])).status).toBe(200);

      const first = await settle(firstToken);
      expect(first.body).toMatchObject({ charged: 5, money: 45 });
      const again = await settle(firstToken);
      expect(again.body).toMatchObject({ charged: 0, money: 45 });
      expect(await moneyOf(firstPlayerId)).toBe(45);
      expect((await trackRow(firstPlayerId))?.turnBuildCost).toBe(0);
    });

    it('extends the player\'s own network; the path may run along existing track', async () => {
      await createGame();
      await storeTrack(firstPlayerId, [seg(p(24, 51), p(24, 50))]);

      const res = await build(firstToken, [p(24, 51), p(24, 50), p(23, 50)]);

      expect(res.status).toBe(200);
      expect(edgesOf(res.body.segments)).toEqual(['24,50->23,50']);
      expect(edgesOf((await trackRow(firstPlayerId))!.segments)).toEqual(['24,51->24,50', '24,50->23,50']);
    });

    it('adds the river surcharge', async () => {
      await createGame();
      const res = await build(firstToken, [p(23, 52), p(23, 53)]);
      expect(res.status).toBe(200);
      expect(res.body.cost).toBe(3); // clear 1 + river 2
    });

    it('charges the ferry on the first port and nothing on the second', async () => {
      await createGame();
      const toPort = await build(firstToken, [p(20, 30), p(20, 29), p(21, 28)]);
      expect(toPort.status).toBe(200);
      expect(toPort.body.segments.map((s: TrackSegment) => s.cost)).toEqual([
        1 + water(p(20, 30), p(20, 29)),
        4 + water(p(20, 29), p(21, 28)),
      ]);

      // Continue from the far port, then loop back into it: no second ferry charge.
      const farSide = await build(firstToken, [p(25, 29), p(25, 30), p(26, 30), p(25, 29)]);
      expect(farSide.status).toBe(200);
      expect(farSide.body.segments.map((s: TrackSegment) => s.cost)).toEqual([
        1 + water(p(25, 29), p(25, 30)),
        1 + water(p(25, 30), p(26, 30)),
        water(p(26, 30), p(25, 29)),
      ]);
      expect(farSide.body.turnBuildCost).toBe(toPort.body.cost + farSide.body.cost);
    });

    it('needs only one pooled connection', async () => {
      await createGame();
      const res = await withOneFreeConnection(() => build(firstToken, [p(24, 51), p(24, 50)]));
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/tracks/build — rejections change nothing', () => {
    async function expectRejected(res: request.Response, status: number, code: string): Promise<void> {
      expect(res.body.code).toBe(code);
      expect(res.status).toBe(status);
    }

    it('400 UnknownMilepost off the map', async () => {
      await createGame();
      await expectRejected(await build(firstToken, [p(24, 51), p(999, 999)]), 400, 'UnknownMilepost');
      expect(await trackRow(firstPlayerId)).toBeNull();
      expect(await turnActions(firstPlayerId)).toEqual([]);
    });

    it('400 NotAdjacent', async () => {
      await createGame();
      await expectRejected(await build(firstToken, [p(24, 51), p(24, 49)]), 400, 'NotAdjacent');
    });

    it('400 MajorCityRedArea inside a major city', async () => {
      await createGame();
      await expectRejected(await build(firstToken, [p(24, 51), p(23, 51)]), 400, 'MajorCityRedArea');
    });

    it('409 NotConnected away from the player\'s track and any major city', async () => {
      await createGame();
      await expectRejected(await build(firstToken, [p(24, 50), p(23, 50)]), 409, 'NotConnected');
    });

    it('409 NotConnected: a caller cannot claim track it does not have', async () => {
      await createGame();
      // The other player owns (24,51)->(24,50); a body field naming it as existing is ignored.
      await storeTrack(secondPlayerId, [seg(p(24, 51), p(24, 50))]);
      const res = await build(firstToken, [p(24, 50), p(23, 50)], {
        existingSegments: [seg(p(24, 51), p(24, 50))],
      });
      await expectRejected(res, 409, 'NotConnected');
    });

    it('409 RightOfWay over another player\'s track', async () => {
      await createGame();
      await storeTrack(secondPlayerId, [seg(p(24, 50), p(24, 51))]);
      await expectRejected(await build(firstToken, [p(24, 51), p(24, 50)]), 409, 'RightOfWay');
      expect(await trackRow(firstPlayerId)).toBeNull();
    });

    it('409 NothingToBuild when the whole path is already the player\'s track', async () => {
      await createGame();
      await storeTrack(firstPlayerId, [seg(p(24, 51), p(24, 50))]);
      await expectRejected(await build(firstToken, [p(24, 50), p(24, 51)]), 409, 'NothingToBuild');
    });

    it('409 MajorCityTurnLimit on a third section from one major city milepost, across requests', async () => {
      await createGame();
      expect((await build(firstToken, [p(24, 51), p(24, 50)])).status).toBe(200);
      expect((await build(firstToken, [p(24, 51), p(23, 50)])).status).toBe(200);
      await expectRejected(await build(firstToken, [p(24, 51), p(25, 50)]), 409, 'MajorCityTurnLimit');
      // Another milepost of the same city is still open.
      expect((await build(firstToken, [p(23, 51), p(22, 51)])).status).toBe(200);
      expect((await trackRow(firstPlayerId))!.segments).toHaveLength(3);
    });

    it('409 TurnBudgetExceeded, counting track already saved this turn', async () => {
      await createGame();
      await storeTrack(firstPlayerId, [seg(p(24, 51), p(24, 50), 16)], 16);
      await expectRejected(await build(firstToken, [p(41, 42), p(40, 43)]), 409, 'TurnBudgetExceeded');
      expect((await trackRow(firstPlayerId))!.segments).toHaveLength(1);
    });

    it('409 TurnBudgetExceeded still applies after a mid-turn settlement', async () => {
      await createGame();
      // 5M alpine + 2M mountain out of Milano, then 4+ more elsewhere, settle, and try to go past 20M.
      expect((await build(firstToken, [p(41, 42), p(40, 43)])).status).toBe(200);
      expect((await build(firstToken, [p(41, 42), p(41, 43)])).status).toBe(200);
      const ferry = await build(firstToken, [p(20, 30), p(20, 29), p(21, 28)]);
      expect(ferry.status).toBe(200);
      const spent = 7 + ferry.body.cost;
      expect((await settle(firstToken)).body.charged).toBe(spent);

      // Keep building out of Berlin (at most two sections per milepost) until
      // the server refuses: more track is on offer than the budget has left.
      const berlinPaths = [
        [p(24, 51), p(24, 50)], [p(24, 51), p(23, 50)], [p(23, 51), p(22, 51)], [p(23, 51), p(22, 52)],
        [p(25, 51), p(25, 50)], [p(25, 51), p(26, 51)], [p(23, 52), p(22, 53)], [p(25, 52), p(26, 53)],
        [p(25, 52), p(26, 52)], [p(23, 52), p(23, 53)],
      ];
      let total = spent;
      let rejected: request.Response | undefined;
      for (const berlinPath of berlinPaths) {
        const res = await build(firstToken, berlinPath);
        if (res.status !== 200) {
          rejected = res;
          break;
        }
        total += res.body.cost;
      }
      expect(rejected?.body.code).toBe('TurnBudgetExceeded');
      expect(total).toBeLessThanOrEqual(20);
      // The settlement zeroed turn_build_cost, so only the action log knows the turn's total.
      expect((await trackRow(firstPlayerId))!.turnBuildCost).toBe(total - spent);
    });

    it('409 InsufficientFunds, counting unsettled spend', async () => {
      await createGame({ money: 5 });
      expect((await build(firstToken, [p(41, 42), p(40, 43)])).status).toBe(200); // 5M, all the cash
      await expectRejected(await build(firstToken, [p(24, 51), p(24, 50)]), 409, 'InsufficientFunds');
      expect((await trackRow(firstPlayerId))!.segments).toHaveLength(1);
    });

    it('409 BUILD_BLOCKED while an event card forbids the player to build', async () => {
      await createGame();
      jest.spyOn(activeEffectManager, 'getBuildRestrictions').mockResolvedValue([
        { type: 'no_build_for_player', targetPlayerId: firstPlayerId },
      ]);
      await expectRejected(await build(firstToken, [p(24, 51), p(24, 50)]), 409, 'BUILD_BLOCKED');
      expect(await trackRow(firstPlayerId)).toBeNull();
      expect(await turnActions(firstPlayerId)).toEqual([]);
    });

    it('409 SNOW_BLOCKED_TERRAIN for a destination in a blocked zone', async () => {
      await createGame();
      jest.spyOn(activeEffectManager, 'getBuildRestrictions').mockResolvedValue([
        { type: 'blocked_terrain', zone: ['40,43'] },
      ]);
      await expectRejected(await build(firstToken, [p(41, 42), p(40, 43)]), 409, 'SNOW_BLOCKED_TERRAIN');
    });
  });

  describe('POST /api/tracks/undo-segment', () => {
    it('returns 401 without a token', async () => {
      await createGame();
      expect((await undo()).status).toBe(401);
    });

    it('returns 403 when it is not the caller\'s turn', async () => {
      await createGame();
      const res = await undo(secondToken);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotYourTurn');
    });

    it('returns 409 NoSegmentToUndo when nothing was built this turn', async () => {
      await createGame();
      await storeTrack(firstPlayerId, [seg(p(24, 51), p(24, 50))]); // earlier turns' track
      const res = await undo(firstToken);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NoSegmentToUndo');
      expect((await trackRow(firstPlayerId))!.segments).toHaveLength(1);
    });

    it('removes the last section built this turn and refunds it, one at a time', async () => {
      await createGame();
      await storeTrack(firstPlayerId, [seg(p(23, 52), p(22, 52))]); // earlier turns' track
      expect((await build(firstToken, [p(41, 42), p(41, 43)])).status).toBe(200); // 2M
      expect((await build(firstToken, [p(41, 42), p(40, 43)])).status).toBe(200); // 5M

      const first = await undo(firstToken);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ refunded: 5, turnBuildCost: 2, money: 50 });
      expect(first.body.removedSegment).toMatchObject({ from: { row: 41, col: 42 }, to: { row: 40, col: 43 } });
      expect(edgesOf((await trackRow(firstPlayerId))!.segments)).toEqual(['23,52->22,52', '41,42->41,43']);

      const second = await undo(firstToken);
      expect(second.body).toMatchObject({ refunded: 2, turnBuildCost: 0, money: 50 });
      const row = await trackRow(firstPlayerId);
      expect(edgesOf(row!.segments)).toEqual(['23,52->22,52']);
      expect(row).toMatchObject({ totalCost: 1, turnBuildCost: 0 });

      const third = await undo(firstToken);
      expect(third.status).toBe(409);
      expect(third.body.code).toBe('NoSegmentToUndo');
      expect(await moneyOf(firstPlayerId)).toBe(50);
      expect((await settle(firstToken)).body.charged).toBe(0);
    });

    it('frees the major-city slot and the budget of the undone section', async () => {
      await createGame();
      expect((await build(firstToken, [p(24, 51), p(24, 50)])).status).toBe(200);
      expect((await build(firstToken, [p(24, 51), p(23, 50)])).status).toBe(200);
      expect((await build(firstToken, [p(24, 51), p(25, 50)])).body.code).toBe('MajorCityTurnLimit');
      expect((await undo(firstToken)).status).toBe(200);
      expect((await build(firstToken, [p(24, 51), p(25, 50)])).status).toBe(200);
    });

    it('refunds money for a section that was already settled', async () => {
      await createGame();
      expect((await build(firstToken, [p(41, 42), p(40, 43)])).status).toBe(200);
      expect((await settle(firstToken)).body).toMatchObject({ charged: 5, money: 45 });

      const res = await undo(firstToken);
      expect(res.body).toMatchObject({ refunded: 5, turnBuildCost: 0, money: 50 });
      expect(await moneyOf(firstPlayerId)).toBe(50);
      expect((await trackRow(firstPlayerId))!.segments).toEqual([]);
    });

    it('refuses when the last action this turn is not a track build', async () => {
      await createGame();
      expect((await build(firstToken, [p(24, 51), p(24, 50)])).status).toBe(200);
      await db.query(
        `UPDATE turn_actions SET actions = actions || $1::jsonb
         WHERE game_id = $2 AND player_id = $3 AND turn_number = 3`,
        [JSON.stringify([{ kind: 'move', from: p(24, 51), ownersPaid: [], feeTotal: 0 }]), gameId, firstPlayerId],
      );
      const res = await undo(firstToken);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NoSegmentToUndo');
      expect((await trackRow(firstPlayerId))!.segments).toHaveLength(1);
    });

    it('needs only one pooled connection', async () => {
      await createGame();
      expect((await build(firstToken, [p(24, 51), p(24, 50)])).status).toBe(200);
      const res = await withOneFreeConnection(() => undo(firstToken));
      expect(res.status).toBe(200);
    });
  });

  describe('legacy POST /api/tracks/save keeps working alongside', () => {
    function save(segments: TrackSegment[], turnBuildCost: number): request.Test {
      return request(app).post('/api/tracks/save').send({
        gameId,
        playerId: firstPlayerId,
        trackState: {
          playerId: firstPlayerId, gameId, segments,
          totalCost: turnBuildCost, turnBuildCost, lastBuildTimestamp: new Date(),
        },
      });
    }

    it('track saved the old way is still charged once at settlement', async () => {
      await createGame();
      expect((await save([seg(p(24, 51), p(24, 50), 1)], 1)).status).toBe(200);
      expect((await settle(firstToken)).body).toMatchObject({ charged: 1, money: 49 });
      expect((await settle(firstToken)).body).toMatchObject({ charged: 0, money: 49 });
    });

    it('a turn that uses both routes is charged the sum, once', async () => {
      await createGame();
      expect((await save([seg(p(24, 51), p(24, 50), 1)], 1)).status).toBe(200);
      const res = await build(firstToken, [p(24, 50), p(23, 50)]);
      expect(res.body).toMatchObject({ cost: 1, turnBuildCost: 2, money: 50 });
      expect((await settle(firstToken)).body).toMatchObject({ charged: 2, money: 48 });
      expect((await settle(firstToken)).body).toMatchObject({ charged: 0, money: 48 });
    });
  });

  describe('PlayerService.buildTrackForPlayer (bots)', () => {
    // The second player stands in for a bot: the bot path takes a player id, not a session.
    it('ignores the caller\'s costs and charges the recomputed cost at once', async () => {
      await createGame();
      const result = await PlayerService.buildTrackForPlayer(gameId, secondPlayerId, [
        seg(p(41, 42), p(41, 43), 0),
        seg(p(41, 42), p(40, 43), 99),
      ]);

      expect(result).toMatchObject({ cost: 7, remainingMoney: 43 });
      expect(result.segments.map(s => s.cost)).toEqual([2, 5]);
      expect(await moneyOf(secondPlayerId)).toBe(43);
      const row = await trackRow(secondPlayerId);
      expect(row).toMatchObject({ totalCost: 7, turnBuildCost: 0 });
      expect(row!.segments[0]).toMatchObject({ from: { terrain: TerrainType.MajorCity }, to: { terrain: TerrainType.Mountain } });
    });

    it('cannot be charged a second time by a settlement', async () => {
      await createGame({ currentPlayerIndex: 1 });
      await PlayerService.buildTrackForPlayer(gameId, secondPlayerId, [seg(p(41, 42), p(40, 43))]);
      expect((await settle(secondToken)).body).toMatchObject({ charged: 0, money: 45 });
    });

    it('reads the bot\'s existing track from the database', async () => {
      await createGame();
      await storeTrack(secondPlayerId, [seg(p(24, 51), p(24, 50))]);
      const result = await PlayerService.buildTrackForPlayer(gameId, secondPlayerId, [seg(p(24, 50), p(23, 50))]);
      expect(result.cost).toBe(1);
      expect(edgesOf((await trackRow(secondPlayerId))!.segments)).toEqual(['24,51->24,50', '24,50->23,50']);
    });

    it('pays for a ferry line once', async () => {
      await createGame();
      const toPort = await PlayerService.buildTrackForPlayer(gameId, secondPlayerId, [
        seg(p(20, 30), p(20, 29)),
        seg(p(20, 29), p(21, 28), 4),
      ]);
      // The bot prices every port connection at the ferry cost; the server does not.
      const backIntoFarPort = await PlayerService.buildTrackForPlayer(gameId, secondPlayerId, [
        seg(p(25, 29), p(25, 30)),
        seg(p(25, 30), p(26, 30)),
        seg(p(26, 30), p(25, 29), 4),
      ]);
      expect(backIntoFarPort.segments[2].cost).toBe(water(p(26, 30), p(25, 29)));
      expect(await moneyOf(secondPlayerId)).toBe(50 - toPort.cost - backIntoFarPort.cost);
    });

    it.each([
      ['NotConnected', [seg(p(24, 50), p(23, 50))]],
      ['NotAdjacent', [seg(p(24, 51), p(24, 49))]],
      ['MajorCityRedArea', [seg(p(24, 51), p(23, 51))]],
      ['MajorCityTurnLimit', [seg(p(24, 51), p(24, 50)), seg(p(24, 51), p(23, 50)), seg(p(24, 51), p(25, 50))]],
    ])('rejects an illegal bot build with %s and changes nothing', async (code: string, segments: TrackSegment[]) => {
      await createGame();
      const attempt = PlayerService.buildTrackForPlayer(gameId, secondPlayerId, segments);
      await expect(attempt).rejects.toBeInstanceOf(TrackBuildError);
      await attempt.catch((error: TrackBuildError) => expect(TrackBuildErrorCode[error.code]).toBe(code));
      expect(await trackRow(secondPlayerId)).toBeNull();
      expect(await moneyOf(secondPlayerId)).toBe(50);
    });

    it('rejects a bot build over an opponent\'s track', async () => {
      await createGame();
      await storeTrack(firstPlayerId, [seg(p(24, 51), p(24, 50))]);
      await expect(
        PlayerService.buildTrackForPlayer(gameId, secondPlayerId, [seg(p(24, 50), p(24, 51))]),
      ).rejects.toMatchObject({ code: TrackBuildErrorCode.RightOfWay });
    });

    it('holds a bot to the 20M turn budget across several builds in one turn', async () => {
      await createGame();
      await PlayerService.buildTrackForPlayer(gameId, secondPlayerId, [
        seg(p(41, 42), p(40, 43)), // 5
        seg(p(41, 42), p(41, 43)), // 2
      ]);
      const ferry = await PlayerService.buildTrackForPlayer(gameId, secondPlayerId, [
        seg(p(20, 30), p(20, 29)),
        seg(p(20, 29), p(21, 28)),
      ]);
      const spent = 7 + ferry.cost;
      // A river crossing (3M) plus enough clear mileposts to pass 20M.
      const overBudget = [
        seg(p(23, 52), p(23, 53)),
        seg(p(24, 51), p(24, 50)), seg(p(24, 51), p(23, 50)),
        seg(p(23, 51), p(22, 51)), seg(p(23, 51), p(22, 52)),
        seg(p(25, 51), p(25, 50)), seg(p(25, 51), p(26, 51)),
      ];
      expect(spent + 3 + 6).toBeGreaterThan(20);
      await expect(
        PlayerService.buildTrackForPlayer(gameId, secondPlayerId, overBudget),
      ).rejects.toMatchObject({ code: TrackBuildErrorCode.TurnBudgetExceeded });
      expect(await moneyOf(secondPlayerId)).toBe(50 - spent);
    });

    it('needs only one pooled connection', async () => {
      await createGame();
      const result = await withOneFreeConnection(() =>
        PlayerService.buildTrackForPlayer(gameId, secondPlayerId, [seg(p(24, 51), p(24, 50))]),
      );
      expect(result.cost).toBe(1);
    });
  });

  describe('PlayerService.purchaseTrainType', () => {
    it('reads the turn\'s track spend on the transaction client, not the pool', async () => {
      await createGame();
      await db.query('UPDATE players SET train_type = $1 WHERE id = $2', [TrainType.Freight, firstPlayerId]);
      const trackRead = jest.spyOn(TrackService, 'getTrackState');
      try {
        const player = await PlayerService.purchaseTrainType(gameId, firstId, 'upgrade', TrainType.FastFreight);
        expect(player.trainType).toBe(TrainType.FastFreight);
        expect(await moneyOf(firstPlayerId)).toBe(30);
        // While the player row is locked, a pooled read would need a second connection.
        expect(trackRead).toHaveBeenCalledWith(gameId, firstPlayerId, expect.objectContaining({ query: expect.any(Function) }));
      } finally {
        trackRead.mockRestore();
      }
    });
  });
});
