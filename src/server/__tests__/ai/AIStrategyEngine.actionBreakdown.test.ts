/**
 * AIStrategyEngine actionBreakdown tests — TEST-004
 *
 * Tests the actionBreakdown construction logic that maps allSteps + CompositionTrace
 * to an array of {action, actor, detail} entries.
 *
 * The logic is inline in takeTurn(), so we replicate it here to test the algorithm
 * in isolation without requiring the full pipeline mock setup.
 */

import { AIActionType } from '../../../shared/types/GameTypes';
import type { CompositionTrace } from '../../services/ai/TurnComposer';
import type { BotTurnResult } from '../../services/ai/AIStrategyEngine';

/**
 * Replicated actionBreakdown logic from AIStrategyEngine.takeTurn() (lines 1220-1232).
 * This allows us to test the algorithm without mocking the entire pipeline.
 */
function buildActionBreakdown(
  allSteps: Array<{ type: AIActionType; city?: string }>,
  compositionTrace: CompositionTrace | undefined,
  actorMeta: { actor: BotTurnResult['actor']; actorDetail: string },
): Array<{ action: AIActionType; actor: 'llm' | 'system' | 'heuristic'; detail?: string }> {
  const actionBreakdown: Array<{ action: AIActionType; actor: 'llm' | 'system' | 'heuristic'; detail?: string }> = [];
  const a1PickupCities = new Set((compositionTrace?.pickups ?? []).map(p => p.city));
  const primaryActor = actorMeta.actor === 'llm' || actorMeta.actor === 'heuristic' ? actorMeta.actor : 'system' as const;
  for (const step of allSteps) {
    if (step.type === AIActionType.BuildTrack) {
      const buildActor = compositionTrace?.advisor?.fallback ? 'heuristic' as const : 'llm' as const;
      actionBreakdown.push({ action: step.type, actor: buildActor, detail: 'build-advisor' });
    } else if (step.type === AIActionType.PickupLoad && 'city' in step && a1PickupCities.has((step as any).city)) {
      actionBreakdown.push({ action: step.type, actor: 'system', detail: 'a1-opportunistic' });
    } else {
      actionBreakdown.push({ action: step.type as AIActionType, actor: primaryActor, detail: actorMeta.actorDetail });
    }
  }
  return actionBreakdown;
}

