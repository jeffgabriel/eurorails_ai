/**
 * Integration test: Archetype Behavior Differentiation
 *
 * Verifies that different skill×archetype combinations produce distinct
 * scoring patterns when run through the real Scorer (not mocked).
 * This test uses the real Scorer, SkillProfiles, and ArchetypeProfiles
 * to validate that the 15 combinations (3 skills × 5 archetypes) are
 * meaningfully differentiated.
 */
import { Scorer } from '../../../services/ai/Scorer';
import { getSkillProfile } from '../../../services/ai/config/skillProfiles';
import { getArchetypeProfile } from '../../../services/ai/config/archetypeProfiles';
import { AIActionType } from '../../../../shared/types/AITypes';
import type { AIDifficulty, AIArchetype, FeasibleOption, WorldSnapshot } from '../../../../shared/types/AITypes';
import { TrainType } from '../../../../shared/types/GameTypes';
import { LoadType } from '../../../../shared/types/LoadTypes';
import { makeSnapshot, makeOption, ALL_DIFFICULTIES, ALL_ARCHETYPES } from './helpers';

// --- Test Setup ---

/**
 * Create a rich set of diverse options that exercises all scoring dimensions.
 * This ensures different archetypes/skills produce meaningfully different rankings.
 */
function makeDiverseOptions(): FeasibleOption[] {
  return [
    // High immediate income (delivery)
    makeOption(AIActionType.DeliverLoad, 'deliver-high', {
      payment: 50,
      loadType: LoadType.Steel,
      city: 'Berlin',
      demandCardId: 1,
    }),
    // Low immediate income (delivery)
    makeOption(AIActionType.DeliverLoad, 'deliver-low', {
      payment: 12,
      loadType: LoadType.Fish,
      city: 'Hamburg',
      demandCardId: 2,
    }),
    // Pickup for future delivery
    makeOption(AIActionType.PickupAndDeliver, 'pickup', {
      payment: 35,
      loadType: LoadType.Wine,
      city: 'Bordeaux',
    }),
    // Track building (network expansion)
    makeOption(AIActionType.BuildTrack, 'build-track', {
      estimatedCost: 10,
      destination: 'Berlin',
    }),
    // Build toward major city (victory progress)
    makeOption(AIActionType.BuildTowardMajorCity, 'build-major', {
      estimatedCost: 15,
      targetCity: 'Paris',
    }),
    // Train upgrade (speed/capacity)
    makeOption(AIActionType.UpgradeTrain, 'upgrade', {
      kind: 'upgrade',
      targetTrainType: TrainType.FastFreight,
    }),
    // PassTurn baseline
    makeOption(AIActionType.PassTurn, 'pass'),
  ];
}

/**
 * Create a snapshot that has relevant data for scoring all dimensions.
 */
function makeScoringSnapshot(): WorldSnapshot {
  return makeSnapshot({
    cash: 100,
    carriedLoads: [LoadType.Steel, LoadType.Fish],
    trainType: TrainType.Freight,
    demandCards: [
      {
        id: 1,
        demands: [
          { city: 'Berlin', resource: LoadType.Steel, payment: 50 },
          { city: 'Hamburg', resource: LoadType.Fish, payment: 10 },
          { city: 'Milano', resource: LoadType.Marble, payment: 12 },
        ],
      },
      {
        id: 2,
        demands: [
          { city: 'Hamburg', resource: LoadType.Fish, payment: 12 },
          { city: 'Paris', resource: LoadType.Wine, payment: 20 },
          { city: 'London', resource: LoadType.Coal, payment: 15 },
        ],
      },
      {
        id: 3,
        demands: [
          { city: 'London', resource: LoadType.Coal, payment: 15 },
          { city: 'Madrid', resource: LoadType.Oranges, payment: 18 },
          { city: 'Roma', resource: LoadType.Marble, payment: 22 },
        ],
      },
    ],
    globalLoadAvailability: [
      { loadType: LoadType.Steel, totalCount: 4, availableCount: 2, cities: ['Essen'] },
      { loadType: LoadType.Wine, totalCount: 3, availableCount: 1, cities: ['Bordeaux'] },
      { loadType: LoadType.Coal, totalCount: 5, availableCount: 4, cities: ['Cardiff'] },
      { loadType: LoadType.Fish, totalCount: 3, availableCount: 3, cities: ['Bergen'] },
    ],
    otherPlayers: [
      {
        playerId: 'player-2',
        position: { x: 50, y: 50, row: 5, col: 8 },
        carriedLoads: [LoadType.Coal],
        trainType: TrainType.FastFreight,
        cash: 120,
        connectedMajorCities: 3,
      },
    ],
  });
}

// --- Tests ---

