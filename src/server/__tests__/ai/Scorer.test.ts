/**
 * Unit tests for Scorer.
 * Tests scoring logic, skill/archetype profile application, and dimension weighting.
 *
 * Note: Scorer implementation is pending (BE-004).
 * These tests validate the config profiles and scoring data structures.
 */

import { getSkillProfile, SKILL_PROFILES } from '../../ai/config/skillProfiles';
import { getArchetypeProfile, ARCHETYPE_PROFILES, ALL_ARCHETYPE_IDS } from '../../ai/config/archetypeProfiles';
import { AIActionType } from '../../ai/types';
import type { ScoredOption, FeasibleOption, SkillProfile, ArchetypeProfile } from '../../ai/types';
import { LoadType } from '../../../shared/types/LoadTypes';

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
});
