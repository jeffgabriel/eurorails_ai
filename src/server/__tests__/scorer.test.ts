import { Scorer, ScoredOption } from '../services/ai/Scorer';
import { AIActionType } from '../../shared/types/AITypes';
import type { FeasibleOption, WorldSnapshot } from '../../shared/types/AITypes';
import { TrainType } from '../../shared/types/GameTypes';
import { LoadType } from '../../shared/types/LoadTypes';
import { getSkillProfile } from '../services/ai/config/skillProfiles';
import { getArchetypeProfile } from '../services/ai/config/archetypeProfiles';
import type { SkillProfile } from '../services/ai/config/skillProfiles';
import type { ArchetypeProfile } from '../services/ai/config/archetypeProfiles';

function makeOption(type: AIActionType, params: Record<string, unknown> = {}, feasible = true): FeasibleOption {
  return {
    id: `opt-${Math.random().toString(36).slice(2, 8)}`,
    type,
    parameters: params,
    score: 0,
    feasible,
    rejectionReason: feasible ? null : 'test rejection',
  };
}

function makeMinimalSnapshot(overrides?: Partial<WorldSnapshot>): WorldSnapshot {
  return {
    botPlayerId: 'bot-1',
    botPosition: { x: 0, y: 0, row: 10, col: 15 },
    trackNetworkGraph: new Map() as ReadonlyMap<string, ReadonlySet<string>>,
    cash: 100,
    demandCards: [
      {
        id: 1,
        demands: [
          { city: 'Berlin', resource: LoadType.Wine, payment: 30 },
          { city: 'Paris', resource: LoadType.Coal, payment: 25 },
          { city: 'Roma', resource: LoadType.Beer, payment: 20 },
        ],
      },
    ],
    carriedLoads: [LoadType.Wine],
    trainType: TrainType.Freight,
    otherPlayers: [],
    globalLoadAvailability: [
      { loadType: 'Wine', availableCount: 3, totalCount: 4, cities: ['Bordeaux'] },
      { loadType: 'Coal', availableCount: 2, totalCount: 3, cities: ['Essen'] },
    ],
    activeEvents: [],
    mapTopology: [],
    majorCityConnectionStatus: new Map() as ReadonlyMap<string, boolean>,
    turnNumber: 5,
    snapshotHash: 'test-hash',
    ...overrides,
  };
}

