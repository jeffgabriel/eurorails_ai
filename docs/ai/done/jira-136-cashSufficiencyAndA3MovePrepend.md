# JIRA-136: Cash Sufficiency Gate Ignores Delivery Income & A3 Move Prepend Wrong Direction

_Two bugs compound to waste 3+ turns: the validator blocks an affordable build because it doesn't account for same-turn delivery income, then the A3 move prepend sends the bot away from its destination._

## Evidence

Game `7cd86441`, Flash turn 8-11:
- **T8:** Flash at Wien with 0M cash, delivers Flowers for 18M. TurnComposer plans 12M build toward Beograd (`composition.build.cost: 12`). Only 1 segment (1M) built — the validator sees `12M > 0M` and strips the build. The delivery payout (18M) is not accounted for.
- **T9:** Flash at Wien (38,55), A3 prepends a MOVE. Beograd is unreachable (off-network), fallback targets resolve to a city NORTHWEST. Bot moves 9mp to (33,48) — opposite direction from Beograd. Then builds 8 segments (12M) toward Beograd from the track frontier.
- **T10-11:** Bot spends 2 full turns (18 mileposts) backtracking south toward Beograd.

Total waste: ~18 mileposts of movement (2 full turns) + 1 turn of delayed build = 3 turns lost.

## Bug 1: `TurnValidator.checkCashSufficiency()` Ignores Delivery Income

**File:** `src/server/services/ai/TurnValidator.ts:238-274`

The cash sufficiency gate sums `BuildTrack` + `UpgradeTrain` + movement fee costs, then compares against `snapshot.bot.money` — the bot's cash at the START of the turn, before any deliveries execute.

```typescript
const totalCost = phaseBSpend + movementFees;
if (totalCost > snapshot.bot.money) {   // ← uses pre-delivery cash
  return { gate: 'CASH_SUFFICIENCY', passed: false, ... };
}
```

A plan like `[MoveTrain, DeliverLoad(18M), BuildTrack(12M)]` is rejected because `12M > 0M`, even though the delivery gives 18M before the build executes per game rules (Phase A before Phase B).

**Note:** `SolvencyCheck.calculateIncomeBefore()` already handles this correctly for the BuildAdvisor path — it sums payouts for carried loads deliverable to on-network cities. But `TurnValidator` has no equivalent logic and runs on ALL plans including the heuristic fallback path.

### Fix

In `checkCashSufficiency()`, calculate delivery income that will be realized BEFORE the build:

```typescript
private static checkCashSufficiency(
  steps: TurnPlan[],
  context: GameContext,
  snapshot: WorldSnapshot,
): HardGateResult {
  let phaseBSpend = 0;
  let deliveryIncome = 0;

  for (const step of steps) {
    if (step.type === AIActionType.BuildTrack) {
      const buildStep = step as TurnPlanBuildTrack;
      for (const seg of buildStep.segments) {
        phaseBSpend += seg.cost;
      }
    } else if (step.type === AIActionType.UpgradeTrain) {
      phaseBSpend += (step as TurnPlanUpgradeTrain).cost;
    } else if (step.type === AIActionType.DeliverLoad) {
      // Deliveries execute in Phase A (before build), so their income is available
      deliveryIncome += (step as TurnPlanDeliverLoad).payment;
    }
  }

  let movementFees = 0;
  for (const step of steps) {
    if (step.type === AIActionType.MoveTrain) {
      movementFees += (step as TurnPlanMoveTrain).totalFee;
    }
  }

  const totalCost = phaseBSpend + movementFees;
  const availableCash = snapshot.bot.money + deliveryIncome;
  if (totalCost > availableCash) {
    return {
      gate: 'CASH_SUFFICIENCY',
      passed: false,
      detail: `Plan costs ${totalCost}M (build/upgrade: ${phaseBSpend}M, fees: ${movementFees}M) but bot only has ${availableCash}M (${snapshot.bot.money}M cash + ${deliveryIncome}M delivery income)`,
    };
  }
  return { gate: 'CASH_SUFFICIENCY', passed: true };
}
```

Need to verify that `TurnPlanDeliverLoad` has a `payment` field. If not, look it up from the demand card via `snapshot.bot.resolvedDemands` or add the field to the type.

