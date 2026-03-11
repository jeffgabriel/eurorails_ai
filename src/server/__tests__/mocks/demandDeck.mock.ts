/**
 * Mock for DemandDeckService.
 * Provides configurable getCard/drawCard/discardCard for test scenarios.
 */

export interface MockDemandCard {
  id: number;
  demands: Array<{ city: string; resource: string; payment: number }>;
}

const cards = new Map<number, MockDemandCard>();
let nextCardId = 200;

const mockInstance = {
  getCard: jest.fn((id: number) => cards.get(id) ?? undefined),
  drawCard: jest.fn(() => {
    const id = nextCardId++;
    const card: MockDemandCard = {
      id,
      demands: [
        { city: 'Berlin', resource: 'Coal', payment: 10 },
        { city: 'Paris', resource: 'Wine', payment: 15 },
        { city: 'London', resource: 'Iron', payment: 12 },
      ],
    };
    cards.set(id, card);
    return card;
  }),
  discardCard: jest.fn(),
};

export const mockDemandDeckService = {
  getInstance: jest.fn(() => mockInstance),
};

export const mockDemandDeckInstance = mockInstance;

/**
 * Register a card so getCard(id) returns it.
 */
export function registerMockCard(card: MockDemandCard): void {
  cards.set(card.id, card);
}

/**
 * Register multiple cards at once.
 */
export function registerMockCards(cardList: MockDemandCard[]): void {
  for (const card of cardList) {
    cards.set(card.id, card);
  }
}

export function resetDemandDeckMock(): void {
  cards.clear();
  nextCardId = 200;
  mockInstance.getCard.mockReset().mockImplementation((id: number) => cards.get(id) ?? undefined);
  mockInstance.drawCard.mockReset().mockImplementation(() => {
    const id = nextCardId++;
    const card: MockDemandCard = {
      id,
      demands: [
        { city: 'Berlin', resource: 'Coal', payment: 10 },
        { city: 'Paris', resource: 'Wine', payment: 15 },
        { city: 'London', resource: 'Iron', payment: 12 },
      ],
    };
    cards.set(id, card);
    return card;
  });
  mockInstance.discardCard.mockReset();
  mockDemandDeckService.getInstance.mockReset().mockReturnValue(mockInstance);
}
