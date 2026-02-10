import {
  SKILL_PROFILES,
  getSkillProfile,
} from '../../ai/config/skillProfiles';
import {
  ARCHETYPE_PROFILES,
  getArchetypeProfile,
  ALL_ARCHETYPE_IDS,
} from '../../ai/config/archetypeProfiles';
import {
  SkillLevel,
  ArchetypeId,
  ScoringDimension,
  DimensionWeights,
} from '../../ai/types';

const ALL_DIMENSIONS: ScoringDimension[] = [
  'immediateIncome',
  'incomePerMilepost',
  'multiDeliveryPotential',
  'networkExpansionValue',
  'victoryProgress',
  'competitorBlocking',
  'riskExposure',
  'loadScarcity',
  'upgradeROI',
  'backboneAlignment',
  'loadCombinationScore',
  'majorCityProximity',
];

describe('Skill Profiles', () => {
  const levels: SkillLevel[] = ['easy', 'medium', 'hard'];

  it('should define profiles for all skill levels', () => {
    for (const level of levels) {
      expect(SKILL_PROFILES[level]).toBeDefined();
      expect(SKILL_PROFILES[level].level).toBe(level);
    }
  });

  it('should have baseWeights covering all scoring dimensions', () => {
    for (const level of levels) {
      const profile = SKILL_PROFILES[level];
      for (const dim of ALL_DIMENSIONS) {
        expect(typeof profile.baseWeights[dim]).toBe('number');
      }
    }
  });

  it('should have non-negative weight values', () => {
    for (const level of levels) {
      const profile = SKILL_PROFILES[level];
      for (const dim of ALL_DIMENSIONS) {
        expect(profile.baseWeights[dim]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('should have decreasing randomness from easy to hard', () => {
    expect(SKILL_PROFILES.easy.randomChoicePercent).toBeGreaterThan(
      SKILL_PROFILES.medium.randomChoicePercent
    );
    expect(SKILL_PROFILES.medium.randomChoicePercent).toBeGreaterThan(
      SKILL_PROFILES.hard.randomChoicePercent
    );
  });

  it('should have decreasing suboptimality from easy to hard', () => {
    expect(SKILL_PROFILES.easy.suboptimalityPercent).toBeGreaterThan(
      SKILL_PROFILES.medium.suboptimalityPercent
    );
    expect(SKILL_PROFILES.medium.suboptimalityPercent).toBeGreaterThanOrEqual(
      SKILL_PROFILES.hard.suboptimalityPercent
    );
  });

  it('should have increasing lookahead depth from easy to hard', () => {
    expect(SKILL_PROFILES.easy.lookaheadDepth).toBeLessThan(
      SKILL_PROFILES.medium.lookaheadDepth
    );
    expect(SKILL_PROFILES.medium.lookaheadDepth).toBeLessThan(
      SKILL_PROFILES.hard.lookaheadDepth
    );
  });

  it('should have hard profile with zero randomness and suboptimality', () => {
    expect(SKILL_PROFILES.hard.randomChoicePercent).toBe(0);
    expect(SKILL_PROFILES.hard.suboptimalityPercent).toBe(0);
  });

  describe('getSkillProfile', () => {
    it('should return the correct profile for each level', () => {
      for (const level of levels) {
        expect(getSkillProfile(level)).toBe(SKILL_PROFILES[level]);
      }
    });
  });
});

describe('Archetype Profiles', () => {
  const archetypeIds: ArchetypeId[] = [
    'backbone_builder',
    'freight_optimizer',
    'trunk_sprinter',
    'continental_connector',
    'opportunist',
  ];

  it('should define profiles for all archetype IDs', () => {
    for (const id of archetypeIds) {
      expect(ARCHETYPE_PROFILES[id]).toBeDefined();
      expect(ARCHETYPE_PROFILES[id].id).toBe(id);
    }
  });

  it('should have multipliers covering all scoring dimensions', () => {
    for (const id of archetypeIds) {
      const profile = ARCHETYPE_PROFILES[id];
      for (const dim of ALL_DIMENSIONS) {
        expect(typeof profile.multipliers[dim]).toBe('number');
      }
    }
  });

  it('should have positive multiplier values', () => {
    for (const id of archetypeIds) {
      const profile = ARCHETYPE_PROFILES[id];
      for (const dim of ALL_DIMENSIONS) {
        expect(profile.multipliers[dim]).toBeGreaterThan(0);
      }
    }
  });

  it('should have name and description for each profile', () => {
    for (const id of archetypeIds) {
      const profile = ARCHETYPE_PROFILES[id];
      expect(profile.name.length).toBeGreaterThan(0);
      expect(profile.description.length).toBeGreaterThan(0);
    }
  });

  it('should emphasize backbone_builder network dimensions', () => {
    const bb = ARCHETYPE_PROFILES.backbone_builder;
    expect(bb.multipliers.backboneAlignment).toBeGreaterThan(1.0);
    expect(bb.multipliers.networkExpansionValue).toBeGreaterThan(1.0);
    expect(bb.multipliers.majorCityProximity).toBeGreaterThan(1.0);
  });

  it('should emphasize freight_optimizer income dimensions', () => {
    const fo = ARCHETYPE_PROFILES.freight_optimizer;
    expect(fo.multipliers.immediateIncome).toBeGreaterThan(1.0);
    expect(fo.multipliers.incomePerMilepost).toBeGreaterThan(1.0);
    expect(fo.multipliers.loadCombinationScore).toBeGreaterThan(1.0);
  });

  it('should emphasize trunk_sprinter upgrade dimension', () => {
    const ts = ARCHETYPE_PROFILES.trunk_sprinter;
    expect(ts.multipliers.upgradeROI).toBeGreaterThan(1.0);
  });

  it('should emphasize continental_connector victory dimensions', () => {
    const cc = ARCHETYPE_PROFILES.continental_connector;
    expect(cc.multipliers.victoryProgress).toBeGreaterThan(1.0);
    expect(cc.multipliers.majorCityProximity).toBeGreaterThan(1.0);
  });

  it('should emphasize opportunist adaptive dimensions', () => {
    const op = ARCHETYPE_PROFILES.opportunist;
    expect(op.multipliers.competitorBlocking).toBeGreaterThan(1.0);
    expect(op.multipliers.loadScarcity).toBeGreaterThan(1.0);
  });

  describe('getArchetypeProfile', () => {
    it('should return the correct profile for each ID', () => {
      for (const id of archetypeIds) {
        expect(getArchetypeProfile(id)).toBe(ARCHETYPE_PROFILES[id]);
      }
    });
  });

  describe('ALL_ARCHETYPE_IDS', () => {
    it('should contain all archetype IDs', () => {
      expect(ALL_ARCHETYPE_IDS).toHaveLength(archetypeIds.length);
      for (const id of archetypeIds) {
        expect(ALL_ARCHETYPE_IDS).toContain(id);
      }
    });
  });
});
