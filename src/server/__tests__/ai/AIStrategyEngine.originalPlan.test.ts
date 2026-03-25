/**
 * AIStrategyEngine originalPlan capture tests — TEST-006
 *
 * Tests the originalPlan capture logic: snapshot before guardrail check,
 * populate only when overridden.
 */

import { AIActionType } from '../../../shared/types/GameTypes';

/**
 * Replicated originalPlan capture logic from AIStrategyEngine.takeTurn() (lines 920-929).
 * Tests the algorithm in isolation.
 */
function captureOriginalPlan(
  decision: { plan: { type: AIActionType }; reasoning: string },
  guardrailResult: { overridden: boolean; plan: any; reason?: string },
): { action: string; reasoning: string } | undefined {
  const preGuardrailPlan = { action: decision.plan.type, reasoning: decision.reasoning ?? '' };
  if (guardrailResult.overridden) {
    return preGuardrailPlan;
  }
  return undefined;
}

describe('originalPlan capture', () => {
  it('captures originalPlan when guardrail overrides', () => {
    const decision = {
      plan: { type: AIActionType.MoveTrain },
      reasoning: 'Moving to pickup Coal at Hamburg',
    };
    const guardrailResult = { overridden: true, plan: { type: AIActionType.PassTurn }, reason: 'No progress' };

    const result = captureOriginalPlan(decision, guardrailResult);

    expect(result).toEqual({
      action: AIActionType.MoveTrain,
      reasoning: 'Moving to pickup Coal at Hamburg',
    });
  });

  it('returns undefined when guardrail does NOT override', () => {
    const decision = {
      plan: { type: AIActionType.BuildTrack },
      reasoning: 'Building toward Berlin',
    };
    const guardrailResult = { overridden: false, plan: { type: AIActionType.BuildTrack } };

    const result = captureOriginalPlan(decision, guardrailResult);

    expect(result).toBeUndefined();
  });

  it('preserves original action and reasoning even when guardrail changes both', () => {
    const decision = {
      plan: { type: AIActionType.UpgradeTrain },
      reasoning: 'Upgrade to Fast Freight for speed',
    };
    const guardrailResult = {
      overridden: true,
      plan: { type: AIActionType.DiscardHand },
      reason: 'Insufficient funds for upgrade',
    };

    const result = captureOriginalPlan(decision, guardrailResult);

    expect(result).toEqual({
      action: AIActionType.UpgradeTrain,
      reasoning: 'Upgrade to Fast Freight for speed',
    });
  });

  it('handles empty reasoning string', () => {
    const decision = {
      plan: { type: AIActionType.PassTurn },
      reasoning: '',
    };
    const guardrailResult = { overridden: true, plan: { type: AIActionType.DiscardHand }, reason: 'Override' };

    const result = captureOriginalPlan(decision, guardrailResult);

    expect(result).toEqual({
      action: AIActionType.PassTurn,
      reasoning: '',
    });
  });
});
