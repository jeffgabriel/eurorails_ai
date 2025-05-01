import { PlayerHand } from "../PlayerHand";
import { DemandCard } from "../DemandCard";
import { LoadType } from "../LoadTypes";

describe("PlayerHand", () => {
  let hand: PlayerHand;
  const mockCard1: DemandCard = {
    id: 1,
    demands: [
      { city: "Berlin", resource: LoadType.Cattle, payment: 17 },
      { city: "Paris", resource: LoadType.Beer, payment: 23 },
      { city: "London", resource: LoadType.Coal, payment: 15 }
    ]
  };
  const mockCard2: DemandCard = {
    id: 2,
    demands: [
      { city: "Lyon", resource: LoadType.Iron, payment: 26 },
      { city: "Madrid", resource: LoadType.Steel, payment: 19 },
      { city: "Milano", resource: LoadType.Iron, payment: 21 }
    ]
  };
  const mockCard3: DemandCard = {
    id: 3,
    demands: [
      { city: "Budapest", resource: LoadType.Machinery, payment: 22 },
      { city: "Wien", resource: LoadType.Wine, payment: 18 },
      { city: "Praha", resource: LoadType.Beer, payment: 24 }
    ]
  };

  beforeEach(() => {
    hand = new PlayerHand();
  });

  it("should start empty", () => {
    expect(hand.getCardCount()).toBe(0);
    expect(hand.getCards()).toHaveLength(0);
    expect(hand.isFull()).toBe(false);
  });

  it("should add cards correctly", () => {
    hand.addCard(mockCard1);
    expect(hand.getCardCount()).toBe(1);
    expect(hand.hasCard(mockCard1.id)).toBe(true);
    expect(hand.getCard(mockCard1.id)).toEqual(mockCard1);
  });

  it("should throw error when adding to a full hand", () => {
    hand.addCard(mockCard1);
    hand.addCard(mockCard2);
    hand.addCard(mockCard3);

    expect(() => {
      hand.addCard({
        id: 4,
        demands: [
          { city: "Roma", resource: LoadType.Wine, payment: 20 },
          { city: "Marseille", resource: LoadType.Wheat, payment: 25 },
          { city: "Hamburg", resource: LoadType.Beer, payment: 22 }
        ]
      });
    }).toThrow("Cannot add card: hand is full (max 3 cards)");
  });

  it("should remove cards correctly", () => {
    hand.addCard(mockCard1);
    hand.addCard(mockCard2);

    const removedCard = hand.removeCard(mockCard1.id);
    expect(removedCard).toEqual(mockCard1);
    expect(hand.getCardCount()).toBe(1);
    expect(hand.hasCard(mockCard1.id)).toBe(false);
  });

  it("should throw error when removing non-existent card", () => {
    expect(() => {
      hand.removeCard(999);
    }).toThrow("Card 999 is not in player's hand");
  });

  it("should correctly report full status", () => {
    expect(hand.isFull()).toBe(false);

    hand.addCard(mockCard1);
    hand.addCard(mockCard2);
    expect(hand.isFull()).toBe(false);

    hand.addCard(mockCard3);
    expect(hand.isFull()).toBe(true);
  });

  it("should return immutable card list", () => {
    hand.addCard(mockCard1);
    const cards = hand.getCards();
    const originalLength = cards.length;

    // Attempt to modify the returned array
    try {
      // @ts-ignore - Testing runtime immutability
      cards.push(mockCard2);
    } catch (e) {
      // Expected to throw if array is frozen
    }

    // Verify the array wasn't modified (either it threw or the push had no effect)
    expect(cards.length).toBe(originalLength);
    
    // Verify the hand wasn't modified
    expect(hand.getCardCount()).toBe(1);
  });

  it("should verify each card has exactly three demands", () => {
    const invalidCard = {
      id: 4,
      demands: [
        { city: "Roma", resource: LoadType.Wine, payment: 20 },
        { city: "Marseille", resource: LoadType.Wheat, payment: 25 }
        // Missing third demand to test validation
      ]
    };

    expect(() => {
      hand.addCard(invalidCard as DemandCard);
    }).toThrow("Demand card must have exactly 3 demands");
  });
});