## Bug 2: A3 Move Prepend Sends Bot Away from Build Target

**File:** `src/server/services/ai/TurnComposer.ts:432-481`

When the primary plan is `BuildTrack`, the A3 logic prepends a MOVE using `findMoveTargets()`. The priority chain:

1. **P1 (route stops):** Target is Beograd — off-network, MOVE resolver fails
2. **P1.5 (frontier approach):** Closest on-network city to Beograd — but bot is already AT Wien (the closest). No useful movement.
3. **P2/P3 (demand cities):** Falls to demand-based targets — picks a city NORTHWEST of Wien (Hamburg/Holland)
4. **Result:** Bot moves 9mp AWAY from Beograd, then wastes 2 turns backtracking

The core problem: when the bot is already at the track frontier where the build extends from, prepending a MOVE to some unrelated city is wasteful. The A3 logic doesn't check whether the move target is in the direction of the active route.

### Fix

Add a directional guard to A3: when the primary plan is `BuildTrack`, skip the move prepend if the bot is already at or adjacent to the build frontier. Alternatively, filter move targets to only those cities that are closer to (or at least not farther from) the build target than the bot's current position.

```typescript
// In A3 block, before findMoveTargets:
if (!hasMove && primaryType === AIActionType.BuildTrack) {
  const buildStep = steps.find(s => s.type === AIActionType.BuildTrack) as TurnPlanBuildTrack;
  const buildTargetCity = buildStep?.targetCity;

  // Skip A3 move if bot is already at the build frontier
  // (i.e., bot position is on-network and the build extends from the network toward the target)
  const botAtFrontier = TurnComposer.isBotAtBuildFrontier(
    snapshot, context, buildTargetCity,
  );
  if (botAtFrontier) {
    trace.a3 = { skipped: true, reason: 'bot at build frontier' };
  } else {
    // ... existing findMoveTargets logic, but filter candidates:
    // Only accept move targets where Manhattan distance to buildTarget
    // is LESS THAN the bot's current distance to buildTarget
  }
}
```

The `isBotAtBuildFrontier` check: the bot is at the frontier if its current position is within N hexes of the closest point on its track network to the build target. Could use the existing `getNetworkFrontier()` from BuildAdvisor or compute from the bot's track endpoints.

## What This Does NOT Change

- `SolvencyCheck.calculateIncomeBefore()` — already correct, used only in the advisor path
- `findMoveTargets()` priority ordering — correct for non-build scenarios
- A3 move prepend for non-build primary plans — unchanged, only guarded for BuildTrack
- BuildAdvisor or TripPlanner — unrelated to these bugs

## Implementation

| Fix | File | Change | Effort |
|-----|------|--------|--------|
| 1. Add delivery income to cash sufficiency | `TurnValidator.ts:checkCashSufficiency` | Sum `DeliverLoad` payouts and add to available cash | Small |
| 2. Verify `TurnPlanDeliverLoad.payment` | `GameTypes.ts` or equivalent | Confirm the payment field exists on the type | Trivial |
| 3. Add frontier guard to A3 | `TurnComposer.ts:432-481` | Skip A3 move when bot is at build frontier | Small |
| 4. Add directional filter to A3 fallback | `TurnComposer.ts:findMoveTargets` | Filter targets by direction toward build target | Medium |
| 5. Unit test: cash sufficiency with delivery | `TurnValidator.test.ts` | Plan with DeliverLoad before BuildTrack should pass | Small |
| 6. Unit test: A3 skips at frontier | `TurnComposer.test.ts` | BuildTrack plan at frontier should not prepend wrong-direction MOVE | Small |

## Testing

1. **Unit test:** `checkCashSufficiency` passes when `DeliverLoad(18M)` precedes `BuildTrack(12M)` and starting cash is 0M
2. **Unit test:** `checkCashSufficiency` still fails when delivery income is insufficient (e.g., deliver 5M, build 12M, cash 0M)
3. **Unit test:** A3 does NOT prepend MOVE when bot is at the build frontier
4. **Unit test:** A3 DOES prepend MOVE when bot is far from the build frontier and a directionally-correct target exists
5. **Game test:** Run game with Flash, verify bots don't waste turns moving away from build targets
