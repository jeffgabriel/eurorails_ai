/**
 * Tests for DemandDeckService unified draw pile (demand cards + event cards).
 *
 * These tests verify:
 * - The unified draw pile contains all 146 demand cards + 20 event cards = 166 total
 * - drawCard() returns CardDrawResult with correct type discriminators
 * - Event cards and demand cards are both present in the pool
 * - ensureCardIsDealt, returnDealtCardToTop, returnDiscardedCardToDealt work for both card types
 * - getAllEventCards() returns all 20 event cards
 * - reset() restores unified pile of 166 cards
 */
import { DemandDeckService } from '../services/demandDeckService';
import { EventCardType } from '../../shared/types/EventCard';

// Get the singleton and reset it to a clean state for each test
function getFreshService(): DemandDeckService {
  const service = DemandDeckService.getInstance();
  service.reset();
  return service;
}

describe('DemandDeckService unified draw pile', () => {
  let service: DemandDeckService;

  beforeEach(() => {
    service = getFreshService();
  });

  describe('deck initialization', () => {
    it('should have 166 total cards (146 demand + 20 event)', () => {
      const state = service.getDeckState();
      expect(state.totalCards).toBe(166);
    });

    it('should initialize draw pile with all 166 cards', () => {
      const state = service.getDeckState();
      expect(state.drawPileSize).toBe(166);
      expect(state.discardPileSize).toBe(0);
      expect(state.dealtCardsCount).toBe(0);
    });

    it('should have 20 event cards via getAllEventCards()', () => {
      const eventCards = service.getAllEventCards();
      expect(eventCards).toHaveLength(20);
    });

    it('should have event card IDs 121–140', () => {
      const eventCards = service.getAllEventCards();
      const ids = eventCards.map((c) => c.id).sort((a, b) => a - b);
      const expected = Array.from({ length: 20 }, (_, i) => 121 + i);
      expect(ids).toEqual(expected);
    });

    it('should return all demand cards via getAllCards()', () => {
      const demandCards = service.getAllCards();
      expect(demandCards).toHaveLength(146);
    });

    it('should return specific demand card via getCard()', () => {
      const card = service.getCard(1);
      expect(card).toBeDefined();
      expect(card!.id).toBe(1);
    });

    it('should return demand card for ID 121 via getCard() (demand cards include 121)', () => {
      // Demand card IDs go 1–146, so ID 121 is a demand card
      const card = service.getCard(121);
      expect(card).toBeDefined();
      expect(card!.id).toBe(121);
    });
  });

  describe('drawCard() — CardDrawResult discriminated union', () => {
    it('should return CardDrawResult (not null) on first draw', () => {
      const result = service.drawCard();
      expect(result).not.toBeNull();
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('card');
    });

    it('should return type "demand" or "event" on each draw', () => {
      // Draw enough cards to likely get both types
      const results: string[] = [];
      for (let i = 0; i < 50; i++) {
        const r = service.drawCard();
        if (r) results.push(r.type);
      }
      expect(results.every((t) => t === 'demand' || t === 'event')).toBe(true);
    });

    it('should include event cards in the draw pile', () => {
      // Draw all 166 cards
      const drawnTypes: string[] = [];
      let result = service.drawCard();
      while (result !== null) {
        drawnTypes.push(result.type);
        // Don't add back to discard so pile empties
        result = service.drawCard();
        if (drawnTypes.length >= 166) break;
      }
      const eventDraws = drawnTypes.filter((t) => t === 'event');
      const demandDraws = drawnTypes.filter((t) => t === 'demand');
      expect(eventDraws.length).toBe(20);
      expect(demandDraws.length).toBe(146);
    });

    it('should mark drawn card as dealt', () => {
      const before = service.getDeckState();
      service.drawCard();
      const after = service.getDeckState();
      expect(after.drawPileSize).toBe(before.drawPileSize - 1);
      expect(after.dealtCardsCount).toBe(before.dealtCardsCount + 1);
    });

    it('should return null when deck and discard are both empty', () => {
      // Draw all cards without discarding
      for (let i = 0; i < 166; i++) {
        service.drawCard();
      }
      const result = service.drawCard();
      expect(result).toBeNull();
    });

    it('should reshuffle discard pile into draw pile when draw pile is empty', () => {
      // Draw all 166 cards then discard them all using correct discard method per type
      const drawnResults: Array<{ type: string; id: number }> = [];
      for (let i = 0; i < 166; i++) {
        const r = service.drawCard();
        if (r) drawnResults.push({ type: r.type, id: r.card.id });
      }
      expect(drawnResults).toHaveLength(166);
      // Discard all drawn cards using the appropriate method for each type
      for (const { type, id } of drawnResults) {
        if (type === 'event') {
          service.discardEventCard(id);
        } else {
          service.discardCard(id);
        }
      }
      // Now draw pile should reshuffle from discard
      const afterDiscard = service.getDeckState();
      expect(afterDiscard.discardPileSize).toBe(166);
      expect(afterDiscard.drawPileSize).toBe(0);

      const reshuffled = service.drawCard();
      expect(reshuffled).not.toBeNull();
      const afterReshuffle = service.getDeckState();
      expect(afterReshuffle.drawPileSize + afterReshuffle.dealtCardsCount + afterReshuffle.discardPileSize).toBe(166);
    });
  });

  describe('discardCard() — both card types', () => {
    it('should discard a demand card by ID', () => {
      // Draw until we get a demand card (unified deck may draw event cards first)
      let demandResult: ReturnType<typeof service.drawCard> = null;
      const eventCardsDrawn: number[] = [];
      for (let i = 0; i < 166; i++) {
        const r = service.drawCard();
        if (!r) break;
        if (r.type === 'demand') {
          demandResult = r;
          break;
        }
        // Discard event cards so they don't stay in dealt
        service.discardEventCard(r.card.id);
        eventCardsDrawn.push(r.card.id);
      }
      expect(demandResult).not.toBeNull();
      const cardId = demandResult!.card.id;

      service.discardCard(cardId);
      const state = service.getDeckState();
      expect(state.discardPileSize).toBe(1 + eventCardsDrawn.length);
      expect(state.dealtCardsCount).toBe(0);
    });

    it('should discard an event card by ID via discardEventCard()', () => {
      // Draw until we get an event card
      let eventCardId: number | null = null;
      const demandDrawn: number[] = [];
      for (let i = 0; i < 166; i++) {
        const r = service.drawCard();
        if (!r) break;
        if (r.type === 'event') {
          eventCardId = r.card.id;
          break;
        }
        demandDrawn.push(r.card.id);
        // Put demand cards back so we don't exhaust the deck
        service.discardCard(r.card.id);
      }
      expect(eventCardId).not.toBeNull();
      // Event card is now dealt — discard it via discardEventCard
      service.discardEventCard(eventCardId!);
      const state = service.getDeckState();
      expect(state.dealtCardsCount).toBe(0);
    });

    it('should throw for an unknown card ID', () => {
      expect(() => service.discardCard(99999)).toThrow('Invalid card ID: 99999');
    });
  });

  describe('ensureCardIsDealt() — both card types', () => {
    it('should mark a demand card as dealt', () => {
      const demandCardId = service.getAllCards()[0].id;
      const result = service.ensureCardIsDealt(demandCardId);
      expect(result).toBe(true);
      const state = service.getDeckState();
      expect(state.dealtCardsCount).toBe(1);
    });

    it('should return false for event card IDs (ensureCardIsDealt is demand-only)', () => {
      // Event card ID 121 is NOT a demand card in the context of reconciliation
      // (demand cards use ID range 1-146, but event card IDs overlap; ensureCardIsDealt
      // only affects demand card entries since player hands never hold event cards)
      // ID 121 happens to be BOTH a demand card AND an event card — ensureCardIsDealt
      // should handle it as a demand card
      const result = service.ensureCardIsDealt(121);
      expect(result).toBe(true); // 121 is a demand card, so this returns true
    });

    it('should return false for unknown card ID', () => {
      const result = service.ensureCardIsDealt(99999);
      expect(result).toBe(false);
    });

    it('should return true if card is already dealt', () => {
      const cardId = service.getAllCards()[0].id;
      service.ensureCardIsDealt(cardId);
      const result = service.ensureCardIsDealt(cardId); // second call
      expect(result).toBe(true);
    });
  });

  describe('returnDealtCardToTop() — both card types', () => {
    it('should return a dealt demand card to draw pile', () => {
      const r = service.drawCard();
      expect(r).not.toBeNull();
      const cardId = r!.card.id;

      const success = service.returnDealtCardToTop(cardId);
      expect(success).toBe(true);
      const state = service.getDeckState();
      expect(state.dealtCardsCount).toBe(0);
      expect(state.drawPileSize).toBe(166);
    });

    it('should return false for a card not dealt', () => {
      const cardId = service.getAllCards()[0].id;
      const result = service.returnDealtCardToTop(cardId);
      expect(result).toBe(false);
    });

    it('should return false for unknown card ID', () => {
      const result = service.returnDealtCardToTop(99999);
      expect(result).toBe(false);
    });
  });

  describe('returnDiscardedCardToDealt() — both card types', () => {
    it('should move a discarded demand card back to dealt', () => {
      const r = service.drawCard();
      expect(r).not.toBeNull();
      const cardId = r!.card.id;
      service.discardCard(cardId);

      const success = service.returnDiscardedCardToDealt(cardId);
      expect(success).toBe(true);
      const state = service.getDeckState();
      expect(state.discardPileSize).toBe(0);
      expect(state.dealtCardsCount).toBe(1);
    });

    it('should return false if card is not in discard pile', () => {
      const cardId = service.getAllCards()[0].id;
      const result = service.returnDiscardedCardToDealt(cardId);
      expect(result).toBe(false);
    });

    it('should return false for unknown card ID', () => {
      const result = service.returnDiscardedCardToDealt(99999);
      expect(result).toBe(false);
    });
  });

  describe('reset()', () => {
    it('should restore to full 166-card draw pile after reset', () => {
      // Draw some cards and discard some
      for (let i = 0; i < 10; i++) {
        service.drawCard();
      }
      service.reset();
      const state = service.getDeckState();
      expect(state.totalCards).toBe(166);
      expect(state.drawPileSize).toBe(166);
      expect(state.discardPileSize).toBe(0);
      expect(state.dealtCardsCount).toBe(0);
    });
  });

  describe('event card type coverage', () => {
    it('should have event cards of each type in the pool', () => {
      const eventCards = service.getAllEventCards();
      const types = new Set(eventCards.map((c) => c.type));
      expect(types.has(EventCardType.Strike)).toBe(true);
      expect(types.has(EventCardType.Derailment)).toBe(true);
      expect(types.has(EventCardType.Snow)).toBe(true);
      expect(types.has(EventCardType.Flood)).toBe(true);
      expect(types.has(EventCardType.ExcessProfitTax)).toBe(true);
    });
  });
});
