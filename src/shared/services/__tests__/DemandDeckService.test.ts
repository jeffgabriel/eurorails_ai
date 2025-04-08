import { DemandDeckService } from '../DemandDeckService';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs and path modules
jest.mock('fs');
jest.mock('path');

describe('DemandDeckService', () => {
  const mockCards = {
    DemandCards: [
      {
        DestinationCity: "Berlin",
        Resource: "Cattle",
        Payment: "17"
      },
      {
        DestinationCity: "Lyon",
        Resource: "Copper",
        Payment: "26"
      },
      {
        DestinationCity: "Budapest",
        Resource: "Machinery",
        Payment: "22"
      }
    ]
  };

  beforeEach(() => {
    // Setup mocks
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(mockCards));
    (path.resolve as jest.Mock).mockReturnValue('/mock/path/demand_cards.json');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should load cards on initialization', () => {
    const service = new DemandDeckService();
    const state = service.getDeckState();
    
    expect(state.totalCards).toBe(3);
    expect(state.drawPileSize).toBe(3);
    expect(state.discardPileSize).toBe(0);
  });

  it('should draw cards correctly', () => {
    const service = new DemandDeckService();
    
    // Draw all cards
    const card1 = service.drawCard();
    const card2 = service.drawCard();
    const card3 = service.drawCard();
    
    expect(card1).toBeTruthy();
    expect(card2).toBeTruthy();
    expect(card3).toBeTruthy();
    
    // Verify draw pile is empty
    const state = service.getDeckState();
    expect(state.drawPileSize).toBe(0);
  });

  it('should handle discard and reshuffle', () => {
    const service = new DemandDeckService();
    
    // Draw and discard all cards
    const card1 = service.drawCard();
    const card2 = service.drawCard();
    const card3 = service.drawCard();
    
    if (card1 && card2 && card3) {
      service.discardCard(card1.id);
      service.discardCard(card2.id);
      service.discardCard(card3.id);
    }
    
    // Verify cards moved to discard pile
    let state = service.getDeckState();
    expect(state.discardPileSize).toBe(3);
    expect(state.drawPileSize).toBe(0);
    
    // Draw a card, which should trigger reshuffle
    const newCard = service.drawCard();
    expect(newCard).toBeTruthy();
    
    // Verify reshuffle happened
    state = service.getDeckState();
    expect(state.discardPileSize).toBe(0);
    expect(state.drawPileSize).toBe(2);
  });

  it('should return null when no cards are available', () => {
    const service = new DemandDeckService();
    
    // Draw all cards but don't discard them
    service.drawCard();
    service.drawCard();
    service.drawCard();
    
    // Try to draw when no cards are available
    const card = service.drawCard();
    expect(card).toBeNull();
  });

  it('should get card by ID', () => {
    const service = new DemandDeckService();
    const card = service.getCard(1);
    
    expect(card).toBeTruthy();
    expect(card?.id).toBe(1);
    expect(card?.destinationCity).toBe('Berlin');
    expect(card?.resource).toBe('Cattle');
    expect(card?.payment).toBe(17);
  });

  it('should throw error when discarding invalid card ID', () => {
    const service = new DemandDeckService();
    
    expect(() => {
      service.discardCard(999);  // Invalid ID
    }).toThrow('Invalid card ID: 999');
  });
}); 