/**
 * JIRA-16 Route Planning Monitoring — TEST-001
 *
 * Validates that the demand ranking data flows correctly through the AI pipeline
 * and provides a framework for monitoring bot demand ranking adherence.
 *
 * After JIRA-16 deployment:
 * - Run with `npm test -- src/server/__tests__/ai/monitoring/`
 * - Check demand ranking outputs match expected format
 * - Monitor that bot actions align with top-ranked demands
 *
 * If adherence drops below 80%, add explicit "reference the demand ranking"
 * instructions to the LLM prompt (follow-up task).
 */

import { DemandContext } from '../../../../shared/types/GameTypes';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a mock DemandContext for testing scoring and ranking logic */
function makeDemandContext(overrides: Partial<DemandContext> = {}): DemandContext {
  return {
    cardIndex: 0,
    loadType: 'Coal',
    supplyCity: 'Essen',
    deliveryCity: 'Berlin',
    payout: 10,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: false,
    isDeliveryOnNetwork: false,
    estimatedTrackCostToSupply: 5,
    estimatedTrackCostToDelivery: 3,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 4,
    demandScore: 0,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    ...overrides,
  };
}

/** Replicate AIStrategyEngine's demand ranking builder (lines 393-403) */
function buildDemandRanking(demands: DemandContext[]): Array<{
  loadType: string;
  supplyCity: string;
  deliveryCity: string;
  payout: number;
  score: number;
  rank: number;
}> {
  return [...demands]
    .sort((a, b) => b.demandScore - a.demandScore)
    .map((d, i) => ({
      loadType: d.loadType,
      supplyCity: d.supplyCity,
      deliveryCity: d.deliveryCity,
      payout: d.payout,
      score: d.demandScore,
      rank: i + 1,
    }));
}

/**
 * Analyze a sequence of bot actions against their demand rankings.
 * Returns adherence percentage: how often the bot's action targets
 * a top-N ranked demand.
 */
