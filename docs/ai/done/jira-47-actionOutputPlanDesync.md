# JIRA-47: Action/OutputPlan Desync — Valid Plans Overridden with DiscardHand

**Severity:** Critical
**Source:** Game `a5766427` analysis — both bots, T7-T11

## Problem

The TurnComposer produces a valid composition (e.g., MOVE, PICKUP, DELIVER) but the final action sent to the game engine is DiscardHand. The `outputPlan` in the LLM log shows a legitimate plan, yet the `action` field in the game log records a discard instead.

This is distinct from the heuristic fallback issue (JIRA-44) — the desync occurs even when the LLM call succeeds and returns a valid plan.

## Evidence — Game `a5766427`

- Both bots exhibit this pattern across T7-T11
- The composition logs show valid multi-step plans with MOVE/PICKUP/DELIVER actions
- The actual executed action is DiscardHand, contradicting the composed plan
- This causes cascading failures as bots lose their hands and progress

## Expected Behavior

When TurnComposer produces a valid plan and all steps resolve successfully, the first action in the plan should be executed — never silently replaced with DiscardHand.

## Possible Root Cause

Something between TurnComposer output and TurnExecutor input is overriding the composed plan. Possible points of failure:
- GuardrailEnforcer intercepting after composition
- PlanExecutor re-evaluating and discarding the plan
- A race condition or state mismatch between composition and execution

## Files

- `src/server/services/ai/TurnComposer.ts` (plan composition)
- `src/server/services/ai/TurnExecutor.ts` (plan execution)
- `src/server/services/ai/GuardrailEnforcer.ts` (may be intercepting valid plans)
- `src/server/services/ai/PlanExecutor.ts` (plan routing)
