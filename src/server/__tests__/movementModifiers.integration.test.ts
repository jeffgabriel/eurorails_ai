/**
 * #313: server-enforced movement modifiers.
 *   - POST /api/players/move-train under Snow (half rate, blocked mileposts)
 *     and the Rail Strike (#123)
 *   - Derailment lost turns at turn advancement
 *   - a bot's move (PlayerService.moveTrainForUser) under an active effect
 *
 * Effects are stored through ActiveEffectManager.addActiveEffect, the same call
 * the event card pipeline makes, so the tests read the restrictions the server
 * really persists.
 *
 * Isolation and cleanup (real database, shared with the other integration suites):
 *   - beforeAll inserts this suite's two users; afterAll deletes them by id.
 *   - Each test builds its own game with createGame(), which records the game id.
 *   - afterEach deletes only this suite's games, children first.
 *   - Rows are always selected by this suite's ids, never table-wide.
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import app from '../app';
import { db } from '../db';
import { PlayerService } from '../services/playerService';
import { DemandDeckService } from '../services/demandDeckService';
import { activeEffectManager } from '../services/ActiveEffectManager';
import { AreaOfEffectService } from '../services/AreaOfEffectService';
import { loadGridPoints } from '../services/MapTopology';
import { EventCardType, PerPlayerEffect, SnowEffect } from '../../shared/types/EventCard';
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

const keyOf = (node: Node): string => `${node.row},${node.col}`;

describe('Movement modifiers (#313)', () => {
  const moverUserId = uuidv4();
  const opponentUserId = uuidv4();
  const userIds = [moverUserId, opponentUserId];
  const moverToken = tokenFor(moverUserId);

  // The default track: 13 mileposts in a straight line from START, owned by the mover.
  const ROW = 3000;
  const START: Node = { row: ROW, col: 3000 };
  const at = (mileposts: number): Node => ({ row: ROW, col: START.col + mileposts });
  const zoneFrom = (first: number, last: number): string[] => {
    const keys: string[] = [];
    for (let i = first; i <= last; i++) keys.push(keyOf(at(i)));
    return keys;
  };

  let gameId: string;
  let moverPlayerId: string;
  let opponentPlayerId: string;
  let gameIds: string[] = [];

  /** Creates an active game: the mover (index 0, current player) and an opponent (index 1). */
  async function createGame(opts: {
    position?: Node;
    trainType?: TrainType;
    moverSegments?: object[];
    opponentSegments?: object[];
    isBot?: boolean;
  } = {}): Promise<void> {
    gameId = uuidv4();
    moverPlayerId = uuidv4();
    opponentPlayerId = uuidv4();
    const position = opts.position ?? START;
    await runQuery(async (client) => {
      await client.query(
        'INSERT INTO games (id, status, current_player_index, created_by) VALUES ($1, $2, $3, $4)',
        [gameId, 'active', 0, moverUserId]
      );
      await client.query(
        `INSERT INTO players (id, user_id, game_id, name, color, money, train_type,
                              position_row, position_col, position_x, position_y,
                              current_turn_number, is_bot, created_at)
         VALUES ($1, $2, $3, 'Mover', '#ff0000', 50, $4, $5, $6, 0, 0, 1, $7, NOW())`,
        [moverPlayerId, moverUserId, gameId, opts.trainType ?? TrainType.Freight, position.row, position.col, opts.isBot ?? false]
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

  /** Stores an active effect the way the event card pipeline does. */
  async function addEffect(
    cardType: EventCardType,
    opts: {
      cardId: number;
      drawnBy?: 'mover' | 'opponent';
      affectedZone?: string[];
      blockedTerrainZone?: string[];
      lostTurnPlayerIds?: string[];
    },
  ): Promise<void> {
    const drawnByMover = (opts.drawnBy ?? 'opponent') === 'mover';
    const perPlayerEffects: PerPlayerEffect[] = (opts.lostTurnPlayerIds ?? []).map((playerId) => ({
      playerId,
      effectType: 'turn_lost' as const,
      details: 'test',
    }));
    await runQuery(async (client) => {
      await client.query('BEGIN');
      try {
        await activeEffectManager.addActiveEffect(
          gameId,
          {
            cardId: opts.cardId,
            drawingPlayerId: drawnByMover ? moverPlayerId : opponentPlayerId,
            drawingPlayerIndex: drawnByMover ? 0 : 1,
            expiresAfterTurnNumber: 99,
            affectedZone: opts.affectedZone ?? [],
            blockedTerrainZone: opts.blockedTerrainZone,
          },
          cardType,
          perPlayerEffects,
          client,
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  }

  function move(to: Node): request.Test {
    return request(app)
      .post('/api/players/move-train')
      .set('Authorization', `Bearer ${moverToken}`)
      .send({ gameId, to: { ...to, x: 0, y: 0 } });
  }

  async function moverRow(): Promise<any> {
    const result = await db.query('SELECT * FROM players WHERE id = $1', [moverPlayerId]);
    return result.rows[0];
  }

  async function storedSegments(): Promise<Array<{ cost: number; remainingAfter: number; halfRate: boolean }>> {
    const result = await db.query(
      'SELECT movement_path FROM movement_history WHERE player_id = $1 AND game_id = $2 AND turn_number = 1',
      [moverPlayerId, gameId]
    );
    return result.rows[0]?.movement_path ?? [];
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
          [id, `mm-${id.slice(0, 8)}`, `${id}@example.com`, 'hash']
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

  describe('Snow: half rate from the start of a turn', () => {
    it('limits a Freight that starts in the zone to 5 mileposts', async () => {
      await createGame();
      await addEffect(EventCardType.Snow, { cardId: 131, affectedZone: zoneFrom(0, 13), blockedTerrainZone: [] });

      expect(await reportedRemainingMovement()).toBe(5);

      const tooFar = await move(at(6));
      expect(tooFar.status).toBe(409);
      expect(tooFar.body.code).toBe('SNOW_HALF_RATE_EXCEEDED');
      expect((await moverRow()).position_col).toBe(START.col);
      expect(await storedSegments()).toEqual([]);

      const res = await move(at(5));
      expect(res.status).toBe(200);
      expect(res.body.milepostsMoved).toBe(5);
      expect(res.body.remainingMovement).toBe(0);
      expect(res.body.halfRateApplied).toBe(true);
      expect(await reportedRemainingMovement()).toBe(0);
    });

    it('limits a Heavy Freight to 5 and a Fast Freight and a Superfreight to 6', async () => {
      const cases: Array<[TrainType, number]> = [
        [TrainType.HeavyFreight, 5],
        [TrainType.FastFreight, 6],
        [TrainType.Superfreight, 6],
      ];
      for (const [trainType, limit] of cases) {
        await createGame({ trainType });
        await addEffect(EventCardType.Snow, { cardId: 132, affectedZone: zoneFrom(0, 13), blockedTerrainZone: [] });

        expect(await reportedRemainingMovement()).toBe(limit);
        expect((await move(at(limit + 1))).status).toBe(409);
        const res = await move(at(limit));
        expect(res.status).toBe(200);
        expect(res.body.remainingMovement).toBe(0);
      }
    });

    it('applies half rate once: leaving the zone does not restore movement, re-entering does not halve again', async () => {
      await createGame();
      // in the zone at mileposts 0-1 and again from 4 on
      await addEffect(EventCardType.Snow, {
        cardId: 131,
        affectedZone: [...zoneFrom(0, 1), ...zoneFrom(4, 13)],
        blockedTerrainZone: [],
      });

      const res = await move(at(5));
      expect(res.status).toBe(200);
      expect(res.body.remainingMovement).toBe(0);
      expect((await move(at(6))).status).toBe(400); // already at half rate: plain "beyond the movement left"
    });

    it('counts split moves the same as one move', async () => {
      await createGame();
      await addEffect(EventCardType.Snow, { cardId: 131, affectedZone: zoneFrom(0, 13), blockedTerrainZone: [] });

      const first = await move(at(2));
      expect(first.status).toBe(200);
      expect(first.body.remainingMovement).toBe(3);
      expect(await reportedRemainingMovement()).toBe(3);
      expect((await move(at(6))).status).toBe(400);
      const second = await move(at(5));
      expect(second.status).toBe(200);
      expect(second.body.remainingMovement).toBe(0);
    });

    // The three Snow cards, with the zones EventCardService.processSnow stores for them.
    it.each([130, 131, 132])('card #%i: a train inside the real zone moves at half rate', async (cardId) => {
      const card = DemandDeckService.getAllEventCards().find((c) => c.id === cardId);
      if (!card) throw new Error(`event card ${cardId} not found`);
      const effect = card.effectConfig as SnowEffect;
      const halfRateZone = AreaOfEffectService.getZoneAroundCity(effect.centerCity, effect.radius);
      const blockedZone = AreaOfEffectService.getZoneAroundCity(effect.centerCity, effect.radius, effect.blockedTerrain);
      expect(halfRateZone.size).toBeGreaterThan(0);
      expect(blockedZone.size).toBeGreaterThan(0);

      // A clear milepost inside the zone, joined to an off-map line by the mover's track.
      const grid = loadGridPoints();
      const startKey = Array.from(halfRateZone).find((k) => grid.get(k)?.terrain === TerrainType.Clear);
      if (!startKey) throw new Error('no clear milepost in the zone');
      const [row, col] = startKey.split(',').map(Number);
      const inZone: Node = { row, col };
      await createGame({ position: inZone, moverSegments: [segment(inZone, at(0)), ...line(ROW, START.col, 12)] });
      await addEffect(EventCardType.Snow, {
        cardId,
        affectedZone: Array.from(halfRateZone),
        blockedTerrainZone: Array.from(blockedZone),
      });

      expect(await reportedRemainingMovement()).toBe(5);
      expect((await move(at(5))).status).toBe(409); // 6 mileposts
      const res = await move(at(4)); // 5 mileposts
      expect(res.status).toBe(200);
      expect(res.body.milepostsMoved).toBe(5);
      expect(res.body.remainingMovement).toBe(0);

      // A milepost of the card's blocked terrain inside the zone cannot be moved into.
      const blockedKey = Array.from(blockedZone)[0];
      expect(effect.blockedTerrain).toContain(grid.get(blockedKey)?.terrain);
    });
  });

  describe('Snow: half rate starting mid-turn', () => {
    it('halves the rest, rounding up, when a single move enters the zone', async () => {
      await createGame();
      // zone from milepost 4: after 4 mileposts 5 are left, halved to 3 -> milepost 7 at most
      await addEffect(EventCardType.Snow, { cardId: 131, affectedZone: zoneFrom(4, 13), blockedTerrainZone: [] });

      expect(await reportedRemainingMovement()).toBe(9);
      const tooFar = await move(at(8));
      expect(tooFar.status).toBe(409);
      expect(tooFar.body.code).toBe('SNOW_HALF_RATE_EXCEEDED');

      const res = await move(at(7));
      expect(res.status).toBe(200);
      expect(res.body.milepostsMoved).toBe(7);
      expect(res.body.remainingMovement).toBe(0);
      expect(res.body.halfRateApplied).toBe(true);
    });

    it('halves the rest when a later move of the turn enters the zone', async () => {
      await createGame();
      await addEffect(EventCardType.Snow, { cardId: 131, affectedZone: zoneFrom(4, 13), blockedTerrainZone: [] });

      const outside = await move(at(2));
      expect(outside.body.remainingMovement).toBe(7);
      expect(outside.body.halfRateApplied).toBe(false);

      const entering = await move(at(4));
      expect(entering.status).toBe(200);
      expect(entering.body.remainingMovement).toBe(3); // 5 left on entering, halved, rounded up
      expect(await reportedRemainingMovement()).toBe(3);
      expect(await storedSegments()).toEqual([
        expect.objectContaining({ cost: 2, remainingAfter: 7, halfRate: false }),
        expect.objectContaining({ cost: 2, remainingAfter: 3, halfRate: true }),
      ]);

      expect((await move(at(8))).status).toBe(400);
      expect((await move(at(7))).status).toBe(200);
    });

    it('rounds an odd remainder up for a Fast Freight (7 left -> 4)', async () => {
      await createGame({ trainType: TrainType.FastFreight });
      await addEffect(EventCardType.Snow, { cardId: 132, affectedZone: zoneFrom(5, 13), blockedTerrainZone: [] });

      const res = await move(at(5));
      expect(res.body.remainingMovement).toBe(4);
      expect((await move(at(10))).status).toBe(400);
      expect((await move(at(9))).status).toBe(200);
    });

    it('halves what is left when the card is drawn after the train has moved', async () => {
      await createGame();

      const before = await move(at(4));
      expect(before.body.remainingMovement).toBe(5);

      // Snow is drawn mid-turn (a delivery draws a card) and covers the train.
      await addEffect(EventCardType.Snow, { cardId: 131, affectedZone: zoneFrom(0, 13), blockedTerrainZone: [] });

      expect(await reportedRemainingMovement()).toBe(3);
      expect((await move(at(8))).status).toBe(409);
      const res = await move(at(7));
      expect(res.status).toBe(200);
      expect(res.body.remainingMovement).toBe(0);
    });

    it('gives the movement back, un-halved, when the move into the zone is undone', async () => {
      await createGame();
      await addEffect(EventCardType.Snow, { cardId: 131, affectedZone: zoneFrom(4, 13), blockedTerrainZone: [] });

      expect((await move(at(4))).status).toBe(200);
      expect(await reportedRemainingMovement()).toBe(3);

      const undo = await request(app)
        .post('/api/players/undo-last-action')
        .set('Authorization', `Bearer ${moverToken}`)
        .send({ gameId });
      expect(undo.status).toBe(200);
      expect(await reportedRemainingMovement()).toBe(9);
      expect((await move(at(3))).status).toBe(200);
      expect(await reportedRemainingMovement()).toBe(6);
    });
  });

  describe('Snow: blocked mileposts', () => {
    it('rejects a move into a blocked milepost', async () => {
      await createGame();
      await addEffect(EventCardType.Snow, {
        cardId: 130,
        affectedZone: zoneFrom(3, 6),
        blockedTerrainZone: [keyOf(at(3))],
      });

      const res = await move(at(3));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SNOW_BLOCKED_TERRAIN');
      expect((await moverRow()).position_col).toBe(START.col);
    });

    it('rejects a move whose only route passes through a blocked milepost', async () => {
      await createGame();
      await addEffect(EventCardType.Snow, {
        cardId: 130,
        affectedZone: zoneFrom(3, 6),
        blockedTerrainZone: [keyOf(at(3))],
      });

      const res = await move(at(5));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SNOW_BLOCKED_TERRAIN');
      expect((await moverRow()).position_col).toBe(START.col);
      expect(await storedSegments()).toEqual([]);

      // short of the blocked milepost is still fine
      expect((await move(at(2))).status).toBe(200);
    });

    it('takes a route around the blocked milepost when there is one', async () => {
      const detour = [
        segment(at(2), { row: ROW + 1, col: START.col + 2 }),
        segment({ row: ROW + 1, col: START.col + 2 }, { row: ROW + 1, col: START.col + 3 }),
        segment({ row: ROW + 1, col: START.col + 3 }, { row: ROW + 1, col: START.col + 4 }),
        segment({ row: ROW + 1, col: START.col + 4 }, at(4)),
      ];
      await createGame({ moverSegments: [...line(ROW, START.col, 13), ...detour] });
      await addEffect(EventCardType.Snow, { cardId: 130, affectedZone: [], blockedTerrainZone: [keyOf(at(3))] });

      const res = await move(at(4));
      expect(res.status).toBe(200);
      expect(res.body.milepostsMoved).toBe(6); // 4 direct, 6 around
    });
  });

  describe('Rail Strike #123', () => {
    it('stops the drawing player moving on their own track', async () => {
      await createGame();
      await addEffect(EventCardType.Strike, { cardId: 123, drawnBy: 'mover' });

      const res = await move(at(1));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('RAIL_STRIKE_BLOCKED');
      expect((await moverRow()).position_col).toBe(START.col);
      expect(await storedSegments()).toEqual([]);
    });

    it('stops another player moving on the drawing player track, and charges nothing', async () => {
      // the mover stands on the opponent's line; the opponent drew the strike
      await createGame({ moverSegments: [], opponentSegments: line(ROW, START.col, 13) });
      await addEffect(EventCardType.Strike, { cardId: 123, drawnBy: 'opponent' });

      const res = await move(at(2));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('RAIL_STRIKE_BLOCKED');
      const row = await moverRow();
      expect(row.position_col).toBe(START.col);
      expect(row.money).toBe(50);
    });

    it('lets other players move on their own track', async () => {
      await createGame();
      await addEffect(EventCardType.Strike, { cardId: 123, drawnBy: 'opponent' });

      const res = await move(at(9));
      expect(res.status).toBe(200);
      expect(res.body.milepostsMoved).toBe(9);
    });

    it('uses the own route instead of a struck shortcut', async () => {
      // own route START -> at(1) is 3 mileposts over row ROW+1; the opponent's direct edge is 1
      const own = [
        segment(at(0), { row: ROW + 1, col: START.col }),
        segment({ row: ROW + 1, col: START.col }, { row: ROW + 1, col: START.col + 1 }),
        segment({ row: ROW + 1, col: START.col + 1 }, at(1)),
      ];
      await createGame({ moverSegments: own, opponentSegments: [segment(at(0), at(1))] });
      await addEffect(EventCardType.Strike, { cardId: 123, drawnBy: 'opponent' });

      const res = await move(at(1));
      expect(res.status).toBe(200);
      expect(res.body.milepostsMoved).toBe(3);
      expect(res.body.feeTotal).toBe(0);
    });

    /** The opponent's 3-milepost detour from START to at(1) over row ROW+1. */
    const opponentDetour = (): object[] => [
      segment(at(0), { row: ROW + 1, col: START.col }),
      segment({ row: ROW + 1, col: START.col }, { row: ROW + 1, col: START.col + 1 }),
      segment({ row: ROW + 1, col: START.col + 1 }, at(1)),
    ];

    async function expectNothingCharged(): Promise<void> {
      const row = await moverRow();
      expect(row.position_col).toBe(START.col);
      expect(row.money).toBe(50);
      const opponent = await db.query('SELECT money FROM players WHERE id = $1', [opponentPlayerId]);
      expect(opponent.rows[0].money).toBe(50);
      expect(await storedSegments()).toEqual([]);
      const actions = await db.query('SELECT 1 FROM turn_actions WHERE game_id = $1', [gameId]);
      expect(actions.rows).toHaveLength(0);
    }

    it('refuses a detour around struck track over an opponent the fee preview does not show, and charges nothing', async () => {
      // The mover's own line is struck. The opponent's detour would reach at(1), but the
      // client's fee preview (the own route, which ignores the strike) shows no fee.
      await createGame({ opponentSegments: opponentDetour() });
      await addEffect(EventCardType.Strike, { cardId: 123, drawnBy: 'mover' });

      const res = await move(at(1));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('RAIL_STRIKE_BLOCKED');
      await expectNothingCharged();
    });

    it('refuses a detour around a Snow block over an opponent the fee preview does not show, and charges nothing', async () => {
      // The mover's own line is blocked at at(1); the opponent's track goes round it
      // over row ROW+1 and rejoins at at(2).
      const aroundTheBlock = [
        segment(at(0), { row: ROW + 1, col: START.col }),
        segment({ row: ROW + 1, col: START.col }, { row: ROW + 1, col: START.col + 1 }),
        segment({ row: ROW + 1, col: START.col + 1 }, { row: ROW + 1, col: START.col + 2 }),
        segment({ row: ROW + 1, col: START.col + 2 }, at(2)),
      ];
      await createGame({ opponentSegments: aroundTheBlock });
      await addEffect(EventCardType.Snow, { cardId: 131, affectedZone: [], blockedTerrainZone: [keyOf(at(1))] });

      const res = await move(at(2));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SNOW_BLOCKED_TERRAIN');
      await expectNothingCharged();
    });

    it('does not restrict movement for a coastal strike (#121/#122)', async () => {
      await createGame();
      await addEffect(EventCardType.Strike, { cardId: 121, drawnBy: 'mover', affectedZone: zoneFrom(0, 13) });

      expect((await move(at(9))).status).toBe(200);
    });
  });

  describe('Derailment: lost turn', () => {
    it('skips the turn of a player with a pending lost turn and consumes it', async () => {
      await createGame();
      await addEffect(EventCardType.Derailment, {
        cardId: 125,
        drawnBy: 'opponent',
        affectedZone: [keyOf(START)],
        lostTurnPlayerIds: [opponentPlayerId],
      });

      // The mover ends the turn; the opponent (index 1) is next but has lost the turn.
      const result = await PlayerService.endTurnForUser(gameId, moverUserId);

      expect(result.currentPlayerIndex).toBe(0);
      const game = await db.query('SELECT current_player_index, active_event FROM games WHERE id = $1', [gameId]);
      expect(game.rows[0].current_player_index).toBe(0);
      const derailment = (game.rows[0].active_event ?? []).find((e: { cardId: number }) => e.cardId === 125);
      expect(derailment?.pendingLostTurns ?? []).toEqual([]);

      // The lost turn is lost once: the next time round the opponent plays.
      const again = await PlayerService.endTurnForUser(gameId, moverUserId);
      expect(again.currentPlayerIndex).toBe(1);
    });

    it('does not let the skipped player move during the lost turn', async () => {
      await createGame({ opponentSegments: line(ROW + 5, START.col, 3) });
      await db.query('UPDATE players SET position_row = $1, position_col = $2, position_x = 0, position_y = 0 WHERE id = $3', [
        ROW + 5, START.col, opponentPlayerId,
      ]);
      await addEffect(EventCardType.Derailment, {
        cardId: 126,
        drawnBy: 'mover',
        lostTurnPlayerIds: [opponentPlayerId],
      });
      await PlayerService.endTurnForUser(gameId, moverUserId);

      const res = await request(app)
        .post('/api/players/move-train')
        .set('Authorization', `Bearer ${tokenFor(opponentUserId)}`)
        .send({ gameId, to: { row: ROW + 5, col: START.col + 1, x: 0, y: 0 } });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const opponent = await db.query('SELECT position_col FROM players WHERE id = $1', [opponentPlayerId]);
      expect(opponent.rows[0].position_col).toBe(START.col);
    });
  });

  describe('crossgrade and movement in one turn', () => {
    function purchase(kind: 'upgrade' | 'crossgrade', targetTrainType: TrainType): request.Test {
      return request(app)
        .post('/api/players/upgrade-train')
        .set('Authorization', `Bearer ${moverToken}`)
        .send({ gameId, kind, targetTrainType });
    }

    it('refuses a crossgrade after the train has moved this turn', async () => {
      await createGame({ trainType: TrainType.FastFreight });
      expect((await move(at(8))).status).toBe(200);

      const res = await purchase('crossgrade', TrainType.HeavyFreight);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const row = await moverRow();
      expect(row.train_type).toBe(TrainType.FastFreight);
      expect(Number(row.money)).toBe(50);

      // The Fast Freight keeps the 4 mileposts it had left.
      expect((await move(at(12))).status).toBe(200);
    });

    it('allows crossgrade then move, at the new train\'s speed', async () => {
      await createGame({ trainType: TrainType.FastFreight });
      expect((await purchase('crossgrade', TrainType.HeavyFreight)).status).toBe(200);

      expect((await move(at(10))).status).toBe(400);
      const res = await move(at(9));
      expect(res.status).toBe(200);
      expect(res.body.remainingMovement).toBe(0);
    });

    it('still allows an upgrade after moving', async () => {
      await createGame();
      expect((await move(at(9))).status).toBe(200);
      expect((await purchase('upgrade', TrainType.FastFreight)).status).toBe(200);
      expect((await moverRow()).train_type).toBe(TrainType.FastFreight);
    });
  });

  describe('bots under an active effect', () => {
    it('holds a bot that starts in a Snow zone to half rate', async () => {
      await createGame({ isBot: true });
      await addEffect(EventCardType.Snow, { cardId: 131, affectedZone: zoneFrom(0, 13), blockedTerrainZone: [] });

      await expect(
        PlayerService.moveTrainForUser({ gameId, userId: moverUserId, to: { ...at(6), x: 0, y: 0 } }),
      ).rejects.toMatchObject({ code: 'SNOW_HALF_RATE_EXCEEDED' });

      const result = await PlayerService.moveTrainForUser({ gameId, userId: moverUserId, to: { ...at(5), x: 0, y: 0 } });
      expect(result.milepostsMoved).toBe(5);
      expect(result.remainingMovement).toBe(0);
      expect((await moverRow()).position_col).toBe(at(5).col);
    });

    it('lets a bot keep moving on its own track during another player strike', async () => {
      await createGame({ isBot: true });
      await addEffect(EventCardType.Strike, { cardId: 123, drawnBy: 'opponent' });

      const result = await PlayerService.moveTrainForUser({ gameId, userId: moverUserId, to: { ...at(9), x: 0, y: 0 } });
      expect(result.milepostsMoved).toBe(9);
    });
  });
});
