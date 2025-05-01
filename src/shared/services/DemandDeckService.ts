import { DemandCard } from '../types/DemandCard';

export class DemandDeckService {
  private cards: DemandCard[] = [];
  private drawPile: number[] = [];  // Array of card IDs in the draw pile
  private discardPile: number[] = [];  // Array of card IDs in the discard pile
  private dealtCards: Set<number> = new Set();  // Set of card IDs currently dealt to players
  private isLoaded: boolean = false;
  
  constructor() {}

  /**
   * Load demand cards from the server API
   */
  public async loadCards(): Promise<void> {
    try {
      if (this.isLoaded) return;
      
      const response = await fetch('/api/deck/demand');
      if (!response.ok) {
        throw new Error(`Failed to fetch demand cards: ${response.statusText}`);
      }
      
      this.cards = await response.json();
      
      // Validate that each card has exactly 3 demands
      const invalidCards = this.cards.filter(card => card.demands.length !== 3);
      if (invalidCards.length > 0) {
        throw new Error(`Found cards with incorrect number of demands: ${invalidCards.map(c => c.id).join(', ')}`);
      }
      
      // Initialize draw pile with all card IDs
      this.drawPile = this.cards.map(card => card.id);
      this.shuffleDrawPile();
      this.isLoaded = true;
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

  public async drawCard(): Promise<DemandCard | null> {
    // Ensure cards are loaded
    if (!this.isLoaded) {
      await this.loadCards();
    }
    
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

  public returnCardToDeck(cardId: number): void {
    if (!this.cards.find(card => card.id === cardId)) {
      throw new Error(`Invalid card ID: ${cardId}`);
    }
    if (!this.dealtCards.has(cardId)) {
      throw new Error(`Card ${cardId} is not currently dealt to any player`);
    }
    this.dealtCards.delete(cardId);
    this.drawPile.push(cardId);
  }

  public isCardDealt(cardId: number): boolean {
    return this.dealtCards.has(cardId);
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
}