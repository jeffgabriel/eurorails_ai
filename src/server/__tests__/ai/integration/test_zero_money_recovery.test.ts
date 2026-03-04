/**
 * TEST-001: Zero-Money Recovery — Behavior 7
 *
 * Validates that the bot pursues correct recovery strategies when at 0M:
 * - Deliver on existing track if possible
 * - Discard hand if no delivery exists
 * - Never aimlessly move when broke
 *
 * PRD scenario:
 * - Bot at 0M with Wheat deliverable on existing track → move→pickup→deliver
 * - Bot at 0M with no deliverable demand → discard hand
 */

import { zeroMoneyGateAction } from './integrationTestSetup';

describe('Behavior 7: Zero-Money Recovery', () => {
  describe('zero-money gate action selection', () => {
    it('should return no_action when bot has money', () => {
      const action = zeroMoneyGateAction(
        50,    // money > 0
        [],    // loads
        [],    // canDeliver
      );

      expect(action).toBe('no_action');
    });

    it('should return no_action even with 1M', () => {
      const action = zeroMoneyGateAction(1, [], []);
      expect(action).toBe('no_action');
    });

    it('should prioritize delivery when at 0M with deliverable load', () => {
      const action = zeroMoneyGateAction(
        0,                                                     // money = 0
        ['Wheat'],                                             // carrying Wheat
        [{ loadType: 'Wheat', city: 'Berlin' }],               // can deliver to Berlin
      );

      expect(action).toBe('deliver');
    });

    it('should plan move toward delivery when carrying loads but no immediate delivery', () => {
      const action = zeroMoneyGateAction(
        0,                  // money = 0
        ['Coal', 'Wine'],   // carrying loads
        [],                 // no deliverable demand match
      );

      expect(action).toBe('move_toward_delivery');
    });

    it('should discard hand when at 0M with no loads and no deliverables', () => {
      const action = zeroMoneyGateAction(
        0,  // money = 0
        [], // no loads
        [], // no deliverables
      );

      expect(action).toBe('discard_hand');
    });
  });

  describe('recovery path prioritization', () => {
    it('should prefer delivery over discard when both are possible', () => {
      // Even though the bot could discard, delivery earns money → always preferred
      const action = zeroMoneyGateAction(
        0,
        ['Oil'],
        [{ loadType: 'Oil', city: 'Wien' }],
      );

      expect(action).toBe('deliver');
    });

    it('should prefer moving toward delivery over discarding when carrying loads', () => {
      // Bot has loads but can't deliver immediately → move toward delivery city
      // (better than discarding because the load has value)
      const action = zeroMoneyGateAction(
        0,
        ['Iron'],
        [], // no matching demand right now
      );

      expect(action).toBe('move_toward_delivery');
    });

    it('should never return no_action when money is 0', () => {
      // Exhaustive check: at 0M, gate always recommends an action
      const scenarios = [
        { loads: ['Wine'], canDeliver: [{ loadType: 'Wine', city: 'Paris' }] },
        { loads: ['Coal'], canDeliver: [] },
        { loads: [], canDeliver: [] },
      ];

      for (const s of scenarios) {
        const action = zeroMoneyGateAction(0, s.loads, s.canDeliver);
        expect(action).not.toBe('no_action');
      }
    });
  });

  describe('multiple deliverable loads at 0M', () => {
    it('should detect delivery opportunity with multiple loads on train', () => {
      const action = zeroMoneyGateAction(
        0,
        ['Wheat', 'Coal'],
        [
          { loadType: 'Wheat', city: 'Berlin' },
          { loadType: 'Coal', city: 'Hamburg' },
        ],
      );

      expect(action).toBe('deliver');
    });

    it('should detect delivery when only one of multiple loads is deliverable', () => {
      const action = zeroMoneyGateAction(
        0,
        ['Wheat', 'Coal'],
        [{ loadType: 'Coal', city: 'Hamburg' }], // only Coal is deliverable
      );

      expect(action).toBe('deliver');
    });
  });

  describe('no aimless movement at 0M', () => {
    it('should always have a purposeful action at 0M', () => {
      // The zero money gate should ensure the bot never just wanders
      // All three paths are purposeful: deliver, move toward delivery, or discard

      // Path 1: Has deliverable → deliver (earns money)
      expect(
        zeroMoneyGateAction(0, ['Wine'], [{ loadType: 'Wine', city: 'Paris' }]),
      ).toBe('deliver');

      // Path 2: Has loads but no match → move toward delivery (has a goal)
      expect(
        zeroMoneyGateAction(0, ['Wine'], []),
      ).toBe('move_toward_delivery');

      // Path 3: No loads, no delivery → discard (resets hand for new opportunities)
      expect(
        zeroMoneyGateAction(0, [], []),
      ).toBe('discard_hand');
    });

    it('should recommend discard over aimless movement when truly stuck', () => {
      // This is the key anti-pattern: bot has 0M, 0 loads, and wanders.
      // The gate should always produce discard_hand in this case.
      const action = zeroMoneyGateAction(0, [], []);

      // Must NOT be 'no_action' (which would lead to aimless MoveTrain)
      expect(action).toBe('discard_hand');
    });
  });
});
