import { v4 as uuidv4 } from 'uuid';
import { db } from '../db';
import { PlayerService } from '../services/playerService';
import { DemandDeckService } from '../services/demandDeckService';
import { TrainType } from '../../shared/types/GameTypes';
import { LoadType } from '../../shared/types/LoadTypes';

// Force Jest to run this test file serially
export const test = { concurrent: false };

/**
 * Integration tests for per-game deck persistence (issue #237).
 *
 * `DemandDeckService.destroyAllInstances()` stands in for a server restart:
 * it drops every in-memory deck, so the next load must come from the database.
 */
describe('DemandDeckService persistence', () => {
  let gameId: string;

  async function insertGame(id: string): Promise<void> {
    await db.query(
      'INSERT INTO games (id, status, current_player_index, max_players) VALUES ($1, $2, $3, $4)',
      [id, 'setup', 0, 6]
    );
  }

  async function addPlayer(id: string, name: string, color: string): Promise<string> {
    const playerId = uuidv4();
    await PlayerService.createPlayer(id, {
      id: playerId,
      name,
      color,
      money: 50,
      trainType: TrainType.Freight,
      turnNumber: 1,
      trainState: {
        position: { x: 0, y: 0, row: 0, col: 0 },
        movementHistory: [],
        remainingMovement: 9,
        loads: [] as LoadType[],
      },
      hand: [],
    } as any);
    return playerId;
  }

  async function readDeckColumns(id: string): Promise<{ draw: number[] | null; discard: number[] | null }> {
    const result = await db.query(
      'SELECT deck_draw_pile, deck_discard_pile FROM games WHERE id = $1',
      [id]
    );
    return { draw: result.rows[0].deck_draw_pile, discard: result.rows[0].deck_discard_pile };
  }

  async function readAllHandCards(id: string): Promise<number[]> {
    const result = await db.query('SELECT hand FROM players WHERE game_id = $1', [id]);
    return result.rows.flatMap((row: { hand: number[] }) => row.hand);
  }

  beforeEach(async () => {
    DemandDeckService.destroyAllInstances();
    gameId = uuidv4();
    await insertGame(gameId);
  });

  afterEach(async () => {
    DemandDeckService.destroyAllInstances();
    await db.query('DELETE FROM turn_actions');
    await db.query('DELETE FROM movement_history');
    await db.query('DELETE FROM player_tracks');
    await db.query('DELETE FROM games');
    await db.query('DELETE FROM players');
  });

  it('persists the deck when players are dealt their initial hands', async () => {
    await addPlayer(gameId, 'Alice', '#FF0000');
    await addPlayer(gameId, 'Bob', '#0000FF');

    const { draw, discard } = await readDeckColumns(gameId);
    expect(draw).not.toBeNull();
    expect(discard).not.toBeNull();

    const hands = await readAllHandCards(gameId);
    expect(hands).toHaveLength(6);
    for (const cardId of hands) {
      expect(draw).not.toContain(cardId);
      expect(discard).not.toContain(cardId);
    }
  });

  it('restores the exact deck after a restart', async () => {
    await addPlayer(gameId, 'Alice', '#FF0000');
    await addPlayer(gameId, 'Bob', '#0000FF');
    const before = await readDeckColumns(gameId);

    DemandDeckService.destroyAllInstances();
    const deck = await DemandDeckService.loadForGame(gameId, db);

    // Drawing reveals the persisted order: the next card is the last element.
    const expectedTop = before.draw![before.draw!.length - 1];
    const drawn = deck.drawCard();
    expect(drawn).not.toBeNull();
    const drawnKey = drawn!.type === 'event' ? -drawn!.card.id : drawn!.card.id;
    expect(drawnKey).toBe(expectedTop);

    const state = deck.getDeckState();
    expect(state.drawPileSize).toBe(before.draw!.length - 1);
    expect(state.discardPileSize).toBe(before.discard!.length);
    // 6 cards in hands plus the one just drawn
    expect(state.dealtCardsCount).toBe(7);
  });

  it('builds a deck that excludes cards already in hands when none is persisted', async () => {
    const playerId = uuidv4();
    await db.query(
      `INSERT INTO players (id, game_id, name, color, money, train_type, current_turn_number, hand, loads)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [playerId, gameId, 'Legacy', '#00FF00', 50, TrainType.Freight, 1, [1, 2, 3], []]
    );
    expect((await readDeckColumns(gameId)).draw).toBeNull();

    const deck = await DemandDeckService.loadForGame(gameId, db);

    const { draw, discard } = await readDeckColumns(gameId);
    expect(draw).not.toBeNull();
    expect(discard).toEqual([]);
    for (const cardId of [1, 2, 3]) {
      expect(draw).not.toContain(cardId);
    }
    expect(deck.getDeckState().dealtCardsCount).toBe(3);
  });

  it('leaves the persisted deck unchanged when the transaction rolls back', async () => {
    await addPlayer(gameId, 'Alice', '#FF0000');
    const before = await readDeckColumns(gameId);

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const deck = await DemandDeckService.loadForGame(gameId, client);
      for (let i = 0; i < 5; i++) {
        deck.drawCard();
      }
      await deck.persist(client);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(await readDeckColumns(gameId)).toEqual(before);
    const reloaded = await DemandDeckService.loadForGame(gameId, db);
    expect(reloaded.getDeckState().drawPileSize).toBe(before.draw!.length);
  });

  it('removes hand cards found in the persisted piles so they cannot be drawn again', async () => {
    await addPlayer(gameId, 'Alice', '#FF0000');
    const [handCard] = await readAllHandCards(gameId);
    const before = await readDeckColumns(gameId);
    // Corrupt the deck: the hand card on top of the draw pile (twice) and in the discard pile.
    await db.query(
      'UPDATE games SET deck_draw_pile = $1, deck_discard_pile = $2 WHERE id = $3',
      [[...before.draw!, handCard, handCard], [...before.discard!, handCard], gameId]
    );
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      DemandDeckService.destroyAllInstances();
      const deck = await DemandDeckService.loadForGame(gameId, db);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`removed hand cards [${handCard}]`));
      const drawn = deck.drawCard();
      expect(drawn!.card.id).not.toBe(handCard);

      await deck.persist(db);
      const after = await readDeckColumns(gameId);
      expect(after.draw).not.toContain(handCard);
      expect(after.discard).not.toContain(handCard);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when the persisted piles are consistent with hands', async () => {
    await addPlayer(gameId, 'Alice', '#FF0000');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      DemandDeckService.destroyAllInstances();
      await DemandDeckService.loadForGame(gameId, db);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('removed hand cards'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('never deals a card already in another hand after a restart', async () => {
    const alice = await addPlayer(gameId, 'Alice', '#FF0000');
    await addPlayer(gameId, 'Bob', '#0000FF');

    for (let i = 0; i < 5; i++) {
      DemandDeckService.destroyAllInstances();
      await PlayerService.discardHandForPlayer(gameId, alice);

      const hands = await readAllHandCards(gameId);
      expect(hands).toHaveLength(6);
      expect(new Set(hands).size).toBe(6);
    }
  });

  it('keeps each game’s persisted deck isolated', async () => {
    const otherGameId = uuidv4();
    await insertGame(otherGameId);
    await addPlayer(gameId, 'Alice', '#FF0000');
    await addPlayer(otherGameId, 'Bob', '#0000FF');
    const otherBefore = await readDeckColumns(otherGameId);

    DemandDeckService.destroyAllInstances();
    const deck = await DemandDeckService.loadForGame(gameId, db);
    for (let i = 0; i < 10; i++) {
      deck.drawCard();
    }
    await deck.persist(db);

    expect(await readDeckColumns(otherGameId)).toEqual(otherBefore);
  });
});
