import type { FeasibleOption, WorldSnapshot } from '../../../shared/types/AITypes';
import { AIActionType } from '../../../shared/types/AITypes';
import type { SkillProfile, ScoringWeights } from './config/skillProfiles';
import type { ArchetypeProfile, ArchetypeMultipliers } from './config/archetypeProfiles';

/**
 * A FeasibleOption augmented with a final score and dimension breakdown.
 */
export interface ScoredOption extends FeasibleOption {
  readonly finalScore: number;
  readonly dimensionScores: Record<string, number>;
}

/** Names of all scoring dimensions (shared base + archetype-specific). */
type BaseDimension = keyof ScoringWeights;
type ArchetypeDimension = keyof ArchetypeMultipliers;

/** All dimension names used in scoring. */
const BASE_DIMENSIONS: BaseDimension[] = [
  'immediateIncome',
  'incomePerMilepost',
  'multiDeliveryPotential',
  'networkExpansionValue',
  'victoryProgress',
  'competitorBlocking',
  'riskEventExposure',
  'loadScarcity',
];

const ARCHETYPE_ONLY_DIMENSIONS: Array<Exclude<ArchetypeDimension, BaseDimension>> = [
  'upgradeRoi',
  'backboneAlignment',
  'loadCombinationScore',
  'majorCityProximity',
];

/**
 * Extract dimension values from an option's parameters and context.
 * Returns a value between 0 and 1 for each dimension.
 */
function extractDimensionValues(
  option: FeasibleOption,
  snapshot: WorldSnapshot,
): Record<string, number> {
  const values: Record<string, number> = {};
  const params = option.parameters;

  // Initialize all dimensions to 0
  for (const dim of [...BASE_DIMENSIONS, ...ARCHETYPE_ONLY_DIMENSIONS]) {
    values[dim] = 0;
  }

  switch (option.type) {
    case AIActionType.DeliverLoad: {
      const payment = (params.payment as number) || 0;
      // Normalize payment (typical range 10-60M) to 0-1
      values.immediateIncome = Math.min(1, payment / 60);
      // Income per milepost is approximated by payment
      values.incomePerMilepost = Math.min(1, payment / 40);
      // Delivery contributes to multi-delivery if bot is carrying multiple loads
      values.multiDeliveryPotential = snapshot.carriedLoads.length > 1 ? 0.7 : 0.3;
      break;
    }
    case AIActionType.PickupAndDeliver: {
      const payment = (params.payment as number) || 0;
      values.immediateIncome = 0; // No immediate income from pickup
      values.incomePerMilepost = Math.min(1, payment / 40);
      values.multiDeliveryPotential = 0.5;
      // Check if pickup load is scarce
      const loadType = params.loadType as string;
      const loadState = snapshot.globalLoadAvailability.find(s => s.loadType === loadType);
      if (loadState && loadState.totalCount > 0) {
        values.loadScarcity = 1 - (loadState.availableCount / loadState.totalCount);
      }
      // Load combination score: higher if supply city is near other delivery destinations
      values.loadCombinationScore = 0.4;
      break;
    }
    case AIActionType.BuildTrack: {
      values.networkExpansionValue = 0.7;
      // Check if this builds toward a demand city
      const destination = params.destination as string;
      const isDemandCity = snapshot.demandCards.some(
        card => card.demands.some(d => d.city === destination),
      );
      if (isDemandCity) {
        values.networkExpansionValue = 0.9;
        values.multiDeliveryPotential = 0.4;
      }
      // Backbone alignment: high if extending a main trunk
      values.backboneAlignment = 0.5;
      break;
    }
    case AIActionType.UpgradeTrain: {
      const kind = params.kind as string;
      if (kind === 'upgrade') {
        values.upgradeRoi = 0.8;
        // Speed upgrade boosts income-per-milepost potential
        values.incomePerMilepost = 0.3;
      } else {
        // Crossgrade
        values.upgradeRoi = 0.4;
      }
      break;
    }
    case AIActionType.BuildTowardMajorCity: {
      values.victoryProgress = 0.8;
      values.networkExpansionValue = 0.6;
      values.majorCityProximity = 0.9;
      // Backbone alignment for building toward major cities
      values.backboneAlignment = 0.6;
      break;
    }
    case AIActionType.PassTurn: {
      // All dimensions stay at 0 - PassTurn is the baseline
      break;
    }
  }

  return values;
}

/**
 * Apply the scoring formula:
 * finalScore = Σ(base_weight[skill] × archetype_multiplier × dimension_value)
 *
 * Base dimensions use skill weights; archetype-only dimensions use a default base weight of 0.5.
 */
