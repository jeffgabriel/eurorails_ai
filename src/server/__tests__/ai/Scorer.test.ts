/**
 * Unit tests for Scorer.
 * Tests scoring logic, skill/archetype profile application, and dimension weighting.
 */

import { getSkillProfile, SKILL_PROFILES } from '../../ai/config/skillProfiles';
import { getArchetypeProfile, ARCHETYPE_PROFILES, ALL_ARCHETYPE_IDS } from '../../ai/config/archetypeProfiles';
import { Scorer } from '../../ai/Scorer';
import { AIActionType } from '../../ai/types';
import type { ScoredOption, FeasibleOption, BotConfig, WorldSnapshot } from '../../ai/types';
import { LoadType } from '../../../shared/types/LoadTypes';
import { TrainType } from '../../../shared/types/GameTypes';
import { makeSnapshot, makeDemandCard } from './helpers/testFixtures';

// --- Helpers ---

function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    skillLevel: 'medium',
    archetype: 'freight_optimizer',
    botId: 'bot-1',
    botName: 'TestBot',
    ...overrides,
  };
}

function makeDeliverOption(
  loadType: LoadType,
  city: string,
  cardId: number,
  demandIndex: number,
): FeasibleOption {
  return {
    type: AIActionType.DeliverLoad,
    description: `Deliver ${loadType} to ${city}`,
    feasible: true,
    params: {
      type: AIActionType.DeliverLoad,
      movePath: [
        { x: 50, y: 50, row: 1, col: 1 },
        { x: 100, y: 100, row: 2, col: 2 },
      ],
      demandCardId: cardId,
      demandIndex,
      loadType,
      city,
    },
  };
}

function makeBuildTrackOption(totalCost: number, segmentCount: number): FeasibleOption {
  const segments = Array.from({ length: segmentCount }, (_, i) => ({
    from: { x: i * 50, y: 0, row: 0, col: i, terrain: 1 as const },
    to: { x: (i + 1) * 50, y: 0, row: 0, col: i + 1, terrain: 1 as const },
    cost: totalCost / segmentCount,
  }));
  return {
    type: AIActionType.BuildTrack,
    description: `Build ${segmentCount} segments (${totalCost}M)`,
    feasible: true,
    params: {
      type: AIActionType.BuildTrack,
      segments,
      totalCost,
    },
  };
}

function makeBuildTowardMajorCityOption(targetCity: string, totalCost: number, segmentCount: number): FeasibleOption {
  const segments = Array.from({ length: segmentCount }, (_, i) => ({
    from: { x: i * 50, y: 0, row: 0, col: i, terrain: 1 as const },
    to: { x: (i + 1) * 50, y: 0, row: 0, col: i + 1, terrain: 1 as const },
    cost: totalCost / segmentCount,
  }));
  return {
    type: AIActionType.BuildTowardMajorCity,
    description: `Build toward ${targetCity} (${totalCost}M)`,
    feasible: true,
    params: {
      type: AIActionType.BuildTowardMajorCity,
      targetCity,
      segments,
      totalCost,
    },
  };
}

function makeUpgradeOption(
  targetTrainType: TrainType,
  kind: 'upgrade' | 'crossgrade',
  cost: number,
): FeasibleOption {
  return {
    type: AIActionType.UpgradeTrain,
    description: `${kind} to ${targetTrainType} (${cost}M)`,
    feasible: true,
    params: {
      type: AIActionType.UpgradeTrain,
      targetTrainType,
      kind,
      cost,
    },
  };
}

function makePassOption(): FeasibleOption {
  return {
    type: AIActionType.PassTurn,
    description: 'Pass turn',
    feasible: true,
    params: { type: AIActionType.PassTurn },
  };
}

function makePickupAndDeliverOption(
  pickupLoadType: LoadType,
  pickupCity: string,
  deliverCity: string,
  cardId: number,
  demandIndex: number,
): FeasibleOption {
  return {
    type: AIActionType.PickupAndDeliver,
    description: `Pick up ${pickupLoadType} at ${pickupCity}, deliver to ${deliverCity}`,
    feasible: true,
    params: {
      type: AIActionType.PickupAndDeliver,
      pickupPath: [
        { x: 50, y: 50, row: 1, col: 1 },
        { x: 100, y: 100, row: 2, col: 2 },
      ],
      pickupCity,
      pickupLoadType,
      deliverPath: [],
      deliverCity,
      demandCardId: cardId,
      demandIndex,
    },
  };
}

