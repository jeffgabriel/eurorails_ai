import fs from 'fs';
import path from 'path';
import { DemandCard, RawDemandCard } from '../../shared/types/DemandCard';

export class DemandDeckService {
  private static instance: DemandDeckService;
  private cards: DemandCard[] = [];
  
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
      
      // Transform raw cards into our internal format with IDs
      this.cards = jsonData.DemandCards.map((card: RawDemandCard, index: number): DemandCard => ({
        id: index + 1,  // 1-based IDs
        destinationCity: card.DestinationCity,
        resource: card.Resource,
        payment: parseInt(card.Payment, 10)  // Convert payment to number
      }));
    } catch (error) {
      console.error('Failed to load demand cards:', error);
      throw error;
    }
  }

  public getAllCards(): DemandCard[] {
    return [...this.cards];
  }

  public getCard(cardId: number): DemandCard | undefined {
    return this.cards.find(card => card.id === cardId);
  }
}

// Export a singleton instance
export const demandDeckService = DemandDeckService.getInstance();