function computeScore(
  dimensionValues: Record<string, number>,
  skillProfile: SkillProfile,
  archetypeProfile: ArchetypeProfile,
): { finalScore: number; dimensionScores: Record<string, number> } {
  const dimensionScores: Record<string, number> = {};
  let totalScore = 0;

  // Score base dimensions
  for (const dim of BASE_DIMENSIONS) {
    const baseWeight = skillProfile.weights[dim];
    const multiplier = archetypeProfile.multipliers[dim];
    const value = dimensionValues[dim] || 0;
    const score = baseWeight * multiplier * value;
    dimensionScores[dim] = score;
    totalScore += score;
  }

  // Score archetype-only dimensions (default base weight = 0.5 for medium, scaled by skill)
  const archetypeBaseWeight = skillProfile.difficulty === 'easy' ? 0.2
    : skillProfile.difficulty === 'medium' ? 0.5
      : 0.7; // hard
  for (const dim of ARCHETYPE_ONLY_DIMENSIONS) {
    const multiplier = archetypeProfile.multipliers[dim];
    const value = dimensionValues[dim] || 0;
    const score = archetypeBaseWeight * multiplier * value;
    dimensionScores[dim] = score;
    totalScore += score;
  }

  return { finalScore: totalScore, dimensionScores };
}

export class Scorer {
  /**
   * Score feasible options using skill profile weights and archetype multipliers.
   * Returns scored options sorted by finalScore (descending).
   *
   * Applies skill-level behavioral modifiers:
   * - Easy: 20% random choice probability, 30% chance to miss best option
   * - Medium: 5% random choice, 10% miss probability
   * - Hard: 0% random, 0% miss
   *
   * @param options - Feasible options to score
   * @param snapshot - World state for dimension value extraction
   * @param skillProfile - Skill level configuration
   * @param archetypeProfile - Archetype multipliers
   * @param rng - Optional random number generator (0-1) for deterministic testing
   */
  static score(
    options: FeasibleOption[],
    snapshot: WorldSnapshot,
    skillProfile: SkillProfile,
    archetypeProfile: ArchetypeProfile,
    rng: () => number = Math.random,
  ): ScoredOption[] {
    // Only score feasible options
    const feasible = options.filter(o => o.feasible);
    if (feasible.length === 0) return [];

    // Score each option
    let scored: ScoredOption[] = feasible.map(option => {
      const dimensionValues = extractDimensionValues(option, snapshot);
      const { finalScore, dimensionScores } = computeScore(
        dimensionValues,
        skillProfile,
        archetypeProfile,
      );
      return {
        ...option,
        finalScore,
        dimensionScores,
      };
    });

    // Sort by score descending
    scored.sort((a, b) => b.finalScore - a.finalScore);

    // Apply skill-level behavioral modifiers
    scored = this.applyBehavioralModifiers(scored, skillProfile, rng);

    return scored;
  }

  /**
   * Apply skill-level behavioral modifiers to the scored options.
   *
   * - missedOptionProbability: chance each top option is "missed" (shuffled down)
   * - randomChoiceProbability: chance of selecting a random option instead
   */
  private static applyBehavioralModifiers(
    scored: ScoredOption[],
    skillProfile: SkillProfile,
    rng: () => number,
  ): ScoredOption[] {
    if (scored.length <= 1) return scored;

    const { randomChoiceProbability, missedOptionProbability } = skillProfile.behavior;

    // Random choice: shuffle the entire list
    if (randomChoiceProbability > 0 && rng() < randomChoiceProbability) {
      // Fisher-Yates shuffle
      const shuffled = [...scored];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    }

    // Missed option: the best option(s) may be "missed", moving them down the list
    if (missedOptionProbability > 0) {
      const result = [...scored];
      // Check top options - if missed, swap with the next one
      for (let i = 0; i < Math.min(3, result.length - 1); i++) {
        if (rng() < missedOptionProbability) {
          // Swap this option with a random lower-ranked one
          const swapIdx = Math.min(i + 1 + Math.floor(rng() * 3), result.length - 1);
          [result[i], result[swapIdx]] = [result[swapIdx], result[i]];
        }
      }
      return result;
    }

    return scored;
  }

  /**
   * Select the best option from scored options.
   * Returns the top-scored option after behavioral modifiers are applied.
   */
  static selectBest(scored: ScoredOption[]): ScoredOption | null {
    if (scored.length === 0) return null;
    return scored[0];
  }
}
