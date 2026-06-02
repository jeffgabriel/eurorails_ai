/**
 * Unit tests for computeIdentity() — freshness identity computation.
 *
 * Verifies hash stability, fact-change discrimination, array canonicalization,
 * and integration with capture().
 */

import { computeIdentity } from '../../services/ai/WorldSnapshotService';
import { WorldSnapshot } from '../../../shared/types/GameTypes';

// ── Minimal snapshot fixture factory ─────────────────────────────────────────

function makeSnapshot(overrides: Partial<WorldSnapshot['bot']> = {}, turnNumber = 1): WorldSnapshot {
  return {
    gameId: 'game-001',
    gameStatus: 'active' as WorldSnapshot['gameStatus'],
    turnNumber,
    activeEffects: [],
    bot: {
      playerId: 'bot-001',
      userId: 'user-001',
      money: 50,
      position: { row: 10, col: 5 },
      existingSegments: [],
      demandCards: [1, 2, 3],
      resolvedDemands: [],
      trainType: 'freight',
      loads: ['coal', 'steel'],
      botConfig: null,
      connectedMajorCityCount: 0,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('computeIdentity', () => {
  describe('hash stability', () => {
    it('produces the same factsHash for identical facts called twice', () => {
      const snapshot = makeSnapshot();
      const id1 = computeIdentity(snapshot);
      const id2 = computeIdentity(snapshot);
      expect(id1.factsHash).toBe(id2.factsHash);
    });

    it('carries the snapshot turnNumber through to the identity', () => {
      const snapshot = makeSnapshot({}, 7);
      const identity = computeIdentity(snapshot);
      expect(identity.turnNumber).toBe(7);
    });

    it('produces a non-empty hex string for factsHash', () => {
      const identity = computeIdentity(makeSnapshot());
      expect(identity.factsHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('fact-change discrimination — loads', () => {
    it('produces different factsHash when carried loads change', () => {
      const withCoal = makeSnapshot({ loads: ['coal'] });
      const withSteel = makeSnapshot({ loads: ['steel'] });
      expect(computeIdentity(withCoal).factsHash).not.toBe(computeIdentity(withSteel).factsHash);
    });

    it('produces different factsHash when a load is added', () => {
      const before = makeSnapshot({ loads: ['coal'] });
      const after = makeSnapshot({ loads: ['coal', 'wheat'] });
      expect(computeIdentity(before).factsHash).not.toBe(computeIdentity(after).factsHash);
    });

    it('produces same factsHash when loads are identical regardless of prior order concerns', () => {
      // Loads arrive in stable order both times — should be stable
      const a = makeSnapshot({ loads: ['coal', 'wheat'] });
      const b = makeSnapshot({ loads: ['coal', 'wheat'] });
      expect(computeIdentity(a).factsHash).toBe(computeIdentity(b).factsHash);
    });
  });

  describe('fact-change discrimination — money', () => {
    it('produces different factsHash when money changes', () => {
      const rich = makeSnapshot({ money: 200 });
      const poor = makeSnapshot({ money: 10 });
      expect(computeIdentity(rich).factsHash).not.toBe(computeIdentity(poor).factsHash);
    });
  });

  describe('fact-change discrimination — position', () => {
    it('produces different factsHash when position changes', () => {
      const atA = makeSnapshot({ position: { row: 1, col: 2 } });
      const atB = makeSnapshot({ position: { row: 5, col: 9 } });
      expect(computeIdentity(atA).factsHash).not.toBe(computeIdentity(atB).factsHash);
    });

    it('produces different factsHash when position goes from null to a coord', () => {
      const noPos = makeSnapshot({ position: null });
      const withPos = makeSnapshot({ position: { row: 10, col: 5 } });
      expect(computeIdentity(noPos).factsHash).not.toBe(computeIdentity(withPos).factsHash);
    });
  });

  describe('fact-change discrimination — demandCards', () => {
    it('produces different factsHash when demand cards change', () => {
      const handA = makeSnapshot({ demandCards: [1, 2, 3] });
      const handB = makeSnapshot({ demandCards: [4, 5, 6] });
      expect(computeIdentity(handA).factsHash).not.toBe(computeIdentity(handB).factsHash);
    });
  });

  describe('fact-change discrimination — activeEffects', () => {
    it('produces different factsHash when an event card becomes active', () => {
      const noEffect: WorldSnapshot = { ...makeSnapshot(), activeEffects: [] };
      const withEffect: WorldSnapshot = {
        ...makeSnapshot(),
        activeEffects: [
          {
            cardId: 125,
            cardType: 'Derailment' as import('../../../shared/types/EventCard').ActiveEffect['cardType'],
            drawingPlayerId: 'p1',
            drawingPlayerIndex: 0,
            expiresAfterTurnNumber: 3,
            affectedZone: new Set<string>(),
            restrictions: { movement: [], build: [], pickupDelivery: [] },
            pendingLostTurns: [],
          },
        ],
      };
      expect(computeIdentity(noEffect).factsHash).not.toBe(computeIdentity(withEffect).factsHash);
    });
  });

  describe('array canonicalization', () => {
    it('produces the same factsHash for loads in different original orders', () => {
      const ab = makeSnapshot({ loads: ['steel', 'coal'] });
      const ba = makeSnapshot({ loads: ['coal', 'steel'] });
      // Both should hash the same because we sort before hashing
      expect(computeIdentity(ab).factsHash).toBe(computeIdentity(ba).factsHash);
    });

    it('produces the same factsHash for demandCards in different original orders', () => {
      const asc = makeSnapshot({ demandCards: [1, 2, 3] });
      const desc = makeSnapshot({ demandCards: [3, 2, 1] });
      expect(computeIdentity(asc).factsHash).toBe(computeIdentity(desc).factsHash);
    });
  });

  describe('edge cases', () => {
    it('handles empty loads array without throwing', () => {
      const snapshot = makeSnapshot({ loads: [] });
      expect(() => computeIdentity(snapshot)).not.toThrow();
    });

    it('handles empty demandCards without throwing', () => {
      const snapshot = makeSnapshot({ demandCards: [] });
      expect(() => computeIdentity(snapshot)).not.toThrow();
    });

    it('handles undefined activeEffects (treats as empty)', () => {
      const snapshot: WorldSnapshot = { ...makeSnapshot(), activeEffects: undefined };
      expect(() => computeIdentity(snapshot)).not.toThrow();
      // Should match a snapshot with an explicit empty array
      const withEmpty: WorldSnapshot = { ...makeSnapshot(), activeEffects: [] };
      expect(computeIdentity(snapshot).factsHash).toBe(computeIdentity(withEmpty).factsHash);
    });
  });
});
