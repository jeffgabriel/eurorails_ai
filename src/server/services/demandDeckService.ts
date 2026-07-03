import fs from 'fs';
import path from 'path';
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

/**
 * Per-game demand/event deck.
 *
 * Card definitions (demand + event cards and their lookup maps) are immutable
 * configuration loaded once from disk and shared across all games via static
 * fields. The mutable deck state — draw pile, discard pile, and dealt set — is
 * isolated per game: each game gets its own instance via
 * {@link DemandDeckService.getInstanceForGame}. This prevents one game's draws
 * and discards from corrupting another game's deck.
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

  /**
   * Sentinel game id backing the deprecated {@link DemandDeckService.getInstance}
   * / {@link demandDeckService} singleton shim. Consumers still on the singleton
   * share this one deck until they are migrated to getInstanceForGame(gameId).
   */
  private static readonly LEGACY_SHARED_GAME_ID = '__legacy_shared__';

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
   * Get (or lazily create) the demand deck for a specific game. Each game owns
   * an isolated draw/discard/dealt state; the card definitions are shared.
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
   * @deprecated Back-compat shim for the pre-per-game singleton. Returns a
   * single shared deck keyed by {@link DemandDeckService.LEGACY_SHARED_GAME_ID}.
   * Use {@link DemandDeckService.getInstanceForGame} instead; this is removed
   * once all consumers are migrated to per-game instances (BE-002).
   */
  public static getInstance(): DemandDeckService {
    return DemandDeckService.getInstanceForGame(DemandDeckService.LEGACY_SHARED_GAME_ID);
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
   * Ensure a demand card is marked as dealt in the in-memory deck state.
   *
   * This is used to reconcile deck state after a server restart: players' hands are persisted
   * in Postgres, but the deck's dealtCards/drawPile/discardPile are currently in-memory only.
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

  /**
   * Return a discarded event card back to the top of the draw pile.
   * Used for rollback compensation when a transaction fails after event cards were discarded.
   */
  public returnDiscardedEventCardToDrawPile(eventCardId: number): boolean {
    if (!DemandDeckService.eventCardMap.has(eventCardId)) {
      return false;
    }
    const drawKey = eventDrawKey(eventCardId);
    const idx = this.discardPile.lastIndexOf(drawKey);
    if (idx === -1) {
      return false;
    }
    this.discardPile.splice(idx, 1);
    this.drawPile.push(drawKey);
    return true;
  }

  /** Returns all demand cards (legacy accessor). */
  public getAllCards(): DemandCard[] {
    return [...DemandDeckService.demandCards];
  }

  /** Returns a demand card by ID, or undefined if not found. */
  public getCard(cardId: number): DemandCard | undefined {
    return DemandDeckService.demandCardMap.get(cardId);
  }

  /** Returns all event card definitions. */
  public getAllEventCards(): EventCard[] {
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

/**
 * @deprecated Singleton shim backed by a single shared deck. Prefer
 * DemandDeckService.getInstanceForGame(gameId) so each game gets an isolated
 * deck. Retained so existing consumers compile during the per-game migration
 * (BE-002); removed once they are migrated.
 */
export const demandDeckService = DemandDeckService.getInstance();
