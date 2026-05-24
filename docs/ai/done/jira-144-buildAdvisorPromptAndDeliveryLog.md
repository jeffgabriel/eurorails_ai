# JIRA-144: Build Advisor Prompt & Delivery Log Fixes

## Investigation Summary

Two bugs identified from game `game-e02b742e-7878-43ad-a1b6-f977eb5e1251` (Haiku bot, 25 turns):

### Bug 1: Build Advisor Victory Condition Bias

**Symptom**: The Build Advisor LLM consistently prioritizes connecting to unconnected major cities over more tactically useful builds (e.g., building toward delivery destinations). Every advisor reasoning output references "7 of 8 major cities" and "victory condition".

**Root Cause**: The Build Advisor system prompt at `src/server/services/ai/prompts/systemPrompts.ts:414` contains:

```
VICTORY: Connect 7 of 8 major cities AND have 250M+ ECU cash.
```

Additionally, the user prompt (lines 448-452) includes an `UNCONNECTED MAJOR CITIES` section listing each unconnected city with estimated connection cost. Together, these cause the LLM to treat city connection as the primary build objective regardless of game phase or cash position.

**Evidence from game log**:
- Turn 5 (cash 46M): "build toward Paris (the closest unconnected major city at ~25M cost)... 7-city victory condition"
- Turn 7 (cash 18M): "needing to connect 7 of 8 major cities for victory, Paris is the optimal next target"
- Turn 11 (cash 30M): "London is the closest unconnected major city at ~6M to connect"
- Turn 15 (cash 30M): "Ruhr is the closest unconnected major city at ~15M cost"

In all cases, the advisor focuses on city connections rather than builds that support the bot's active delivery route.

**Fix**: Remove the VICTORY line from the system prompt and the UNCONNECTED MAJOR CITIES section from the user prompt. The Build Advisor's job is tactical track-building to support deliveries, not strategic city-connection planning.

**Files affected**:
- `src/server/services/ai/prompts/systemPrompts.ts:414` — remove VICTORY line
- `src/server/services/ai/prompts/systemPrompts.ts:448-453` — remove UNCONNECTED MAJOR CITIES section

---

### Bug 2: Missing `loadsDelivered` in NDJSON Game Log

**Symptom**: The `loadsDelivered` field is always empty/undefined in the NDJSON game log, even when deliveries clearly occurred (cash increases between turns, loads disappear from `carriedLoads`).

**Evidence from game log**:
- Turn 9 composition trace shows `deliveries: [{"load": "Cars", "city": "Nantes"}]`
- But the top-level `loadsDelivered` field is empty
- Cash correctly changes from 10M → 41M (10 + 51 delivery - 20 build)
- No turn in the entire game has a populated `loadsDelivered` field

**Root Cause**: JIRA-91 early-executes delivery steps against the DB before the trip planner LLM call (to get fresh post-delivery state). These early-executed steps are then stripped from the `finalPlan` (line 874). The `loadsDelivered` extraction loop at lines 1131-1152 only iterates over `finalPlan` steps — it never sees the stripped delivery steps.

The `earlyExecutedSteps` loop at lines 1119-1129 handles movement path extraction from early steps but does NOT extract deliveries or pickups:

```typescript
// Lines 1119-1129: Only extracts MoveTrain paths
for (const earlyStep of earlyExecutedSteps) {
  if (earlyStep.type === AIActionType.MoveTrain && 'path' in earlyStep ...) {
    // extracts movement data only
  }
}
// Lines 1131-1152: Only iterates finalPlan steps (deliveries already stripped)
const loadsDelivered = [];
const loadsPickedUp = [];
const allSteps = finalPlan.type === 'MultiAction' ? finalPlan.steps : [finalPlan];
for (const step of allSteps) { ... }
```

**Fix**: Extend the `earlyExecutedSteps` loop (lines 1119-1129) to also extract `DeliverLoad` and `PickupLoad` data, using the same logic as the `finalPlan` loop below it (lines 1145-1157). Move the `loadsDelivered` and `loadsPickedUp` array declarations above the early-executed loop so both loops can contribute to them.

**Files affected**:
- `src/server/services/ai/AIStrategyEngine.ts:1119-1157` — extend earlyExecutedSteps loop to capture deliveries and pickups

---

## Data Flow Diagram

```
Turn Start
  │
  ├─ ContextBuilder.build(snapshot) → context.money = snapshot.bot.money
  │
  ├─ TurnComposer.compose()
  │   ├─ Phase A: Operational enrichment
  │   │   ├─ A0: Deliver-before-build (prepend MOVE+DELIVER)
  │   │   ├─ A1: splitMoveForOpportunities (mid-route pickups/delivers)
  │   │   └─ A2: Chain continuation MOVEs
  │   │
  │   └─ Phase B: Build Advisor ← sees simContext.money (post Phase A)
  │       └─ getBuildAdvisorPrompt(context) → CASH: ${context.money}M
  │
  ├─ JIRA-91: Early-execute delivery steps → DB updated
  │   ├─ capture() → freshSnap with new demand card, updated money
  │   └─ earlyExecutedSteps stripped from finalPlan  ← BUG: deliveries lost here
  │
  └─ Log extraction
      ├─ earlyExecutedSteps loop → MoveTrain paths only (BUG: no deliveries)
      └─ finalPlan loop → no deliveries (already stripped)
```

## Verification Plan

After fixes, re-run the game and verify:
1. Build Advisor reasoning no longer mentions "7 major cities" or "victory condition"
2. `loadsDelivered` field is populated in NDJSON log when deliveries occur
3. The `llm-transcript.ts` script correctly displays delivery information
