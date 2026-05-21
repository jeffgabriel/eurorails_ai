# JIRA-29: Bot Never Upgrades Train

## Problem

The bot plays entire games as a Freight train (9 speed, 2 cargo) and never upgrades. Human players typically upgrade to Fast Freight or Heavy Freight by mid-game and reach Superfreight by late-game. The upgrade system is fully implemented (ActionResolver, TurnExecutor, system prompt strategy) but never triggers.

## Root Cause

**Upgrades can only happen if the LLM picks UPGRADE as its primary action.** The LLM must choose UPGRADE *instead of* MOVE, DELIVER, PICKUP, BUILD — not *in addition to* operations. Since MOVE → DELIVER has immediate payoff and UPGRADE has deferred payoff, a rational LLM will never choose it as the primary action when any delivery is possible.

### The structural gap

TurnComposer composes turns in two phases:
- **Phase A**: Operational (MOVE + PICKUP/DELIVER) — always runs
- **Phase B**: Build/Upgrade — spends up to 20M after operations

But Phase B only calls `tryAppendBuild()`. It **never evaluates UPGRADE as an alternative to BUILD**. So the only path to an upgrade is:

```
LLM primary decision = UPGRADE  →  TurnComposer sees hasUpgrade=true  →  skips Phase B
```

This never happens because the LLM always picks an operational action first.

### What should happen

After Phase A completes (bot has moved, picked up, delivered), Phase B should evaluate:
1. Can we build useful track for ≤20M? → BUILD
2. Would upgrading the train be better value? → UPGRADE
3. Neither worthwhile? → skip

This is how human players think: "I just delivered, I have 80M cash, I'm still on a Freight — time to upgrade instead of building 20M of track."

## Current Code Path

```
LLMStrategyBrain.decideAction()        // LLM picks primary action (MOVE, DELIVER, etc.)
  → ActionResolver.resolve()           // Resolves to TurnPlan
    → TurnComposer.compose()           // Enriches the plan
      → Phase A: operational enrichment (continuation MOVEs after pickup/deliver)
      → Phase B: tryAppendBuild()      // ← ONLY considers BUILD, never UPGRADE
```

### Context hint is too weak

The LLM context includes:
```
YOU CAN UPGRADE: Check available train types (20M for upgrade, 5M for crossgrade).
```

This is a single vague line with no specifics about which upgrade is available, what the stat changes are, or what the ROI would be. Compare this to the detailed demand ranking with per-card scores.

## Proposed Fix

### 1. Add `tryAppendUpgrade()` to TurnComposer Phase B

**File**: `src/server/services/ai/TurnComposer.ts`

After `tryAppendBuild()` resolves (or fails), evaluate whether an upgrade would be better:

```typescript
// Phase B: Build OR Upgrade
if (!skipBuildPhase) {
  const buildPlan = await TurnComposer.tryAppendBuild(simSnapshot, simContext, activeRoute);
  const upgradePlan = TurnComposer.tryAppendUpgrade(simSnapshot, simContext);

  // Pick the higher-value option
  if (upgradePlan && TurnComposer.upgradeBeatsTrack(upgradePlan, buildPlan, simContext)) {
    steps.push(upgradePlan);
  } else if (buildPlan) {
    steps.push(buildPlan);
  }
}
```

### 2. Upgrade evaluation heuristic (`tryAppendUpgrade`)

Only consider upgrading when:
- Bot can afford it (20M for upgrade, 5M for crossgrade)
- Bot is not already Superfreight
- Bot has made at least 1 delivery (don't upgrade before cash flow)
- Cash after upgrade ≥ 10M (don't go broke)

### 3. Upgrade-vs-build comparison (`upgradeBeatsTrack`)

Prefer upgrade over build when:
- **No high-value build target**: `tryAppendBuild` returned null or builds < 5M of track (nothing urgent to build)
- **Cash threshold met**: Bot has ≥ 60M (can afford upgrade and still build next turn)
- **Speed upgrade ROI**: Current routes average > 15 mileposts → Fast Freight saves 1 turn per delivery → pays for itself in ~3 deliveries
- **Capacity upgrade ROI**: Bot frequently has 3+ viable pickup opportunities → Heavy Freight earns an extra load per route
- **Late upgrade**: Bot is still on Freight after turn 15 → force upgrade consideration regardless

### 4. Enrich the context hint

Replace the vague `"YOU CAN UPGRADE"` with specific info:

```
UPGRADE AVAILABLE: Freight → Fast Freight (12 speed, 2 cargo) for 20M
  - Speed gain: +3 mileposts/turn (saves ~1 turn per route over 15mp)
  - You have 85M cash — upgrade leaves 65M for building next turn
```

Or for crossgrade:
```
CROSSGRADE AVAILABLE: Fast Freight → Heavy Freight (9 speed, 3 cargo) for 5M
  - Trade: -3 speed for +1 cargo capacity
  - Consider if you have 3+ viable pickups per route
```

## Files to Change

| File | Change |
|------|--------|
| `src/server/services/ai/TurnComposer.ts` | Add `tryAppendUpgrade()`, `upgradeBeatsTrack()`, wire into Phase B |
| `src/server/services/ai/ContextBuilder.ts` | Enrich `canUpgrade` context with specific upgrade path, stats, and ROI hint |
| `src/server/__tests__/ai/TurnComposer.test.ts` | New tests for upgrade-vs-build evaluation |

## Acceptance Criteria

- AC-1: TurnComposer Phase B evaluates upgrade as alternative to build
- AC-2: Upgrade is preferred when no high-value build target exists and cash threshold is met
- AC-3: Upgrade is never chosen before first delivery or when it would leave bot with < 10M
- AC-4: Context shows specific upgrade path with stat changes and cost
- AC-5: Bot upgrades at least once in a typical 30+ turn game (observable in game logs)
- AC-6: All existing TurnComposer and ContextBuilder tests pass
- AC-7: New tests cover: upgrade preferred over weak build, build preferred over upgrade when high-value target exists, upgrade skipped when cash too low, crossgrade evaluation
