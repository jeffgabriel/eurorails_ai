/**
 * End-to-end test: Bot AI pipeline with REAL grid data.
 *
 * NO mocks for computeBuildSegments, MapTopology, or majorCityGroups.
 * Exercises: OptionGenerator → Scorer → PlanValidator with actual gridPoints.json.
 * Verifies the pipeline produces valid BuildTrack plans for the initial build scenario.
 */

import { OptionGenerator } from '../services/ai/OptionGenerator';
import { Scorer } from '../services/ai/Scorer';
import { validate } from '../services/ai/PlanValidator';
import { _resetCache } from '../services/ai/MapTopology';
import { getMajorCityGroups } from '../../shared/services/majorCityGroups';
import {
  WorldSnapshot,
  AIActionType,
  TerrainType,
} from '../../shared/types/GameTypes';

function makeSnapshot(overrides?: Partial<WorldSnapshot['bot']>): WorldSnapshot {
  return {
    gameId: 'game-e2e',
    gameStatus: 'initialBuild',
    turnNumber: 1,
    bot: {
      playerId: 'bot-e2e',
      userId: 'user-bot-e2e',
      money: 50,
      position: null,
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

describe('Bot Pipeline E2E (real grid data)', () => {
  beforeEach(() => _resetCache());

  describe('initial build — no existing track', () => {
    it('should generate feasible BuildTrack options from major cities', () => {
      const snapshot = makeSnapshot();
      const options = OptionGenerator.generate(snapshot);

      const buildTrack = options.find(
        (o) => o.action === AIActionType.BuildTrack && o.feasible,
      );
      expect(buildTrack).toBeDefined();
      expect(buildTrack!.segments!.length).toBeGreaterThan(0);
      expect(buildTrack!.estimatedCost).toBeGreaterThan(0);
    });

    it('should produce segments starting from a MajorCity terrain', () => {
      const snapshot = makeSnapshot();
      const options = OptionGenerator.generate(snapshot);

      const buildTrack = options.find(
        (o) => o.action === AIActionType.BuildTrack && o.feasible,
      );
      expect(buildTrack).toBeDefined();
      expect(buildTrack!.segments![0].from.terrain).toBe(TerrainType.MajorCity);
    });

    it('should score BuildTrack higher than PassTurn', () => {
      const snapshot = makeSnapshot();
      const options = OptionGenerator.generate(snapshot);
      const scored = Scorer.score(options, snapshot, null);

      expect(scored[0].action).toBe(AIActionType.BuildTrack);
      expect(scored[0].feasible).toBe(true);
      expect(scored[0].score!).toBeGreaterThan(0);
    });

    it('should pass PlanValidator for initial build', () => {
      const snapshot = makeSnapshot();
      const options = OptionGenerator.generate(snapshot);
      const scored = Scorer.score(options, snapshot, null);
      const topOption = scored[0];

      expect(topOption.action).toBe(AIActionType.BuildTrack);

      const result = validate(topOption, snapshot);
      expect(result.valid).toBe(true);
    });

    it('full pipeline: generate → score → validate produces executable plan', () => {
      const snapshot = makeSnapshot();

      // 1. Generate
      const options = OptionGenerator.generate(snapshot);
      const buildTrack = options.find(
        (o) => o.action === AIActionType.BuildTrack && o.feasible,
      );
      expect(buildTrack).toBeDefined();

      // 2. Score
      const scored = Scorer.score(options, snapshot, null);
      const topPlan = scored[0];
      expect(topPlan.action).toBe(AIActionType.BuildTrack);
      expect(topPlan.feasible).toBe(true);

      // 3. Validate
      const validation = validate(topPlan, snapshot);
      expect(validation.valid).toBe(true);

      // 4. Verify plan properties
      expect(topPlan.segments!.length).toBeGreaterThan(0);
      expect(topPlan.segments!.length).toBeLessThanOrEqual(3);
      const totalCost = topPlan.segments!.reduce((s, seg) => s + seg.cost, 0);
      expect(totalCost).toBeLessThanOrEqual(20);
      expect(totalCost).toBeLessThanOrEqual(snapshot.bot.money);

      // 5. Segments are contiguous
      for (let i = 1; i < topPlan.segments!.length; i++) {
        const prev = topPlan.segments![i - 1].to;
        const curr = topPlan.segments![i].from;
        expect(prev.row).toBe(curr.row);
        expect(prev.col).toBe(curr.col);
      }
    });
  });

  describe('major city data sanity', () => {
    it('should find major cities from gridPoints.json', () => {
      const groups = getMajorCityGroups();
      expect(groups.length).toBeGreaterThan(0);
      // EuroRails has Paris, Berlin, Madrid, etc.
      const names = groups.map((g) => g.cityName);
      expect(names).toContain('Paris');
    });

    it('major city centers should exist in the grid', () => {
      const { loadGridPoints } = require('../services/ai/MapTopology');
      const grid = loadGridPoints();
      const groups = getMajorCityGroups();

      for (const group of groups) {
        const key = `${group.center.row},${group.center.col}`;
        const point = grid.get(key);
        expect(point).toBeDefined();
        expect(point!.terrain).toBe(TerrainType.MajorCity);
      }
    });
  });
});
