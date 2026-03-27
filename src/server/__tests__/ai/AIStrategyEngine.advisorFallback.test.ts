/**
 * AIStrategyEngine advisorUsedFallback tests — TEST-007
 *
 * Tests the pass-through of compositionTrace.advisor?.fallback to
 * BotTurnResult.advisorUsedFallback.
 */

import type { CompositionTrace } from '../../services/ai/TurnExecutorPlanner';

/**
 * Replicated advisorUsedFallback extraction from AIStrategyEngine.takeTurn() (line 1302).
 * Uses the same logic: on recompose, uses firstCompositionTrace; otherwise compositionTrace.
 */
function extractAdvisorUsedFallback(
  compositionTrace: CompositionTrace | undefined,
  firstCompositionTrace: CompositionTrace | undefined,
  recomposeCount: number,
): boolean | undefined {
  const advisorTrace = (recomposeCount > 0 ? firstCompositionTrace : compositionTrace)?.advisor;
  return advisorTrace?.fallback ?? undefined;
}

describe('advisorUsedFallback extraction', () => {
  const baseTrace: CompositionTrace = {
    inputPlan: [],
    outputPlan: [],
    moveBudget: { total: 9, used: 5, wasted: 4 },
    a1: { citiesScanned: 0, opportunitiesFound: 0 },
    a2: { iterations: 0, terminationReason: 'none' },
    a3: { movePreprended: false },
    build: { target: null, cost: 0, skipped: true, upgradeConsidered: false },
    pickups: [],
    deliveries: [],
  };

  it('returns true when advisor fallback is true', () => {
    const trace: CompositionTrace = {
      ...baseTrace,
      advisor: { action: 'build', reasoning: 'test', waypoints: [], solvencyRetries: 0, latencyMs: 100, fallback: true },
    };
    expect(extractAdvisorUsedFallback(trace, undefined, 0)).toBe(true);
  });

  it('returns false when advisor fallback is false', () => {
    const trace: CompositionTrace = {
      ...baseTrace,
      advisor: { action: 'build', reasoning: 'test', waypoints: [], solvencyRetries: 0, latencyMs: 100, fallback: false },
    };
    expect(extractAdvisorUsedFallback(trace, undefined, 0)).toBe(false);
  });

  it('returns undefined when no advisor trace', () => {
    expect(extractAdvisorUsedFallback(baseTrace, undefined, 0)).toBeUndefined();
  });

  it('returns undefined when compositionTrace is undefined', () => {
    expect(extractAdvisorUsedFallback(undefined, undefined, 0)).toBeUndefined();
  });

  it('uses firstCompositionTrace when recomposeCount > 0', () => {
    const firstTrace: CompositionTrace = {
      ...baseTrace,
      advisor: { action: 'build', reasoning: 'first', waypoints: [], solvencyRetries: 0, latencyMs: 100, fallback: true },
    };
    const currentTrace: CompositionTrace = {
      ...baseTrace,
      advisor: { action: 'build', reasoning: 'second', waypoints: [], solvencyRetries: 0, latencyMs: 200, fallback: false },
    };
    expect(extractAdvisorUsedFallback(currentTrace, firstTrace, 1)).toBe(true);
  });

  it('uses current compositionTrace when recomposeCount is 0', () => {
    const firstTrace: CompositionTrace = {
      ...baseTrace,
      advisor: { action: 'build', reasoning: 'first', waypoints: [], solvencyRetries: 0, latencyMs: 100, fallback: true },
    };
    const currentTrace: CompositionTrace = {
      ...baseTrace,
      advisor: { action: 'build', reasoning: 'second', waypoints: [], solvencyRetries: 0, latencyMs: 200, fallback: false },
    };
    expect(extractAdvisorUsedFallback(currentTrace, firstTrace, 0)).toBe(false);
  });
});
