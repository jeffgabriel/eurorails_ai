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

export class DemandDeckService {
  private static instance: DemandDeckService;
  private demandCards: DemandCard[] = [];
  private eventCards: EventCard[] = [];
  /** Lookup by real (positive) ID for demand cards */
  private demandCardMap: Map<number, DemandCard> = new Map();
  /** Lookup by real (positive) ID for event cards */
  private eventCardMap: Map<number, EventCard> = new Map();
  /** Draw pile entries: positive = demand card ID, negative = -(event card ID) */
  private drawPile: number[] = [];
  /** Discard pile entries: same encoding as drawPile */
  private discardPile: number[] = [];
  /** Dealt entries: same encoding as drawPile (negative for event cards) */
  private dealtCards: Set<number> = new Set();

  private constructor() {
    this.loadCards();
  }

  /**
   * For testing only: destroy the singleton so the next getInstance() creates a fresh one.
   * Do NOT call this in production code.
   */
  public static destroyInstanceForTesting(): void {
    DemandDeckService.instance = undefined as unknown as DemandDeckService;
  }

  public static getInstance(): DemandDeckService {
    if (!DemandDeckService.instance) {
      DemandDeckService.instance = new DemandDeckService();
    }
    return DemandDeckService.instance;
  }

  private loadCards(): void {
    try {
      // Load demand cards
      const demandConfigPath = path.resolve(__dirname, '../../../configuration/demand_cards.json');
      const demandRawData = fs.readFileSync(demandConfigPath, 'utf8');
      const demandJsonData = JSON.parse(demandRawData);

      this.demandCards = demandJsonData.DemandCards.map((card: RawDemandCard): DemandCard => ({
        id: card.id,
        demands: card.demands.map(demand => ({
          city: demand.city,
          resource: demand.resource,
          payment: demand.payment
        }))
      }));

      // Validate that each demand card has exactly 3 demands
      const invalidCards = this.demandCards.filter(card => card.demands.length !== 3);
      if (invalidCards.length > 0) {
        throw new Error(`Found cards with incorrect number of demands: ${invalidCards.map(c => c.id).join(', ')}`);
      }

      // Load event cards
      const eventConfigPath = path.resolve(__dirname, '../../../configuration/event_cards.json');
      const eventRawData = fs.readFileSync(eventConfigPath, 'utf8');
      const rawEventCards: RawEventCard[] = JSON.parse(eventRawData);

      this.eventCards = rawEventCards.map((card: RawEventCard): EventCard => ({
        id: card.id,
        type: card.type,
        title: card.title,
        description: card.description,
        effectConfig: card.effectConfig,
      }));

      // Build lookup maps (separate, no ID collision)
      this.demandCardMap = new Map(this.demandCards.map(c => [c.id, c]));
      this.eventCardMap = new Map(this.eventCards.map(c => [c.id, c]));

      // Initialize unified draw pile: positive IDs for demand, negative for event
      this.drawPile = [
        ...this.demandCards.map(c => c.id),
        ...this.eventCards.map(c => eventDrawKey(c.id)),
      ];
      this.shuffleDrawPile();
    } catch (error) {
      console.error('Failed to load cards:', error);
      throw error;
    }
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
      const card = this.demandCardMap.get(drawKey);
      return card ? { type: 'demand', card } : null;
    } else {
      const realId = -drawKey;
      const card = this.eventCardMap.get(realId);
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
   * Ensure a card is marked as dealt in the in-memory deck state.
   *
   * This is used to reconcile deck state after a server restart: players' hands are persisted
   * in Postgres, but the deck's dealtCards/drawPile/discardPile are currently in-memory only.
   *
   * If the card is found in the draw pile or discard pile, it is removed from that pile to
   * prevent duplicates, then added to dealtCards.
   */
  /**
   * Ensure a demand card is marked as dealt in the in-memory deck state.
   *
   * This is used to reconcile deck state after a server restart: players' hands are persisted
   * in Postgres, but the deck's dealtCards/drawPile/discardPile are currently in-memory only.
   *
   * Only applicable to demand cards (player hands never contain event cards).
   */
  public ensureCardIsDealt(cardId: number): boolean {
    if (!this.demandCardMap.has(cardId)) {
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
    if (!this.demandCardMap.has(cardId)) {
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
    if (!this.eventCardMap.has(eventCardId)) {
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
    if (!this.demandCardMap.has(cardId)) {
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
    if (!this.demandCardMap.has(cardId)) {
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
    if (!this.eventCardMap.has(eventCardId)) {
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
    return [...this.demandCards];
  }

  /** Returns a demand card by ID, or undefined if not found. */
  public getCard(cardId: number): DemandCard | undefined {
    return this.demandCardMap.get(cardId);
  }

  /** Returns all event card definitions. */
  public getAllEventCards(): EventCard[] {
    return [...this.eventCards];
  }

  /** Total number of unique cards in the unified pool (demand + event). */
  get totalCardCount(): number {
    return this.demandCards.length + this.eventCards.length;
  }

  // For debugging/testing purposes
  public getDeckState(): {
    totalCards: number,
    drawPileSize: number,
    discardPileSize: number,
    dealtCardsCount: number
  } {
    return {
      totalCards: this.demandCards.length + this.eventCards.length,
      drawPileSize: this.drawPile.length,
      discardPileSize: this.discardPile.length,
      dealtCardsCount: this.dealtCards.size
    };
  }

  /**
   * Reset the deck state (for testing)
   * Returns all dealt cards back to the draw pile and resets state
   */
  public reset(): void {
    this.loadCards(); // Reload cards from JSON configuration to ensure fresh state
    this.dealtCards.clear();
    this.discardPile = [];
    // Reinitialize draw pile with all card IDs (demand + event)
    this.drawPile = [
      ...this.demandCards.map(c => c.id),
      ...this.eventCards.map(c => eventDrawKey(c.id)),
    ];
    this.shuffleDrawPile();
  }
}

// Export a singleton instance
export const demandDeckService = DemandDeckService.getInstance();
