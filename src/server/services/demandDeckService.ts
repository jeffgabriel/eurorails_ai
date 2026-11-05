import fs from 'fs';
import path from 'path';
import { Pool, PoolClient } from 'pg';
import { DemandCard, RawDemandCard } from '../../shared/types/DemandCard';
import { EventCard, RawEventCard } from '../../shared/types/EventCard';
import { CardDrawResult } from '../../shared/types/CardDrawResult';

/**
 * Internal draw-pile key encoding:
 *   - Demand cards:  positive ID  (1 – 146)
 *   - Event cards:   negative ID  (-(121) to -(140))
 *
 * This avoids collisions since demand cards 121-140 and event cards 121-140
 * share the same numeric range in the original specification.
 * Public APIs always use the real (positive) card IDs.
 */
function eventDrawKey(eventCardId: number): number {
  return -eventCardId;
}

/** A pool or a transaction client — anything that can run a query. */
type DeckQueryExecutor = Pool | PoolClient;

/**
 * Per-game demand/event deck.
 *
 * Card definitions (demand + event cards and their lookup maps) are immutable
 * configuration loaded once from disk and shared across all games via static
 * fields. The mutable deck state — draw pile, discard pile, and dealt set — is
 * isolated per game and persisted on the game's row (`games.deck_draw_pile`,
 * `games.deck_discard_pile`) so it survives server restarts.
 *
 * Server code obtains a deck with {@link DemandDeckService.loadForGame} inside
 * its transaction, mutates it, and calls {@link DemandDeckService.persist}
 * before COMMIT. The database is the source of truth: a rolled-back
 * transaction leaves the persisted deck untouched, and the next load sees it.
 */
export class DemandDeckService {
  // ---- Shared, immutable card configuration (loaded once from disk) ----
  private static demandCards: DemandCard[] = [];
  private static eventCards: EventCard[] = [];
  /** Lookup by real (positive) ID for demand cards */
  private static demandCardMap: Map<number, DemandCard> = new Map();
  /** Lookup by real (positive) ID for event cards */
  private static eventCardMap: Map<number, EventCard> = new Map();
  private static configLoaded = false;

  // ---- Per-game instance registry ----
  private static instances: Map<string, DemandDeckService> = new Map();

  // ---- Per-game mutable deck state ----
  private readonly gameId: string;
  /** Draw pile entries: positive = demand card ID, negative = -(event card ID) */
  private drawPile: number[] = [];
  /** Discard pile entries: same encoding as drawPile */
  private discardPile: number[] = [];
  /** Dealt entries: same encoding as drawPile (negative for event cards) */
  private dealtCards: Set<number> = new Set();

  private constructor(gameId: string) {
    this.gameId = gameId;
    DemandDeckService.ensureConfigLoaded();
    this.initializeDeck();
  }

  /**
   * Get (or lazily create) the in-memory deck for a specific game, without
   * touching the database. Returns the instance most recently loaded by
   * {@link DemandDeckService.loadForGame} for this game, if any.
   *
   * Server code that draws or discards must use loadForGame + persist instead;
   * this accessor exists for unit tests and in-memory inspection.
   */
  public static getInstanceForGame(gameId: string): DemandDeckService {
    if (!gameId || typeof gameId !== 'string') {
      throw new Error('DemandDeckService.getInstanceForGame requires a non-empty gameId');
    }
    let instance = DemandDeckService.instances.get(gameId);
    if (!instance) {
      instance = new DemandDeckService(gameId);
      DemandDeckService.instances.set(gameId, instance);
    }
    return instance;
  }