describe('actionBreakdown construction', () => {
  const baseTrace: CompositionTrace = {
    inputPlan: [],
    outputPlan: [],
    moveBudget: { total: 9, used: 5, wasted: 4 },
    a1: { citiesScanned: 3, opportunitiesFound: 1 },
    a2: { iterations: 0, terminationReason: 'none' },
    a3: { movePreprended: false },
    build: { target: null, cost: 0, skipped: true, upgradeConsidered: false },
    pickups: [],
    deliveries: [],
  };

  describe('primary LLM steps', () => {
    it('attributes MoveTrain to LLM actor when model is LLM', () => {
      const steps = [{ type: AIActionType.MoveTrain }];
      const result = buildActionBreakdown(steps, baseTrace, { actor: 'llm', actorDetail: 'strategy-brain' });
      expect(result).toEqual([{ action: AIActionType.MoveTrain, actor: 'llm', detail: 'strategy-brain' }]);
    });

    it('attributes MoveTrain to system when model is system', () => {
      const steps = [{ type: AIActionType.MoveTrain }];
      const result = buildActionBreakdown(steps, baseTrace, { actor: 'system', actorDetail: 'route-executor' });
      expect(result).toEqual([{ action: AIActionType.MoveTrain, actor: 'system', detail: 'route-executor' }]);
    });

    it('attributes DeliverLoad to primary actor', () => {
      const steps = [{ type: AIActionType.DeliverLoad }];
      const result = buildActionBreakdown(steps, baseTrace, { actor: 'llm', actorDetail: 'trip-planner' });
      expect(result).toEqual([{ action: AIActionType.DeliverLoad, actor: 'llm', detail: 'trip-planner' }]);
    });
  });

  describe('A1 opportunistic pickups', () => {
    it('attributes PickupLoad to a1-opportunistic when city is in compositionTrace pickups', () => {
      const trace = { ...baseTrace, pickups: [{ load: 'Coal', city: 'Berlin' }] };
      const steps = [
        { type: AIActionType.MoveTrain },
        { type: AIActionType.PickupLoad, city: 'Berlin' },
      ];
      const result = buildActionBreakdown(steps, trace, { actor: 'llm', actorDetail: 'strategy-brain' });
      expect(result).toEqual([
        { action: AIActionType.MoveTrain, actor: 'llm', detail: 'strategy-brain' },
        { action: AIActionType.PickupLoad, actor: 'system', detail: 'a1-opportunistic' },
      ]);
    });

    it('attributes PickupLoad to primary actor when city is NOT in compositionTrace pickups', () => {
      const trace = { ...baseTrace, pickups: [{ load: 'Coal', city: 'Berlin' }] };
      const steps = [{ type: AIActionType.PickupLoad, city: 'Paris' }];
      const result = buildActionBreakdown(steps, trace, { actor: 'llm', actorDetail: 'strategy-brain' });
      expect(result).toEqual([{ action: AIActionType.PickupLoad, actor: 'llm', detail: 'strategy-brain' }]);
    });
  });

  describe('Build Advisor steps', () => {
    it('attributes BuildTrack to llm/build-advisor when advisor did NOT fallback', () => {
      const trace = {
        ...baseTrace,
        advisor: { action: 'build', reasoning: 'test', waypoints: [] as [number, number][], solvencyRetries: 0, latencyMs: 100, fallback: false },
      };
      const steps = [{ type: AIActionType.BuildTrack }];
      const result = buildActionBreakdown(steps, trace, { actor: 'llm', actorDetail: 'strategy-brain' });
      expect(result).toEqual([{ action: AIActionType.BuildTrack, actor: 'llm', detail: 'build-advisor' }]);
    });

    it('attributes BuildTrack to heuristic/build-advisor when advisor used fallback', () => {
      const trace = {
        ...baseTrace,
        advisor: { action: 'build', reasoning: 'test', waypoints: [] as [number, number][], solvencyRetries: 0, latencyMs: 100, fallback: true },
      };
      const steps = [{ type: AIActionType.BuildTrack }];
      const result = buildActionBreakdown(steps, trace, { actor: 'llm', actorDetail: 'strategy-brain' });
      expect(result).toEqual([{ action: AIActionType.BuildTrack, actor: 'heuristic', detail: 'build-advisor' }]);
    });

    it('defaults BuildTrack to llm/build-advisor when no advisor trace', () => {
      const steps = [{ type: AIActionType.BuildTrack }];
      const result = buildActionBreakdown(steps, baseTrace, { actor: 'llm', actorDetail: 'strategy-brain' });
      expect(result).toEqual([{ action: AIActionType.BuildTrack, actor: 'llm', detail: 'build-advisor' }]);
    });
  });

  describe('multi-action turns', () => {
    it('builds correct breakdown for move + pickup + build turn', () => {
      const trace = {
        ...baseTrace,
        pickups: [{ load: 'Oil', city: 'Hamburg' }],
        advisor: { action: 'build', reasoning: 'test', waypoints: [] as [number, number][], solvencyRetries: 0, latencyMs: 200, fallback: false },
      };
      const steps = [
        { type: AIActionType.MoveTrain },
        { type: AIActionType.PickupLoad, city: 'Hamburg' },
        { type: AIActionType.BuildTrack },
      ];
      const result = buildActionBreakdown(steps, trace, { actor: 'llm', actorDetail: 'strategy-brain' });
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ action: AIActionType.MoveTrain, actor: 'llm', detail: 'strategy-brain' });
      expect(result[1]).toEqual({ action: AIActionType.PickupLoad, actor: 'system', detail: 'a1-opportunistic' });
      expect(result[2]).toEqual({ action: AIActionType.BuildTrack, actor: 'llm', detail: 'build-advisor' });
    });

    it('returns empty array for empty allSteps', () => {
      const result = buildActionBreakdown([], baseTrace, { actor: 'llm', actorDetail: 'strategy-brain' });
      expect(result).toEqual([]);
    });
  });
});