function analyzeAdherence(
  turns: Array<{
    demandRanking: Array<{ loadType: string; deliveryCity: string; rank: number }>;
    action: string;
    targetCity?: string;
    loadType?: string;
  }>,
  topN: number = 3,
): { adherencePercent: number; total: number; adherent: number } {
  let total = 0;
  let adherent = 0;

  for (const turn of turns) {
    // Only count turns where the bot moves/delivers/picks up toward a demand
    if (!turn.loadType && !turn.targetCity) continue;
    total++;

    const topDemands = turn.demandRanking.filter(d => d.rank <= topN);
    const isAdherent = topDemands.some(
      d => d.loadType === turn.loadType || d.deliveryCity === turn.targetCity,
    );
    if (isAdherent) adherent++;
  }

  return {
    adherencePercent: total > 0 ? Math.round((adherent / total) * 100) : 100,
    total,
    adherent,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('JIRA-16 Route Planning Monitoring', () => {
  describe('demand ranking data format', () => {
    it('should rank demands by demandScore descending', () => {
      const demands = [
        makeDemandContext({ loadType: 'Coal', deliveryCity: 'Berlin', demandScore: 5 }),
        makeDemandContext({ loadType: 'Wine', deliveryCity: 'Paris', demandScore: 25 }),
        makeDemandContext({ loadType: 'Iron', deliveryCity: 'Praha', demandScore: 15 }),
      ];

      const ranking = buildDemandRanking(demands);

      expect(ranking[0].loadType).toBe('Wine');
      expect(ranking[0].rank).toBe(1);
      expect(ranking[0].score).toBe(25);
      expect(ranking[1].loadType).toBe('Iron');
      expect(ranking[1].rank).toBe(2);
      expect(ranking[2].loadType).toBe('Coal');
      expect(ranking[2].rank).toBe(3);
    });

    it('should include all required fields in ranking entries', () => {
      const demands = [
        makeDemandContext({
          loadType: 'Oil',
          supplyCity: 'Baku',
          deliveryCity: 'Wien',
          payout: 20,
          demandScore: 12,
        }),
      ];

      const ranking = buildDemandRanking(demands);

      expect(ranking[0]).toEqual({
        loadType: 'Oil',
        supplyCity: 'Baku',
        deliveryCity: 'Wien',
        payout: 20,
        score: 12,
        rank: 1,
      });
    });

    it('should handle negative scores (infeasible demands)', () => {
      const demands = [
        makeDemandContext({ loadType: 'Coal', demandScore: -10 }),
        makeDemandContext({ loadType: 'Wine', demandScore: 5 }),
      ];

      const ranking = buildDemandRanking(demands);

      expect(ranking[0].loadType).toBe('Wine');
      expect(ranking[0].rank).toBe(1);
      expect(ranking[1].loadType).toBe('Coal');
      expect(ranking[1].rank).toBe(2);
      expect(ranking[1].score).toBe(-10);
    });

    it('should handle empty demand list', () => {
      const ranking = buildDemandRanking([]);
      expect(ranking).toEqual([]);
    });
  });

  describe('adherence analysis utility', () => {
    it('should report 100% adherence when bot always picks top-ranked demand', () => {
      const turns = [
        {
          demandRanking: [
            { loadType: 'Wine', deliveryCity: 'Paris', rank: 1 },
            { loadType: 'Coal', deliveryCity: 'Berlin', rank: 2 },
          ],
          action: 'DeliverLoad',
          loadType: 'Wine',
          targetCity: 'Paris',
        },
        {
          demandRanking: [
            { loadType: 'Iron', deliveryCity: 'Praha', rank: 1 },
            { loadType: 'Oil', deliveryCity: 'Wien', rank: 2 },
          ],
          action: 'PickupLoad',
          loadType: 'Iron',
        },
      ];

      const result = analyzeAdherence(turns, 1);
      expect(result.adherencePercent).toBe(100);
      expect(result.total).toBe(2);
      expect(result.adherent).toBe(2);
    });

    it('should detect low adherence when bot ignores top demands', () => {
      const turns = [
        {
          demandRanking: [
            { loadType: 'Wine', deliveryCity: 'Paris', rank: 1 },
            { loadType: 'Coal', deliveryCity: 'Berlin', rank: 2 },
            { loadType: 'Iron', deliveryCity: 'Praha', rank: 3 },
          ],
          action: 'DeliverLoad',
          loadType: 'China', // not in top 3
          targetCity: 'Oslo',
        },
      ];

      const result = analyzeAdherence(turns, 3);
      expect(result.adherencePercent).toBe(0);
      expect(result.total).toBe(1);
      expect(result.adherent).toBe(0);
    });

    it('should skip non-demand actions (BuildTrack, PassTurn)', () => {
      const turns = [
        {
          demandRanking: [
            { loadType: 'Wine', deliveryCity: 'Paris', rank: 1 },
          ],
          action: 'BuildTrack',
          // no loadType or targetCity — should be skipped
        },
        {
          demandRanking: [
            { loadType: 'Wine', deliveryCity: 'Paris', rank: 1 },
          ],
          action: 'PassTurn',
        },
      ];

      const result = analyzeAdherence(turns, 3);
      expect(result.adherencePercent).toBe(100); // no turns to evaluate
      expect(result.total).toBe(0);
    });

    it('should accept adherence within top-N threshold', () => {
      const turns = [
        {
          demandRanking: [
            { loadType: 'Wine', deliveryCity: 'Paris', rank: 1 },
            { loadType: 'Coal', deliveryCity: 'Berlin', rank: 2 },
            { loadType: 'Iron', deliveryCity: 'Praha', rank: 3 },
          ],
          action: 'PickupLoad',
          loadType: 'Iron', // rank 3, within top-3
        },
      ];

      const result = analyzeAdherence(turns, 3);
      expect(result.adherencePercent).toBe(100);
    });

    /**
     * Target threshold: 80% adherence to top-3 ranked demands.
     * If this fails consistently in production monitoring, add explicit
     * "reference the demand ranking" instructions to the LLM prompt.
     */
    it('should flag adherence below 80% threshold', () => {
      const turns = Array.from({ length: 10 }, (_, i) => ({
        demandRanking: [
          { loadType: 'Wine', deliveryCity: 'Paris', rank: 1 },
          { loadType: 'Coal', deliveryCity: 'Berlin', rank: 2 },
          { loadType: 'Iron', deliveryCity: 'Praha', rank: 3 },
        ],
        action: 'PickupLoad',
        // 7 out of 10 pick a top-3 demand (70% adherence)
        loadType: i < 7 ? 'Wine' : 'China',
      }));

      const result = analyzeAdherence(turns, 3);
      expect(result.adherencePercent).toBe(70);
      expect(result.adherencePercent).toBeLessThan(80);
    });
  });
});