  /**
   * Load a game's deck from the database, locking the game row (`FOR UPDATE`)
   * so concurrent deck transactions in the same game are serialized. Call this
   * inside the transaction that will mutate the deck, then call
   * {@link DemandDeckService.persist} before COMMIT.
   *
   * Always returns a fresh instance built from the persisted state, so an
   * earlier rolled-back transaction can never leak into this one. If the game
   * has no persisted deck yet (a new game, or one created before deck
   * persistence existed), a fresh shuffled deck is built with every card
   * currently in a player's hand marked as dealt, and persisted immediately.
   *
   * Player hands are authoritative: any hand card found in a persisted pile is
   * removed from it (with a warning) so it can never be dealt twice. The repair
   * is saved by the caller's persist.
   *
   * The loaded instance also becomes the game's registry entry, so
   * {@link DemandDeckService.getInstanceForGame} reflects the latest load.
   */
  public static async loadForGame(gameId: string, executor: DeckQueryExecutor): Promise<DemandDeckService> {
    if (!gameId || typeof gameId !== 'string') {
      throw new Error('DemandDeckService.loadForGame requires a non-empty gameId');
    }
    const result = await executor.query(
      'SELECT deck_draw_pile, deck_discard_pile FROM games WHERE id = $1 FOR UPDATE',
      [gameId]
    );
    if (result.rows.length === 0) {
      throw new Error(`Game ${gameId} not found`);
    }

    const handsResult = await executor.query(
      'SELECT hand FROM players WHERE game_id = $1',
      [gameId]
    );
    const handCardIds: number[] = handsResult.rows.flatMap(
      (row: { hand: number[] | null }) => (row.hand || []).map(Number)
    );

    const instance = new DemandDeckService(gameId);
    const { deck_draw_pile: drawPile, deck_discard_pile: discardPile } = result.rows[0];
    if (Array.isArray(drawPile) && Array.isArray(discardPile)) {
      instance.restoreState(drawPile, discardPile);
      const healed = instance.removeHandCardsFromPiles(handCardIds);
      if (healed.length > 0) {
        console.warn(
          `[DemandDeckService] Game ${gameId}: removed hand cards [${healed.join(', ')}] from persisted draw/discard piles`
        );
      }
    } else {
      // No persisted deck yet: the fresh shuffle from the constructor must
      // exclude every card already held in a hand, then be saved.
      instance.removeHandCardsFromPiles(handCardIds);
      await instance.persist(executor);
    }

    DemandDeckService.instances.set(gameId, instance);
    return instance;
  }

  /**
   * Write this game's draw and discard piles to its game row. Dealt cards are
   * not stored — they are derived on load as every card in neither pile.
   */
  public async persist(executor: DeckQueryExecutor): Promise<void> {
    await executor.query(
      'UPDATE games SET deck_draw_pile = $1, deck_discard_pile = $2 WHERE id = $3',
      [this.drawPile, this.discardPile, this.gameId]
    );
  }

  /**
   * Replace this instance's piles with persisted state and derive the dealt set
   * as every known card key in neither pile.
   */
  private restoreState(drawPile: number[], discardPile: number[]): void {
    this.drawPile = drawPile.map(Number);
    this.discardPile = discardPile.map(Number);
    const inPiles = new Set([...this.drawPile, ...this.discardPile]);
    this.dealtCards = new Set(
      [
        ...DemandDeckService.demandCards.map(c => c.id),
        ...DemandDeckService.eventCards.map(c => eventDrawKey(c.id)),
      ].filter(key => !inPiles.has(key))
    );
  }

  /**
   * Mark every given hand card as dealt, removing all of its occurrences from
   * the draw and discard piles. Returns the card ids that had to be removed
   * from a pile.
   */
  private removeHandCardsFromPiles(handCardIds: number[]): number[] {
    const handKeys = new Set(
      handCardIds.filter(id => DemandDeckService.demandCardMap.has(id))
    );
    const healed = new Set(
      [...this.drawPile, ...this.discardPile].filter(key => handKeys.has(key))
    );
    if (healed.size > 0) {
      this.drawPile = this.drawPile.filter(key => !handKeys.has(key));
      this.discardPile = this.discardPile.filter(key => !handKeys.has(key));
    }
    for (const key of handKeys) {
      this.dealtCards.add(key);
    }
    return [...healed];
  }

  /**
   * Remove a game's deck from the registry. Call at game end to release the
   * in-memory deck state. Idempotent — destroying an unknown game is a no-op.
   */
  public static destroyInstance(gameId: string): void {
    DemandDeckService.instances.delete(gameId);
  }

  /**
   * Remove every game's deck from the registry. Testing only — lets a test
   * suite start from a clean slate between cases.
   */
  public static destroyAllInstances(): void {
    DemandDeckService.instances.clear();
  }

  /**
   * Load the immutable card definitions from disk exactly once. Subsequent
   * calls are no-ops. Shared across all per-game instances.
   */
  private static ensureConfigLoaded(): void {
    if (DemandDeckService.configLoaded) {
      return;
    }
    try {
      // Load demand cards
      const demandConfigPath = path.resolve(__dirname, '../../../configuration/demand_cards.json');
      const demandRawData = fs.readFileSync(demandConfigPath, 'utf8');
      const demandJsonData = JSON.parse(demandRawData);

      const demandCards: DemandCard[] = demandJsonData.DemandCards.map((card: RawDemandCard): DemandCard => ({
        id: card.id,
        demands: card.demands.map(demand => ({
          city: demand.city,
          resource: demand.resource,
          payment: demand.payment
        }))
      }));

      // Validate that each demand card has exactly 3 demands
      const invalidCards = demandCards.filter(card => card.demands.length !== 3);
      if (invalidCards.length > 0) {
        throw new Error(`Found cards with incorrect number of demands: ${invalidCards.map(c => c.id).join(', ')}`);
      }

      // Load event cards
      const eventConfigPath = path.resolve(__dirname, '../../../configuration/event_cards.json');
      const eventRawData = fs.readFileSync(eventConfigPath, 'utf8');
      const rawEventCards: RawEventCard[] = JSON.parse(eventRawData);

      const eventCards: EventCard[] = rawEventCards.map((card: RawEventCard): EventCard => ({
        id: card.id,
        type: card.type,
        title: card.title,
        description: card.description,
        effectConfig: card.effectConfig,
      }));

      // Build lookup maps (separate, no ID collision)
      DemandDeckService.demandCards = demandCards;
      DemandDeckService.eventCards = eventCards;
      DemandDeckService.demandCardMap = new Map(demandCards.map(c => [c.id, c]));
      DemandDeckService.eventCardMap = new Map(eventCards.map(c => [c.id, c]));
      DemandDeckService.configLoaded = true;
    } catch (error) {
      console.error('Failed to load cards:', error);
      throw error;
    }
  }

