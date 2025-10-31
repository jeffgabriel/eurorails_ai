import fs from 'fs';
import path from 'path';
import { DemandCard, RawDemandCard } from '../../shared/types/DemandCard';

export class DemandDeckService {
  private static instance: DemandDeckService;
  private cards: DemandCard[] = [];
  private drawPile: number[] = [];  // Array of card IDs in the draw pile
  private discardPile: number[] = [];  // Array of card IDs in the discard pile
  private dealtCards: Set<number> = new Set();  // Set of card IDs currently dealt to players
  
  private constructor() {
    this.loadCards();
  }

  public static getInstance(): DemandDeckService {
    if (!DemandDeckService.instance) {
      DemandDeckService.instance = new DemandDeckService();
    }
    return DemandDeckService.instance;
  }

  private loadCards(): void {
    try {
      // Read the JSON file
      const configPath = path.resolve(__dirname, '../../../configuration/demand_cards.json');
      const rawData = fs.readFileSync(configPath, 'utf8');
      const jsonData = JSON.parse(rawData);
      
      // Transform raw cards into our internal format
      this.cards = jsonData.DemandCards.map((card: RawDemandCard): DemandCard => ({
        id: card.id,
        demands: card.demands.map(demand => ({
          city: demand.city,
          resource: demand.resource,
          payment: demand.payment
        }))
      }));

      // Validate that each card has exactly 3 demands
      const invalidCards = this.cards.filter(card => card.demands.length !== 3);
      if (invalidCards.length > 0) {
        throw new Error(`Found cards with incorrect number of demands: ${invalidCards.map(c => c.id).join(', ')}`);
      }

      // Initialize draw pile with all card IDs
      this.drawPile = this.cards.map(card => card.id);
      this.shuffleDrawPile();
    } catch (error) {
      console.error('Failed to load demand cards:', error);
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

  public drawCard(): DemandCard | null {
    // If draw pile is empty, shuffle discard pile into draw pile
    if (this.drawPile.length === 0) {
      if (this.discardPile.length === 0) {
        return null;  // No cards available
      }
      this.drawPile = [...this.discardPile];
      this.discardPile = [];
      this.shuffleDrawPile();
    }

    const cardId = this.drawPile.pop()!;
    this.dealtCards.add(cardId);  // Mark card as dealt
    return this.cards.find(card => card.id === cardId) || null;
  }

  public discardCard(cardId: number): void {
    if (!this.cards.find(card => card.id === cardId)) {
      throw new Error(`Invalid card ID: ${cardId}`);
    }
    if (!this.dealtCards.has(cardId)) {
      throw new Error(`Card ${cardId} is not currently dealt to any player`);
    }
    this.dealtCards.delete(cardId);  // Remove from dealt cards
    this.discardPile.push(cardId);
  }

  public getAllCards(): DemandCard[] {
    return [...this.cards];
  }

  public getCard(cardId: number): DemandCard | undefined {
    return this.cards.find(card => card.id === cardId);
  }

  // For debugging/testing purposes
  public getDeckState(): { 
    totalCards: number, 
    drawPileSize: number, 
    discardPileSize: number,
    dealtCardsCount: number
  } {
    return {
      totalCards: this.cards.length,
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
    this.dealtCards.clear();
    this.discardPile = [];
    // Reinitialize draw pile with all card IDs
    this.drawPile = this.cards.map(card => card.id);
    this.shuffleDrawPile();
  }
}

// Export a singleton instance
export const demandDeckService = DemandDeckService.getInstance();