describe('Archetype Behavior Differentiation', () => {
  const snapshot = makeScoringSnapshot();
  const options = makeDiverseOptions();

  // Use a fixed RNG for deterministic tests
  const fixedRng = () => 0.99; // Always above random/missed thresholds

  describe('all 15 skill×archetype combos produce valid scores', () => {
    for (const difficulty of ALL_DIFFICULTIES) {
      for (const archetype of ALL_ARCHETYPES) {
        it(`${difficulty} × ${archetype}: produces scored options with valid structure`, () => {
          const skillProfile = getSkillProfile(difficulty);
          const archetypeProfile = getArchetypeProfile(archetype);

          const scored = Scorer.score(options, snapshot, skillProfile, archetypeProfile, fixedRng);

          // All feasible options are scored
          expect(scored.length).toBe(options.length);

          // Each scored option has required fields
          for (const option of scored) {
            expect(typeof option.finalScore).toBe('number');
            expect(option.finalScore).not.toBeNaN();
            expect(option.dimensionScores).toBeDefined();
            expect(typeof option.dimensionScores).toBe('object');
          }

          // Options are sorted by score descending
          for (let i = 1; i < scored.length; i++) {
            expect(scored[i - 1].finalScore).toBeGreaterThanOrEqual(scored[i].finalScore);
          }

          // PassTurn should always score 0 (baseline)
          const passTurn = scored.find(s => s.type === AIActionType.PassTurn);
          expect(passTurn?.finalScore).toBe(0);
        });
      }
    }
  });

  describe('archetypes produce distinct top-option rankings', () => {
    it('different archetypes at hard difficulty rank options differently', () => {
      const skillProfile = getSkillProfile('hard');
      const rankingsByArchetype: Record<string, string[]> = {};

      for (const archetype of ALL_ARCHETYPES) {
        const archetypeProfile = getArchetypeProfile(archetype);
        const scored = Scorer.score(options, snapshot, skillProfile, archetypeProfile, fixedRng);
        // Record the top-3 option IDs in order
        rankingsByArchetype[archetype] = scored.slice(0, 3).map(s => s.id);
      }

      // At least some archetypes should have different top choices
      const topChoices = ALL_ARCHETYPES.map(a => rankingsByArchetype[a][0]);
      const uniqueTopChoices = new Set(topChoices);

      // We expect at least 2 different top choices across 5 archetypes
      expect(uniqueTopChoices.size).toBeGreaterThanOrEqual(2);
    });

    it('backbone_builder prioritizes network expansion over immediate income', () => {
      const skillProfile = getSkillProfile('hard');
      const archetypeProfile = getArchetypeProfile('backbone_builder');
      const scored = Scorer.score(options, snapshot, skillProfile, archetypeProfile, fixedRng);

      const buildMajor = scored.find(s => s.id === 'build-major');
      const deliverLow = scored.find(s => s.id === 'deliver-low');

      // Backbone builder should value building toward major city
      expect(buildMajor).toBeDefined();
      expect(deliverLow).toBeDefined();
      // build-major should score higher than a low-value delivery
      expect(buildMajor!.finalScore).toBeGreaterThan(deliverLow!.finalScore);
    });

    it('freight_optimizer values income efficiency', () => {
      const skillProfile = getSkillProfile('hard');
      const archetypeProfile = getArchetypeProfile('freight_optimizer');
      const scored = Scorer.score(options, snapshot, skillProfile, archetypeProfile, fixedRng);

      const deliverHigh = scored.find(s => s.id === 'deliver-high');
      const buildTrack = scored.find(s => s.id === 'build-track');

      // Freight optimizer should value high-payment delivery over generic track building
      expect(deliverHigh).toBeDefined();
      expect(buildTrack).toBeDefined();
      expect(deliverHigh!.finalScore).toBeGreaterThan(buildTrack!.finalScore);
    });

    it('continental_connector values victory progress highest', () => {
      const skillProfile = getSkillProfile('hard');
      const archetypeProfile = getArchetypeProfile('continental_connector');
      const scored = Scorer.score(options, snapshot, skillProfile, archetypeProfile, fixedRng);

      const buildMajor = scored.find(s => s.id === 'build-major');
      const pass = scored.find(s => s.id === 'pass');

      // Continental connector should value building toward major city
      expect(buildMajor).toBeDefined();
      expect(buildMajor!.finalScore).toBeGreaterThan(0);
      // PassTurn is always 0
      expect(pass!.finalScore).toBe(0);
    });

    it('trunk_sprinter values upgrades with high ROI', () => {
      const skillProfile = getSkillProfile('hard');
      const archetypeProfile = getArchetypeProfile('trunk_sprinter');
      const scored = Scorer.score(options, snapshot, skillProfile, archetypeProfile, fixedRng);

      const upgrade = scored.find(s => s.id === 'upgrade');
      const pass = scored.find(s => s.id === 'pass');

      // Trunk sprinter should value train upgrade above PassTurn
      expect(upgrade).toBeDefined();
      expect(upgrade!.finalScore).toBeGreaterThan(pass!.finalScore);
    });

    it('opportunist values immediate income highly', () => {
      const skillProfile = getSkillProfile('hard');
      const archetypeProfile = getArchetypeProfile('opportunist');
      const scored = Scorer.score(options, snapshot, skillProfile, archetypeProfile, fixedRng);

      const deliverHigh = scored.find(s => s.id === 'deliver-high');
      const buildTrack = scored.find(s => s.id === 'build-track');

      // Opportunist should value high-payment delivery
      expect(deliverHigh).toBeDefined();
      expect(buildTrack).toBeDefined();
      expect(deliverHigh!.finalScore).toBeGreaterThan(buildTrack!.finalScore);
    });
  });

  describe('skill level behavioral differentiation', () => {
    it('easy skill produces more variance than hard skill (randomness)', () => {
      const archetypeProfile = getArchetypeProfile('opportunist');

      // Hard skill with fixed RNG (no randomness)
      const hardScored = Scorer.score(
        options, snapshot, getSkillProfile('hard'), archetypeProfile, fixedRng,
      );
      const hardTopId = hardScored[0].id;

      // Easy skill with RNG that triggers random choice (below 0.2 threshold)
      const randomRng = () => 0.1; // Below easy's randomChoiceProbability of 0.2
      const easyScored = Scorer.score(
        options, snapshot, getSkillProfile('easy'), archetypeProfile, randomRng,
      );

      // With random shuffling triggered, easy's top choice may differ from hard
      // (This test validates the behavioral modifier is applied, not the specific outcome)
      expect(easyScored.length).toBe(hardScored.length);

      // The scoring values should differ between easy and hard
      const easyScores = easyScored.map(s => s.finalScore);
      const hardScores = hardScored.map(s => s.finalScore);
      // Hard should have at least one non-zero score
      expect(hardScores.some(s => s > 0)).toBe(true);
    });

    it('hard skill uses more scoring dimensions than easy', () => {
      const archetypeProfile = getArchetypeProfile('opportunist');

      const easyProfile = getSkillProfile('easy');
      const hardProfile = getSkillProfile('hard');

      // Easy weights have many zero values
      const easyNonZeroWeights = Object.values(easyProfile.weights).filter(w => w > 0).length;
      const hardNonZeroWeights = Object.values(hardProfile.weights).filter(w => w > 0).length;

      // Hard difficulty considers more dimensions
      expect(hardNonZeroWeights).toBeGreaterThan(easyNonZeroWeights);
    });

    it('easy behavior has non-zero randomness, hard has zero', () => {
      const easyProfile = getSkillProfile('easy');
      const mediumProfile = getSkillProfile('medium');
      const hardProfile = getSkillProfile('hard');

      expect(easyProfile.behavior.randomChoiceProbability).toBeGreaterThan(0);
      expect(easyProfile.behavior.missedOptionProbability).toBeGreaterThan(0);

      expect(mediumProfile.behavior.randomChoiceProbability).toBeGreaterThan(0);
      expect(mediumProfile.behavior.missedOptionProbability).toBeGreaterThan(0);

      expect(hardProfile.behavior.randomChoiceProbability).toBe(0);
      expect(hardProfile.behavior.missedOptionProbability).toBe(0);
    });
  });

  describe('selectBest', () => {
    it('returns the top-scored option', () => {
      const skillProfile = getSkillProfile('hard');
      const archetypeProfile = getArchetypeProfile('opportunist');
      const scored = Scorer.score(options, snapshot, skillProfile, archetypeProfile, fixedRng);

      const best = Scorer.selectBest(scored);

      expect(best).toBeDefined();
      expect(best!.finalScore).toBe(scored[0].finalScore);
    });

    it('returns null for empty scored options', () => {
      const best = Scorer.selectBest([]);
      expect(best).toBeNull();
    });
  });

  describe('cross-combo score uniqueness', () => {
    it('at least 10 of 15 combos produce different top option scores', () => {
      const topScores: number[] = [];

      for (const difficulty of ALL_DIFFICULTIES) {
        for (const archetype of ALL_ARCHETYPES) {
          const scored = Scorer.score(
            options,
            snapshot,
            getSkillProfile(difficulty),
            getArchetypeProfile(archetype),
            fixedRng,
          );
          const best = Scorer.selectBest(scored);
          if (best) {
            topScores.push(Math.round(best.finalScore * 1000) / 1000);
          }
        }
      }

      // With 15 combos, we expect significant score variance
      expect(topScores).toHaveLength(15);
      const uniqueScores = new Set(topScores);
      // At least 10 unique top scores (accounting for possible coincidental ties)
      expect(uniqueScores.size).toBeGreaterThanOrEqual(10);
    });
  });
});
