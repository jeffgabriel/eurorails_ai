# JIRA-119: Upgrade Delivery Gate

## Problem

Observed in game `48ca7f82`: bot upgraded its train after only 1 delivery. The upgrade gate was set to 1 delivery, and the LLM prompt said "after your FIRST delivery." The `upgradeOnRoute` path in the LLM route response bypasses the guardrail entirely — `tryConsumeUpgrade()` only checks path validity and affordability, not delivery count.

## Current State (dirty changes on branch that need cleanup)

Incomplete/scattered changes exist on branch `compounds/204v5-cont` from an initial attempt. These will be revised or reverted as part of this plan:

- **GuardrailEnforcer G3b**: Added a guardrail blocking upgrades before N deliveries. Needs removal — upgrades via `upgradeOnRoute` bypass the guardrail entirely, so it only catches the rare case where the LLM's *main action* is `UpgradeTrain`.
- **Prompt/ContextBuilder tweaks**: Partial changes to delivery thresholds. Will be revised to use the shared constant.

## Plan

### 1. Add a global constant for the delivery threshold

In `AIStrategyEngine.ts`, add near the top:

```typescript
/**
 * Minimum number of completed deliveries before a bot may upgrade its train.
 * Prevents premature upgrades that leave the bot cash-poor and unable to build track.
 * Adjust this value to tune bot upgrade timing across all skill levels.
 */
export const MIN_DELIVERIES_BEFORE_UPGRADE = 4;
```

### 2. Gate `tryConsumeUpgrade()` with delivery count

`tryConsumeUpgrade` is the centralized gate for all `upgradeOnRoute` upgrades. It's called from:
- Line ~263: Initial route planning
- Line ~755: Post-delivery route re-plan

Add `deliveryCount` parameter and check it first:

```typescript
private static tryConsumeUpgrade(
  route: StrategicRoute,
  snapshot: WorldSnapshot,
  tag: string,
  deliveryCount: number,      // ← new param
): TurnPlanUpgradeTrain | null {
  const targetTrain = route.upgradeOnRoute!;
  route.upgradeOnRoute = undefined;

  // Delivery gate: don't upgrade before establishing cash flow
  if (deliveryCount < MIN_DELIVERIES_BEFORE_UPGRADE) {
    console.warn(`${tag} JIRA-119: upgradeOnRoute blocked — only ${deliveryCount} deliveries (need ${MIN_DELIVERIES_BEFORE_UPGRADE})`);
    return null;
  }

  // ... existing validation (path, affordability) unchanged
}
```

Update both call sites to pass `memory.deliveryCount ?? 0` (initial route) or the updated count (post-delivery).

### 3. Gate `pendingUpgradeAction` injection point

Line ~537 is where `pendingUpgradeAction` (from either `tryConsumeUpgrade` or JIRA-105b upgrade-before-drop) gets injected into the decision plan. Add a delivery count check here as defense-in-depth:

```typescript
if (pendingUpgradeAction) {
  const effectiveDeliveryCount = (memory.deliveryCount ?? 0) + (hasDelivery ? 1 : 0);
  if (effectiveDeliveryCount < MIN_DELIVERIES_BEFORE_UPGRADE) {
    console.warn(`${tag} JIRA-119: Suppressed pending upgrade — only ${effectiveDeliveryCount} deliveries`);
    pendingUpgradeAction = null;
  }
}
if (pendingUpgradeAction) {
  // ... existing injection logic
}
```

This catches the JIRA-105b path (upgrade-before-drop) without needing to modify that code.

### 4. Gate `postDeliveryUpgrade` (line ~767)

This is the third upgrade path — `tryConsumeUpgrade` called on a new route after delivery. Already handled by change #2 since it goes through `tryConsumeUpgrade`, but we need to pass the correct delivery count (incremented by the just-completed delivery).

### 5. Remove GuardrailEnforcer G3b

Remove the `Guardrail 3b` block I added to `GuardrailEnforcer.ts` and the associated test. It's redundant now that the actual execution paths are gated. The guardrail file should only enforce game rules (no upgrade during initialBuild, movement budget, force delivery), not tuning knobs.

### 6. Update references to use the constant

- `ContextBuilder.ts` line ~960: `(context.deliveryCount ?? 0) >= MIN_DELIVERIES_BEFORE_UPGRADE`
- `systemPrompts.ts`: Reference the threshold conceptually (the LLM doesn't need the exact number since we gate it mechanically, but the prompt should be consistent)

## Files to modify

| File | Change |
|------|--------|
| `AIStrategyEngine.ts` | Add constant, gate `tryConsumeUpgrade`, gate injection point, pass delivery count |
| `GuardrailEnforcer.ts` | Remove G3b |
| `GuardrailEnforcer.test.ts` | Remove G3b test, revert "allow UPGRADE" test |
| `ContextBuilder.ts` | Import and use constant for prompt gating |
| `systemPrompts.ts` | Keep updated prompt wording (already done) |

## Why this is better

- **One constant** (`MIN_DELIVERIES_BEFORE_UPGRADE`) controls the threshold everywhere
- **Two enforcement points**, both in `AIStrategyEngine.takeTurn()` — the orchestrator that owns the turn lifecycle
- `tryConsumeUpgrade` gates route-based upgrades (the common path)
- `pendingUpgradeAction` injection gates everything else (defense-in-depth)
- No scattered logic in GuardrailEnforcer, ContextBuilder prompt gating, or LLM prompts trying to convince the model not to upgrade
- Easy to change: update one number to retune
