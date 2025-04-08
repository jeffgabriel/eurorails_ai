import { DemandCard, RawDemandCard } from '../types/DemandCard';
import * as fs from 'fs';
import * as path from 'path';

export class DemandDeckService {
  private cards: DemandCard[] = [];
  private drawPile: number[] = [];  // Array of card IDs in the draw pile
  private discardPile: number[] = [];  // Array of card IDs in the discard pile
  private dealtCards: Set<number> = new Set();  // Set of card IDs currently dealt to players
  
  constructor() {
    this.loadCards();
  }

  private loadCards(): void {
    try {
      // Read the JSON file
      const configPath = path.resolve(__dirname, '../../../configuration/demand_cards.json');
      const rawData = fs.readFileSync(configPath, 'utf8');
      const jsonData = JSON.parse(rawData);
      
      // Transform raw cards into our internal format with IDs
      this.cards = jsonData.DemandCards.map((card: RawDemandCard, index: number): DemandCard => ({
        id: index + 1,  // 1-based IDs
        destinationCity: card.DestinationCity,
        resource: card.Resource,
        payment: parseInt(card.Payment, 10)  // Convert payment to number
      }));

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