  /**
   * Build a fresh, shuffled draw pile for this game from the shared card
   * definitions and clear the discard/dealt state.
   */
  private initializeDeck(): void {
    // Initialize unified draw pile: positive IDs for demand, negative for event
    this.drawPile = [
      ...DemandDeckService.demandCards.map(c => c.id),
      ...DemandDeckService.eventCards.map(c => eventDrawKey(c.id)),
    ];
    this.discardPile = [];
    this.dealtCards = new Set();
    this.shuffleDrawPile();
  }

  private shuffleDrawPile(): void {
    // Fisher-Yates shuffle algorithm
    for (let i = this.drawPile.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.drawPile[i], this.drawPile[j]] = [this.drawPile[j], this.drawPile[i]];
    }
  }

  /** Convert an internal draw-pile key to a CardDrawResult, or null if not found. */
  private resolveDrawKey(drawKey: number): CardDrawResult | null {
    if (drawKey > 0) {
      const card = DemandDeckService.demandCardMap.get(drawKey);
      return card ? { type: 'demand', card } : null;
    } else {
      const realId = -drawKey;
      const card = DemandDeckService.eventCardMap.get(realId);
      return card ? { type: 'event', card } : null;
    }
  }

  public drawCard(): CardDrawResult | null {
    // If draw pile is empty, shuffle discard pile into draw pile
    if (this.drawPile.length === 0) {
      if (this.discardPile.length === 0) {
        return null;  // No cards available
      }
      this.drawPile = [...this.discardPile];
      this.discardPile = [];
      this.shuffleDrawPile();
    }

    const drawKey = this.drawPile.pop()!;
    this.dealtCards.add(drawKey);
    return this.resolveDrawKey(drawKey);
  }

  /**
   * Ensure a demand card is marked as dealt, removing it from the draw and
   * discard piles. Used when building a deck for a game that has player hands
   * but no persisted deck yet.
   *
   * Only applicable to demand cards (player hands never contain event cards).
   */
  public ensureCardIsDealt(cardId: number): boolean {
    if (!DemandDeckService.demandCardMap.has(cardId)) {
      return false;
    }
    const drawKey = cardId; // Demand cards: drawKey === cardId (positive)
    if (this.dealtCards.has(drawKey)) {
      return true;
    }
    const drawIdx = this.drawPile.lastIndexOf(drawKey);
    if (drawIdx !== -1) {
      this.drawPile.splice(drawIdx, 1);
    }
    const discardIdx = this.discardPile.lastIndexOf(drawKey);
    if (discardIdx !== -1) {
      this.discardPile.splice(discardIdx, 1);
    }
    this.dealtCards.add(drawKey);
    return true;
  }

  /**
   * Discard a demand card by its real ID.
   * Called when a player's demand card is fulfilled or their hand is discarded.
   * Do NOT call this for event cards — use discardEventCard() instead.
   */
  public discardCard(cardId: number): void {
    const drawKey = cardId; // Demand cards use positive IDs as draw keys
    if (!DemandDeckService.demandCardMap.has(cardId)) {
      throw new Error(`Invalid card ID: ${cardId}`);
    }
    if (!this.dealtCards.has(drawKey)) {
      // Attempt to reconcile after restart: the card may be in a persisted player hand
      // but not in dealtCards. Ensure it's treated as dealt and removed from draw/discard.
      this.ensureCardIsDealt(cardId);
      if (!this.dealtCards.has(drawKey)) {
        throw new Error(`Card ${cardId} is not currently dealt to any player`);
      }
    }
    this.dealtCards.delete(drawKey);
    this.discardPile.push(drawKey);
  }

  /**
   * Discard a drawn event card back to the discard pile.
   * Called immediately after drawing an event card (event cards are never held in player hands).
   */
  public discardEventCard(eventCardId: number): void {
    const drawKey = eventDrawKey(eventCardId);
    if (!DemandDeckService.eventCardMap.has(eventCardId)) {
      throw new Error(`Invalid event card ID: ${eventCardId}`);
    }
    if (!this.dealtCards.has(drawKey)) {
      throw new Error(`Event card ${eventCardId} is not currently drawn`);
    }
    this.dealtCards.delete(drawKey);
    this.discardPile.push(drawKey);
  }

  /**
   * Return a currently-dealt demand card back to the top of the draw pile.
   * Used for server-authoritative undo of a delivery draw.
   * Only applicable to demand cards.
   */
  public returnDealtCardToTop(cardId: number): boolean {
    if (!DemandDeckService.demandCardMap.has(cardId)) {
      return false;
    }
    const drawKey = cardId; // demand card: positive key
    if (!this.dealtCards.has(drawKey)) {
      return false;
    }
    this.dealtCards.delete(drawKey);
    this.drawPile.push(drawKey);
    return true;
  }

  /**
   * Reverse a discard by moving a demand card from discard pile back into dealtCards.
   * Used for server-authoritative undo of a delivery (restoring the discarded demand card to hand).
   * Only applicable to demand cards.
   */
  public returnDiscardedCardToDealt(cardId: number): boolean {
    if (!DemandDeckService.demandCardMap.has(cardId)) {
      return false;
    }
    const drawKey = cardId; // demand card: positive key
    const idx = this.discardPile.lastIndexOf(drawKey);
    if (idx === -1) {
      return false;
    }
    this.discardPile.splice(idx, 1);
    this.dealtCards.add(drawKey);
    return true;
  }

  // ---- Definitional accessors (card-level data, shared; not per-game state) ----
  // These describe "what is printed on a card" and never touch a game's deck,
  // so they are static: callers that only need card definitions (e.g. the
  // definitional deck routes) must NOT construct a per-game instance.

  /** Returns all demand card definitions. */
  public static getAllCards(): DemandCard[] {
    DemandDeckService.ensureConfigLoaded();
    return [...DemandDeckService.demandCards];
  }

  /** Returns a demand card definition by ID, or undefined if not found. */
  public static getCard(cardId: number): DemandCard | undefined {
    DemandDeckService.ensureConfigLoaded();
    return DemandDeckService.demandCardMap.get(cardId);
  }

  /** Returns all event card definitions. */
  public static getAllEventCards(): EventCard[] {
    DemandDeckService.ensureConfigLoaded();
    return [...DemandDeckService.eventCards];
  }

  /** Total number of unique cards in the unified pool (demand + event). */
  get totalCardCount(): number {
    return DemandDeckService.demandCards.length + DemandDeckService.eventCards.length;
  }

  // For debugging/testing purposes
  public getDeckState(): {
    totalCards: number,
    drawPileSize: number,
    discardPileSize: number,
    dealtCardsCount: number
  } {
    return {
      totalCards: DemandDeckService.demandCards.length + DemandDeckService.eventCards.length,
      drawPileSize: this.drawPile.length,
      discardPileSize: this.discardPile.length,
      dealtCardsCount: this.dealtCards.size
    };
  }

  /**
   * Place a specific event card on top of the draw pile so it will be drawn next.
   * If the card is currently in the draw pile, discard pile, or dealt set, it is
   * removed from that location first to avoid duplicates.
   * Debug/testing only.
   */
  public pushEventCardToTop(eventCardId: number): void {
    const card = DemandDeckService.eventCardMap.get(eventCardId);
    if (!card) {
      throw new Error(`Event card ${eventCardId} not found`);
    }

    const drawKey = eventDrawKey(eventCardId);

    // Remove from wherever it currently lives
    const drawIdx = this.drawPile.indexOf(drawKey);
    if (drawIdx !== -1) {
      this.drawPile.splice(drawIdx, 1);
    }
    const discardIdx = this.discardPile.indexOf(drawKey);
    if (discardIdx !== -1) {
      this.discardPile.splice(discardIdx, 1);
    }
    this.dealtCards.delete(drawKey);

    // Push to end = top of draw pile (pop() draws from end)
    this.drawPile.push(drawKey);
  }

  /**
   * Reshuffle the draw pile and discard pile together, preserving dealt cards
   * (cards currently in player hands). Use when the deck appears corrupted
   * (e.g. too many event cards in sequence).
   */
  public reshuffle(): { drawPileSize: number; discardPileSize: number; dealtCardsCount: number } {
    // Merge discard pile back into draw pile
    this.drawPile.push(...this.discardPile);
    this.discardPile = [];
    this.shuffleDrawPile();
    return {
      drawPileSize: this.drawPile.length,
      discardPileSize: 0,
      dealtCardsCount: this.dealtCards.size,
    };
  }

  /**
   * Reset this game's deck state (for testing).
   * Rebuilds a fresh, shuffled draw pile from the shared card definitions and
   * clears the discard/dealt state.
   */
  public reset(): void {
    this.initializeDeck();
  }
}
