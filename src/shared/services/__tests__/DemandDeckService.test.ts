import { DemandDeckService } from '../DemandDeckService';
import { DemandCard } from '../../types/DemandCard';
import { LoadType } from '../../types/LoadTypes';

// Mock fetch for client-side implementation
const mockCards: DemandCard[] = [
  {
    id: 1,
    demands: [
      { city: "Berlin", resource: LoadType.Cattle, payment: 17 },
      { city: "Paris", resource: LoadType.Beer, payment: 23 },
      { city: "London", resource: LoadType.Coal, payment: 15 }
    ]
  },
  {
    id: 2,
    demands: [
      { city: "Lyon", resource: LoadType.Iron, payment: 26 },
      { city: "Madrid", resource: LoadType.Steel, payment: 19 },
      { city: "Milano", resource: LoadType.Iron, payment: 21 }
    ]
  },
  {
    id: 3,
    demands: [
      { city: "Budapest", resource: LoadType.Machinery, payment: 22 },
      { city: "Wien", resource: LoadType.Wine, payment: 18 },
      { city: "Praha", resource: LoadType.Beer, payment: 24 }
    ]
  }
];

global.fetch = jest.fn().mockImplementation(() => 
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve(mockCards)
  })
);

describe('DemandDeckService', () => {
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    (fetch as jest.Mock).mockClear();
    // Store the original console.error
    originalConsoleError = console.error;
    // Mock console.error to prevent error output during tests
    console.error = jest.fn();
  });

  afterEach(() => {
    // Restore the original console.error
    console.error = originalConsoleError;
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
    expect(card?.demands).toHaveLength(3);
    expect(card?.demands[0]).toEqual({
      city: 'Berlin',
      resource: LoadType.Cattle,
      payment: 17
    });
  });

  it('should throw error when discarding invalid card ID', async () => {
    const service = new DemandDeckService();
    await service.loadCards();
    
    expect(() => {
      service.discardCard(999);  // Invalid ID
    }).toThrow('Invalid card ID: 999');
  });

  it('should validate that cards have exactly 3 demands', async () => {
    const invalidMockCards = [
      {
        id: 1,
        demands: [
          { city: "Berlin", resource: LoadType.Cattle, payment: 17 },
          { city: "Paris", resource: LoadType.Beer, payment: 23 }
        ]
      }
    ];

    global.fetch = jest.fn().mockImplementation(() => 
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(invalidMockCards)
      })
    );

    const service = new DemandDeckService();
    await expect(service.loadCards()).rejects.toThrow('Found cards with incorrect number of demands: 1');
    expect(console.error).toHaveBeenCalled();
  });
});