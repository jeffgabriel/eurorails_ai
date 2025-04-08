import { PlayerHand } from "../PlayerHand";
import { DemandCard } from "../DemandCard";

describe("PlayerHand", () => {
  let hand: PlayerHand;
  const mockCard1: DemandCard = {
    id: 1,
    destinationCity: "Berlin",
    resource: "Cattle",
    payment: 17,
  };
  const mockCard2: DemandCard = {
    id: 2,
    destinationCity: "Lyon",
    resource: "Copper",
    payment: 26,
  };
  const mockCard3: DemandCard = {
    id: 3,
    destinationCity: "Budapest",
    resource: "Machinery",
    payment: 22,
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
      hand.addCard({ ...mockCard1, id: 4 });
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
});
