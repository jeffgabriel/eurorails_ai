import { DemandCard } from './DemandCard';

export class PlayerHand {
  private cards: DemandCard[] = [];
  private readonly maxCards: number = 3;  // Maximum number of cards allowed in hand

  constructor() {}

  /**
   * Add a card to the player's hand
   * @throws Error if hand is already full
   */
  public addCard(card: DemandCard): void {
    if (this.cards.length >= this.maxCards) {
      throw new Error(`Cannot add card: hand is full (max ${this.maxCards} cards)`);
    }
    this.cards.push(card);
  }

  /**
   * Remove a card from the player's hand
   * @throws Error if card is not in hand
   */
  public removeCard(cardId: number): DemandCard {
    const index = this.cards.findIndex(card => card.id === cardId);
    if (index === -1) {
      throw new Error(`Card ${cardId} is not in player's hand`);
    }
    return this.cards.splice(index, 1)[0];
  }

  /**
   * Check if a specific card is in the player's hand
   */
  public hasCard(cardId: number): boolean {
    return this.cards.some(card => card.id === cardId);
  }

  /**
   * Get all cards in the player's hand
   */
  public getCards(): readonly DemandCard[] {
    return Object.freeze([...this.cards]);
  }

  /**
   * Get the number of cards in hand
   */
  public getCardCount(): number {
    return this.cards.length;
  }

  /**
   * Check if the hand is full
   */
  public isFull(): boolean {
    return this.cards.length >= this.maxCards;
  }

  /**
   * Get a specific card from the hand without removing it
   */
  public getCard(cardId: number): DemandCard | undefined {
    return this.cards.find(card => card.id === cardId);
  }
} 