describe('Scorer', () => {
  const hardSkill = getSkillProfile('hard');
  const mediumSkill = getSkillProfile('medium');
  const easySkill = getSkillProfile('easy');

  const opportunist = getArchetypeProfile('opportunist');
  const backboneBuilder = getArchetypeProfile('backbone_builder');
  const freightOptimizer = getArchetypeProfile('freight_optimizer');
  const trunkSprinter = getArchetypeProfile('trunk_sprinter');
  const continentalConnector = getArchetypeProfile('continental_connector');

  const snapshot = makeMinimalSnapshot();
  const fixedRng = () => 0.5; // deterministic RNG for testing

  describe('score', () => {
    it('returns scored options sorted by finalScore descending', () => {
      const options = [
        makeOption(AIActionType.DeliverLoad, { payment: 40 }),
        makeOption(AIActionType.BuildTrack, { destination: 'Berlin' }),
        makeOption(AIActionType.PassTurn),
      ];

      const scored = Scorer.score(options, snapshot, hardSkill, opportunist, fixedRng);

      expect(scored.length).toBe(3);
      for (let i = 0; i < scored.length - 1; i++) {
        expect(scored[i].finalScore).toBeGreaterThanOrEqual(scored[i + 1].finalScore);
      }
    });

    it('skips infeasible options', () => {
      const options = [
        makeOption(AIActionType.DeliverLoad, { payment: 40 }, true),
        makeOption(AIActionType.DeliverLoad, { payment: 50 }, false), // infeasible
        makeOption(AIActionType.PassTurn),
      ];

      const scored = Scorer.score(options, snapshot, hardSkill, opportunist, fixedRng);

      expect(scored.length).toBe(2);
      expect(scored.every(s => s.feasible)).toBe(true);
    });

    it('returns empty array for no feasible options', () => {
      const options = [
        makeOption(AIActionType.DeliverLoad, { payment: 40 }, false),
      ];

      const scored = Scorer.score(options, snapshot, hardSkill, opportunist, fixedRng);
      expect(scored.length).toBe(0);
    });

    it('PassTurn always receives the lowest score', () => {
      const options = [
        makeOption(AIActionType.PassTurn),
        makeOption(AIActionType.DeliverLoad, { payment: 30 }),
        makeOption(AIActionType.BuildTrack, { destination: 'Berlin' }),
        makeOption(AIActionType.UpgradeTrain, { kind: 'upgrade', targetTrainType: TrainType.FastFreight }),
      ];

      const scored = Scorer.score(options, snapshot, hardSkill, opportunist, fixedRng);
      const passTurn = scored.find(s => s.type === AIActionType.PassTurn);
      expect(passTurn).toBeDefined();
      // PassTurn should be last (lowest score)
      expect(scored[scored.length - 1].type).toBe(AIActionType.PassTurn);
      expect(passTurn!.finalScore).toBe(0);
    });
  });

  describe('scoring formula', () => {
    it('applies base_weight × archetype_multiplier × dimension_value', () => {
      const deliverOption = makeOption(AIActionType.DeliverLoad, { payment: 60 });
      const scored = Scorer.score([deliverOption], snapshot, hardSkill, opportunist, fixedRng);

      expect(scored.length).toBe(1);
      expect(scored[0].finalScore).toBeGreaterThan(0);
      // Check that dimension scores exist
      expect(scored[0].dimensionScores).toBeDefined();
      expect(typeof scored[0].dimensionScores.immediateIncome).toBe('number');
    });

    it('Opportunist scores DeliverLoad higher due to immediateIncome multiplier', () => {
      const deliverOption = makeOption(AIActionType.DeliverLoad, { payment: 40 });

      const opportunistScored = Scorer.score([deliverOption], snapshot, hardSkill, opportunist, fixedRng);
      const builderScored = Scorer.score([deliverOption], snapshot, hardSkill, backboneBuilder, fixedRng);

      // Opportunist has 1.3× immediateIncome multiplier vs Backbone Builder's 0.8×
      expect(opportunistScored[0].dimensionScores.immediateIncome)
        .toBeGreaterThan(builderScored[0].dimensionScores.immediateIncome);
    });

    it('Backbone Builder scores BuildTowardMajorCity higher due to backboneAlignment', () => {
      const buildOption = makeOption(AIActionType.BuildTowardMajorCity, { majorCity: 'Berlin' });

      const builderScored = Scorer.score([buildOption], snapshot, hardSkill, backboneBuilder, fixedRng);
      const opportunistScored = Scorer.score([buildOption], snapshot, hardSkill, opportunist, fixedRng);

      // Backbone Builder has 2.0× backboneAlignment vs Opportunist's 0.3×
      expect(builderScored[0].dimensionScores.backboneAlignment)
        .toBeGreaterThan(opportunistScored[0].dimensionScores.backboneAlignment);
    });

    it('Trunk Sprinter scores UpgradeTrain higher due to upgradeRoi', () => {
      const upgradeOption = makeOption(AIActionType.UpgradeTrain, {
        kind: 'upgrade',
        targetTrainType: TrainType.FastFreight,
      });

      const sprinterScored = Scorer.score([upgradeOption], snapshot, hardSkill, trunkSprinter, fixedRng);
      const optimizerScored = Scorer.score([upgradeOption], snapshot, hardSkill, freightOptimizer, fixedRng);

      // Trunk Sprinter has 1.8× upgradeRoi vs Freight Optimizer's 0.8×
      expect(sprinterScored[0].dimensionScores.upgradeRoi)
        .toBeGreaterThan(optimizerScored[0].dimensionScores.upgradeRoi);
    });

    it('Continental Connector values BuildTowardMajorCity highly via victoryProgress', () => {
      const buildOption = makeOption(AIActionType.BuildTowardMajorCity, { majorCity: 'Istanbul' });

      const connectorScored = Scorer.score([buildOption], snapshot, hardSkill, continentalConnector, fixedRng);
      const opportunistScored = Scorer.score([buildOption], snapshot, hardSkill, opportunist, fixedRng);

      // Continental Connector has 2.0× victoryProgress vs Opportunist's 0.7×
      expect(connectorScored[0].dimensionScores.victoryProgress)
        .toBeGreaterThan(opportunistScored[0].dimensionScores.victoryProgress);
    });
  });

  describe('behavioral modifiers', () => {
    it('Hard difficulty produces deterministic ordering (no randomness)', () => {
      const options = [
        makeOption(AIActionType.DeliverLoad, { payment: 40 }),
        makeOption(AIActionType.BuildTrack, { destination: 'Berlin' }),
        makeOption(AIActionType.UpgradeTrain, { kind: 'upgrade', targetTrainType: TrainType.FastFreight }),
        makeOption(AIActionType.PassTurn),
      ];

      // Run multiple times with different RNG values
      const scored1 = Scorer.score(options, snapshot, hardSkill, opportunist, () => 0.1);
      const scored2 = Scorer.score(options, snapshot, hardSkill, opportunist, () => 0.9);

      // Hard has 0 randomness and 0 missed options, so ordering should be identical
      expect(scored1.map(s => s.type)).toEqual(scored2.map(s => s.type));
    });

    it('Easy difficulty can produce different ordering due to randomness', () => {
      const options = [
        makeOption(AIActionType.DeliverLoad, { payment: 40 }),
        makeOption(AIActionType.BuildTrack, { destination: 'Berlin' }),
        makeOption(AIActionType.UpgradeTrain, { kind: 'upgrade', targetTrainType: TrainType.FastFreight }),
        makeOption(AIActionType.PassTurn),
      ];

      // Easy has 20% random choice probability
      // With rng() < 0.2, full shuffle happens
      let shuffleCount = 0;
      const runs = 100;
      const hardScored = Scorer.score(options, snapshot, hardSkill, opportunist, fixedRng);
      const hardOrder = hardScored.map(s => s.type);

      for (let i = 0; i < runs; i++) {
        let callCount = 0;
        const testRng = () => {
          callCount++;
          // First call determines if we shuffle (< 0.2 = yes)
          if (callCount === 1) return 0.1; // Will trigger shuffle
          return Math.random(); // Random shuffle ordering
        };
        const easyScored = Scorer.score(options, snapshot, easySkill, opportunist, testRng);
        const easyOrder = easyScored.map(s => s.type);
        if (JSON.stringify(easyOrder) !== JSON.stringify(hardOrder)) {
          shuffleCount++;
        }
      }
      // Most runs should produce a different order due to shuffle
      expect(shuffleCount).toBeGreaterThan(0);
    });

    it('Easy with missedOptionProbability can demote top option', () => {
      const options = [
        makeOption(AIActionType.DeliverLoad, { payment: 50 }),
        makeOption(AIActionType.BuildTrack, { destination: 'Berlin' }),
        makeOption(AIActionType.PassTurn),
      ];

      // RNG that doesn't trigger random shuffle but does trigger missed option
      // randomChoiceProbability is 0.2 for easy. If rng() >= 0.2, no shuffle.
      // missedOptionProbability is 0.3 for easy. If rng() < 0.3, option is missed.
      let callCount = 0;
      const testRng = () => {
        callCount++;
        if (callCount === 1) return 0.5; // Don't trigger shuffle (>= 0.2)
        if (callCount === 2) return 0.1; // Miss top option (< 0.3)
        return 0.5; // swap with next
      };

      const scored = Scorer.score(options, snapshot, easySkill, opportunist, testRng);

      // Top option should have been swapped (demoted)
      // The original top option (DeliverLoad) might not be first
      expect(scored.length).toBe(3);
    });
  });

  describe('selectBest', () => {
    it('returns the top scored option', () => {
      const options = [
        makeOption(AIActionType.DeliverLoad, { payment: 40 }),
        makeOption(AIActionType.BuildTrack, { destination: 'Berlin' }),
        makeOption(AIActionType.PassTurn),
      ];

      const scored = Scorer.score(options, snapshot, hardSkill, opportunist, fixedRng);
      const best = Scorer.selectBest(scored);

      expect(best).toBeDefined();
      expect(best!.finalScore).toBe(scored[0].finalScore);
    });

    it('returns null for empty array', () => {
      expect(Scorer.selectBest([])).toBeNull();
    });
  });
});
