# JIRA-100: Post-Delivery Double BUILD Violates $20M/Turn Cap

## Problem

After a mid-turn delivery completes a route, the post-delivery re-planning path (AIStrategyEngine Stage 3d) assembles two independent BUILD actions into a single turn, violating the $20M/turn hard cap.

### Example: Game c9736f59, T5 (player aa9b65d8 "flash")

Bot delivers Wine at Warszawa (cash $34 → $46 after $12M payout). LLM plans new route: Marble@Firenze → Lodz. Post-delivery re-planning produces:
1. BUILD₁ from `PlanExecutor.execute(newRoute)` → `TurnComposer.compose()` ($20M toward Firenze)
2. BUILD₂ from `tryAppendBuild()` ($18M more toward Firenze) — simState NOT updated with BUILD₁

JIRA-91 strips early-executed MoveTrain+DeliverLoad → finalPlan = [BUILD₁, BUILD₂]. TurnExecutor executes both → $38M spent, cash drops to $8M.

### Game Rules

> "A player may spend up to ECU 20 million per turn to: 1. Build track, OR 2. Upgrade their train."

Two BUILD actions in a single turn violate this rule regardless of individual action budgets.

## Root Cause

`AIStrategyEngine.ts` lines 580-602 (Stage 3d):

1. **Line 583-587**: `PlanExecutor.execute(newRoute)` → `TurnComposer.compose()` produces BUILD₁ in `reCompSteps`
2. **Line 595**: `TurnComposer.tryAppendBuild()` produces BUILD₂ in `reBuild`

`simSnapshot` and `simContext` are **not updated** with BUILD₁ before `tryAppendBuild` runs at line 595. So BUILD₂ calculates its budget from stale state (turnBuildCost=0, money=$46) instead of post-BUILD₁ state (turnBuildCost=20, money=$26).

Line 598 assembles both: `[...nonBuildSteps, ...reCompSteps, reBuild]`

## Fix

After the reCompSteps block (line 592), apply reCompSteps to simSnapshot/simContext before calling tryAppendBuild:

```
for (const step of reCompSteps) {
  ActionResolver.applyPlanToState(step, simSnapshot, simContext);
}
```

This ensures tryAppendBuild sees the updated turnBuildCost and money. If BUILD₁ already spent $20M, tryAppendBuild will correctly see budget=0 and return null.

Additionally: if reCompSteps already contains a BuildTrack, tryAppendBuild should be skipped entirely (game rule: one build action per turn).

## Files to Investigate

- `AIStrategyEngine.ts:580-602` — Stage 3d post-delivery re-planning (double build assembly)
