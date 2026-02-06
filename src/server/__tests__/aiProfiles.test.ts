import { SKILL_PROFILES, getSkillProfile } from '../services/ai/config/skillProfiles';
import { ARCHETYPE_PROFILES, getArchetypeProfile } from '../services/ai/config/archetypeProfiles';
import type { AIDifficulty, AIArchetype } from '../../shared/types/AITypes';

describe('AI Configuration Profiles', () => {
  describe('SkillProfiles', () => {
    const difficulties: AIDifficulty[] = ['easy', 'medium', 'hard'];

    it('defines all three difficulty levels', () => {
      for (const d of difficulties) {
        expect(SKILL_PROFILES[d]).toBeDefined();
        expect(SKILL_PROFILES[d].difficulty).toBe(d);
      }
    });

    it('each profile has all scoring weight dimensions', () => {
      const dimensions = [
        'immediateIncome', 'incomePerMilepost', 'multiDeliveryPotential',
        'networkExpansionValue', 'victoryProgress', 'competitorBlocking',
        'riskEventExposure', 'loadScarcity',
      ];
      for (const d of difficulties) {
        for (const dim of dimensions) {
          expect(typeof (SKILL_PROFILES[d].weights as any)[dim]).toBe('number');
        }
      }
    });

    it('easy has higher randomness than hard', () => {
      expect(getSkillProfile('easy').behavior.randomChoiceProbability)
        .toBeGreaterThan(getSkillProfile('hard').behavior.randomChoiceProbability);
    });

    it('hard has zero missed options', () => {
      expect(getSkillProfile('hard').behavior.missedOptionProbability).toBe(0);
    });
  });

  describe('ArchetypeProfiles', () => {
    const archetypes: AIArchetype[] = [
      'backbone_builder', 'freight_optimizer', 'trunk_sprinter',
      'continental_connector', 'opportunist',
    ];

    it('defines all five archetypes', () => {
      for (const a of archetypes) {
        expect(ARCHETYPE_PROFILES[a]).toBeDefined();
        expect(ARCHETYPE_PROFILES[a].archetype).toBe(a);
      }
    });

    it('each profile has all multiplier dimensions', () => {
      const dimensions = [
        'immediateIncome', 'incomePerMilepost', 'multiDeliveryPotential',
        'networkExpansionValue', 'victoryProgress', 'competitorBlocking',
        'riskEventExposure', 'loadScarcity',
        'upgradeRoi', 'backboneAlignment', 'loadCombinationScore', 'majorCityProximity',
      ];
      for (const a of archetypes) {
        for (const dim of dimensions) {
          expect(typeof (ARCHETYPE_PROFILES[a].multipliers as any)[dim]).toBe('number');
        }
      }
    });

    it('backbone_builder has highest backboneAlignment multiplier', () => {
      const bb = getArchetypeProfile('backbone_builder').multipliers.backboneAlignment;
      for (const a of archetypes.filter(x => x !== 'backbone_builder')) {
        expect(bb).toBeGreaterThan(getArchetypeProfile(a).multipliers.backboneAlignment);
      }
    });

    it('freight_optimizer has highest loadCombinationScore multiplier', () => {
      const fo = getArchetypeProfile('freight_optimizer').multipliers.loadCombinationScore;
      for (const a of archetypes.filter(x => x !== 'freight_optimizer')) {
        expect(fo).toBeGreaterThan(getArchetypeProfile(a).multipliers.loadCombinationScore);
      }
    });

    it('continental_connector has highest victoryProgress multiplier', () => {
      const cc = getArchetypeProfile('continental_connector').multipliers.victoryProgress;
      for (const a of archetypes.filter(x => x !== 'continental_connector')) {
        expect(cc).toBeGreaterThan(getArchetypeProfile(a).multipliers.victoryProgress);
      }
    });

    it('trunk_sprinter has highest upgradeRoi multiplier', () => {
      const ts = getArchetypeProfile('trunk_sprinter').multipliers.upgradeRoi;
      for (const a of archetypes.filter(x => x !== 'trunk_sprinter')) {
        expect(ts).toBeGreaterThan(getArchetypeProfile(a).multipliers.upgradeRoi);
      }
    });
  });
});
