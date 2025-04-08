import { DemandDeckService } from '../DemandDeckService';

// Mock fetch for client-side implementation
global.fetch = jest.fn().mockImplementation(() => 
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve([
      {
        id: 1,
        destinationCity: "Berlin",
        resource: "Cattle",
        payment: 17
      },
      {
        id: 2,
        destinationCity: "Lyon",
        resource: "Copper",
        payment: 26
      },
      {
        id: 3,
        destinationCity: "Budapest",
        resource: "Machinery",
        payment: 22
      }
    ])
  })
);

describe('DemandDeckService', () => {
  beforeEach(() => {
    (fetch as jest.Mock).mockClear();
  });

  it('should load cards from API', async () => {
    const service = new DemandDeckService();
    await service.loadCards();
    const state = service.getDeckState();
    
    expect(state.totalCards).toBe(3);
    expect(state.drawPileSize).toBe(3);
    expect(state.discardPileSize).toBe(0);
    expect(fetch).toHaveBeenCalledWith('/api/deck/demand');
  });

  it('should draw cards correctly', async () => {
    const service = new DemandDeckService();
    await service.loadCards();
    
    // Draw all cards
    const card1 = await service.drawCard();
    const card2 = await service.drawCard();
    const card3 = await service.drawCard();
    
    expect(card1).toBeTruthy();
    expect(card2).toBeTruthy();
    expect(card3).toBeTruthy();
    
    // Verify draw pile is empty
    const state = service.getDeckState();
    expect(state.drawPileSize).toBe(0);
  });

  it('should handle discard and reshuffle', async () => {
    const service = new DemandDeckService();
    await service.loadCards();
    
    // Draw and discard all cards
    const card1 = await service.drawCard();
    const card2 = await service.drawCard();
    const card3 = await service.drawCard();
    
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
    const newCard = await service.drawCard();
    expect(newCard).toBeTruthy();
    
    // Verify reshuffle happened
    state = service.getDeckState();
    expect(state.discardPileSize).toBe(0);
    expect(state.drawPileSize).toBe(2);
  });

  it('should return null when no cards are available', async () => {
    const service = new DemandDeckService();
    await service.loadCards();
    
    // Draw all cards but don't discard them
    await service.drawCard();
    await service.drawCard();
    await service.drawCard();
    
    // Try to draw when no cards are available
    const card = await service.drawCard();
    expect(card).toBeNull();
  });

  it('should get card by ID', async () => {
    const service = new DemandDeckService();
    await service.loadCards();
    
    const card = service.getCard(1);
    
    expect(card).toBeTruthy();
    expect(card?.id).toBe(1);
    expect(card?.destinationCity).toBe('Berlin');
    expect(card?.resource).toBe('Cattle');
    expect(card?.payment).toBe(17);
  });

  it('should throw error when discarding invalid card ID', async () => {
    const service = new DemandDeckService();
    await service.loadCards();
    
    expect(() => {
      service.discardCard(999);  // Invalid ID
    }).toThrow('Invalid card ID: 999');
  });
});