// --- Tests ---

describe('Scorer', () => {
  describe('skill profile integration', () => {
    it('should provide valid skill profiles for all levels', () => {
      const levels = ['easy', 'medium', 'hard'] as const;

      for (const level of levels) {
        const profile = getSkillProfile(level);
        expect(profile).toBeDefined();
        expect(profile.baseWeights).toBeDefined();
        expect(typeof profile.randomChoicePercent).toBe('number');
        expect(typeof profile.suboptimalityPercent).toBe('number');
        expect(typeof profile.lookaheadDepth).toBe('number');
      }
    });

    it('should have increasing competence from easy to hard', () => {
      const easy = getSkillProfile('easy');
      const medium = getSkillProfile('medium');
      const hard = getSkillProfile('hard');

      expect(easy.randomChoicePercent).toBeGreaterThan(medium.randomChoicePercent);
      expect(medium.randomChoicePercent).toBeGreaterThan(hard.randomChoicePercent);

      expect(easy.suboptimalityPercent).toBeGreaterThan(medium.suboptimalityPercent);
      expect(medium.suboptimalityPercent).toBeGreaterThanOrEqual(hard.suboptimalityPercent);

      expect(hard.lookaheadDepth).toBeGreaterThan(medium.lookaheadDepth);
      expect(medium.lookaheadDepth).toBeGreaterThan(easy.lookaheadDepth);
    });

    it('should have hard difficulty with 0% random and suboptimal', () => {
      const hard = getSkillProfile('hard');
      expect(hard.randomChoicePercent).toBe(0);
      expect(hard.suboptimalityPercent).toBe(0);
    });
  });

  describe('archetype profile integration', () => {
    it('should provide valid profiles for all archetypes', () => {
      for (const id of ALL_ARCHETYPE_IDS) {
        const profile = getArchetypeProfile(id);
        expect(profile).toBeDefined();
        expect(profile.id).toBe(id);
        expect(profile.name).toBeTruthy();
        expect(profile.description).toBeTruthy();
        expect(profile.multipliers).toBeDefined();
      }
    });

    it('should have 5 archetypes', () => {
      expect(ALL_ARCHETYPE_IDS).toHaveLength(5);
    });

    it('should have distinct strategic focus per archetype', () => {
      const backbone = getArchetypeProfile('backbone_builder');
      const freight = getArchetypeProfile('freight_optimizer');
      const connector = getArchetypeProfile('continental_connector');

      // Backbone Builder emphasizes network expansion
      expect(backbone.multipliers.backboneAlignment).toBeGreaterThan(1.0);

      // Freight Optimizer emphasizes income
      expect(freight.multipliers.incomePerMilepost).toBeGreaterThan(1.0);

      // Continental Connector emphasizes victory progress
      expect(connector.multipliers.victoryProgress).toBeGreaterThan(1.0);
    });
  });

  describe('scored option structure', () => {
    it('should extend FeasibleOption with score and rationale', () => {
      const feasible: FeasibleOption = {
        type: AIActionType.BuildTrack,
        description: 'Build 3 segments',
        feasible: true,
        params: { type: AIActionType.BuildTrack, segments: [], totalCost: 5 },
      };

      const scored: ScoredOption = {
        ...feasible,
        score: 7.5,
        rationale: 'Good network expansion value',
      };

      expect(scored.feasible).toBe(true);
      expect(scored.score).toBe(7.5);
      expect(scored.rationale).toBeTruthy();
    });

    it('should support score comparison for ranking', () => {
      const options: ScoredOption[] = [
        {
          type: AIActionType.BuildTrack,
          description: 'Build track A',
          feasible: true,
          params: { type: AIActionType.BuildTrack, segments: [], totalCost: 3 },
          score: 5.0,
          rationale: 'Moderate value',
        },
        {
          type: AIActionType.DeliverLoad,
          description: 'Deliver Coal to Berlin',
          feasible: true,
          params: { type: AIActionType.DeliverLoad, loadType: LoadType.Coal, city: 'Berlin', demandCardId: 1, demandIndex: 0, movePath: [] },
          score: 9.0,
          rationale: 'High immediate income',
        },
      ];

      const ranked = [...options].sort((a, b) => b.score - a.score);
      expect(ranked[0].type).toBe(AIActionType.DeliverLoad);
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    });
  });

  describe('dimension weight calculation', () => {
    it('should produce final weights by multiplying base weights with archetype multipliers', () => {
      const skill = getSkillProfile('medium');
      const archetype = getArchetypeProfile('backbone_builder');

      // Simulate weight calculation for one dimension
      const baseWeight = skill.baseWeights.networkExpansionValue;
      const multiplier = archetype.multipliers.networkExpansionValue;
      const finalWeight = baseWeight * multiplier;

      expect(finalWeight).toBeGreaterThan(0);
      expect(finalWeight).toBe(baseWeight * multiplier);
    });
  });

  describe('Scorer.score()', () => {
    let snapshot: WorldSnapshot;

    beforeEach(() => {
      snapshot = makeSnapshot({
        money: 80,
        carriedLoads: [LoadType.Coal],
        demandCards: [
          makeDemandCard(1, [
            { city: 'Berlin', resource: LoadType.Coal, payment: 15 },
            { city: 'Paris', resource: LoadType.Wine, payment: 20 },
            { city: 'Roma', resource: LoadType.Oil, payment: 10 },
          ]),
        ],
        connectedMajorCities: 3,
        trainType: TrainType.Freight,
        loadAvailability: new Map([
          ['Hamburg', [LoadType.Coal, LoadType.Oil]],
          ['Lyon', [LoadType.Wine]],
        ]),
      });
    });

    it('should return ScoredOption[] with score and rationale for each option', () => {
      const options: FeasibleOption[] = [
        makeDeliverOption(LoadType.Coal, 'Berlin', 1, 0),
        makePassOption(),
      ];
      const config = makeConfig();

      const result = Scorer.score(options, snapshot, config);

      expect(result).toHaveLength(2);
      for (const opt of result) {
        expect(typeof opt.score).toBe('number');
        expect(typeof opt.rationale).toBe('string');
        expect(opt.feasible).toBe(true);
      }
    });

    it('should return options sorted descending by score', () => {
      const options: FeasibleOption[] = [
        makePassOption(),
        makeDeliverOption(LoadType.Coal, 'Berlin', 1, 0),
        makeBuildTrackOption(5, 3),
      ];
      const config = makeConfig();

      const result = Scorer.score(options, snapshot, config);

      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
      }
    });

    it('should score DeliverLoad higher than PassTurn', () => {
      const options: FeasibleOption[] = [
        makeDeliverOption(LoadType.Coal, 'Berlin', 1, 0),
        makePassOption(),
      ];
      const config = makeConfig();

      const result = Scorer.score(options, snapshot, config);
      const deliver = result.find((o) => o.type === AIActionType.DeliverLoad)!;
      const pass = result.find((o) => o.type === AIActionType.PassTurn)!;

      expect(deliver.score).toBeGreaterThan(pass.score);
    });

    it('should score a high-payment delivery higher than a low-payment one', () => {
      const highPayCard = makeDemandCard(2, [
        { city: 'Paris', resource: LoadType.Coal, payment: 25 },
      ]);
      const lowPayCard = makeDemandCard(3, [
        { city: 'Roma', resource: LoadType.Coal, payment: 5 },
      ]);
      snapshot = makeSnapshot({
        ...snapshot,
        demandCards: [highPayCard, lowPayCard],
        carriedLoads: [LoadType.Coal],
      });

      const options: FeasibleOption[] = [
        makeDeliverOption(LoadType.Coal, 'Paris', 2, 0),
        makeDeliverOption(LoadType.Coal, 'Roma', 3, 0),
      ];
      const config = makeConfig();

      const result = Scorer.score(options, snapshot, config);
      const highPay = result.find((o) => o.params.type === AIActionType.DeliverLoad && (o.params as any).city === 'Paris')!;
      const lowPay = result.find((o) => o.params.type === AIActionType.DeliverLoad && (o.params as any).city === 'Roma')!;

      expect(highPay.score).toBeGreaterThan(lowPay.score);
    });

    it('should produce different scores for different skill levels on the same option', () => {
      const options: FeasibleOption[] = [
        makeDeliverOption(LoadType.Coal, 'Berlin', 1, 0),
      ];

      const easyResult = Scorer.score(options, snapshot, makeConfig({ skillLevel: 'easy' }));
      const hardResult = Scorer.score(options, snapshot, makeConfig({ skillLevel: 'hard' }));

      // Different skill levels have different base weights, so scores should differ
      expect(easyResult[0].score).not.toBe(hardResult[0].score);
    });

    it('should produce different scores for different archetypes on the same option', () => {
      const options: FeasibleOption[] = [
        makeBuildTowardMajorCityOption('Berlin', 10, 5),
      ];

      const backboneResult = Scorer.score(options, snapshot, makeConfig({ archetype: 'backbone_builder' }));
      const freightResult = Scorer.score(options, snapshot, makeConfig({ archetype: 'freight_optimizer' }));

      // Backbone builder should score BuildTowardMajorCity higher
      expect(backboneResult[0].score).toBeGreaterThan(freightResult[0].score);
    });

    it('should score BuildTowardMajorCity with victory progress dimension', () => {
      const options: FeasibleOption[] = [
        makeBuildTowardMajorCityOption('Berlin', 10, 5),
      ];
      const config = makeConfig({ archetype: 'continental_connector' });

      const result = Scorer.score(options, snapshot, config);

      // Continental connector has victoryProgress multiplier of 2.0
      // Score should reflect the high victoryProgress weight
      expect(result[0].score).toBeGreaterThan(0);
      expect(result[0].rationale).toBeTruthy();
    });

    it('should score UpgradeTrain based on speed/capacity gains', () => {
      const options: FeasibleOption[] = [
        makeUpgradeOption(TrainType.FastFreight, 'upgrade', 20),
        makeUpgradeOption(TrainType.HeavyFreight, 'upgrade', 20),
      ];
      const config = makeConfig({ archetype: 'trunk_sprinter' });

      const result = Scorer.score(options, snapshot, config);

      // Both should have positive scores
      expect(result[0].score).toBeGreaterThan(0);
      expect(result[1].score).toBeGreaterThan(0);
    });

    it('should score PickupAndDeliver options', () => {
      const options: FeasibleOption[] = [
        makePickupAndDeliverOption(LoadType.Wine, 'Lyon', 'Paris', 1, 1),
      ];
      snapshot = makeSnapshot({
        ...snapshot,
        carriedLoads: [],
        demandCards: [
          makeDemandCard(1, [
            { city: 'Paris', resource: LoadType.Wine, payment: 20 },
          ]),
        ],
      });
      const config = makeConfig();

      const result = Scorer.score(options, snapshot, config);

      expect(result).toHaveLength(1);
      expect(result[0].score).toBeGreaterThan(0);
    });

    it('should give PassTurn the lowest score among diverse options', () => {
      const options: FeasibleOption[] = [
        makeDeliverOption(LoadType.Coal, 'Berlin', 1, 0),
        makeBuildTrackOption(5, 3),
        makeBuildTowardMajorCityOption('Paris', 10, 5),
        makePassOption(),
      ];
      const config = makeConfig();

      const result = Scorer.score(options, snapshot, config);
      const passOption = result.find((o) => o.type === AIActionType.PassTurn)!;

      // PassTurn should be the lowest scored option
      expect(passOption.score).toBe(Math.min(...result.map((o) => o.score)));
    });

    it('should handle empty options array', () => {
      const result = Scorer.score([], snapshot, makeConfig());
      expect(result).toHaveLength(0);
    });

    it('should backbone_builder archetype favor build actions over delivery', () => {
      const options: FeasibleOption[] = [
        makeBuildTowardMajorCityOption('Berlin', 8, 4),
        makeDeliverOption(LoadType.Coal, 'Berlin', 1, 0),
      ];
      const config = makeConfig({ archetype: 'backbone_builder' });

      // Use a snapshot with low payment delivery to make the build clearly better
      const lowPaySnapshot = makeSnapshot({
        ...snapshot,
        demandCards: [
          makeDemandCard(1, [
            { city: 'Berlin', resource: LoadType.Coal, payment: 5 },
          ]),
        ],
        carriedLoads: [LoadType.Coal],
        connectedMajorCities: 5, // close to victory
      });

      const result = Scorer.score(options, lowPaySnapshot, config);
      const buildOption = result.find((o) => o.type === AIActionType.BuildTowardMajorCity)!;
      const deliverOption = result.find((o) => o.type === AIActionType.DeliverLoad)!;

      // Backbone builder with low-pay delivery and near-victory should favor building
      expect(buildOption.score).toBeGreaterThan(deliverOption.score);
    });
  });
});
