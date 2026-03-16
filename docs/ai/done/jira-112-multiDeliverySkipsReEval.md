# JIRA-112: Multi-Delivery at Same City Skips Post-Delivery Re-Evaluation

## Symptom

Game `7aa39254`, Flash bot, turn 8. Bot arrives at Warszawa, delivers Wine (12M) and Oil (21M), then wastes 8 of 9 mileposts doing nothing. A2 continuation terminates with "no valid target". Stage 3d post-delivery LLM re-evaluation never fires. Bot sits at Warszawa with no route and no movement for the rest of the turn.

## Timeline

| Turn | Position | Action | Budget Used/Wasted | Notes |
|------|----------|--------|-------------------|-------|
| 8 | (27,62) → Warszawa | DeliverLoad (Wine+Oil) | 1/8 | Route completes, 8mp wasted |
| 9 | Warszawa → (34,59) | BuildTrack | 9/0 | LLM plans new route, full budget used |

## Root Cause

`AIStrategyEngine.ts` line 583:

```typescript
const hasQueuedDelivery = composedSteps.filter(s => s.type === AIActionType.DeliverLoad).length > 1;
```

This guard was intended to prevent the post-delivery LLM call from firing when there's still another delivery queued to execute later in the turn. But it uses a simple count of ALL delivery steps in the composed plan. When the bot delivers 2 loads at the **same city in the same composed turn**, the count is 2, `hasQueuedDelivery = true`, and Stage 3d is skipped entirely.

### Both re-evaluation paths are blocked:

1. **Stage 3d** (line 584-586): `if (hasDelivery && !hasQueuedDelivery && ...)` — skipped
2. **JIRA-64 fallback** (line 992): `if (!reEvalHandled && !hasQueuedDelivery && ...)` — also skipped

### Why it matters

After delivering both loads, the bot has:
- 8 mileposts of remaining movement
- No active route (`routeWasCompleted = true`)
- No carried loads
- Fresh demand cards (drawn after delivery)

Without Stage 3d, the LLM is never called to plan a new route. The A2 continuation chain runs but has "no valid target" — it can't find a useful destination without LLM guidance. The bot wastes 8 mileposts (nearly a full turn of Freight movement).

## Data Model

`composedSteps` after TurnComposer.compose:
```
[MoveTrain, DeliverLoad(Wine@Warszawa), DeliverLoad(Oil@Warszawa)]
```

All 3 steps execute in sequence. After both deliveries, `earlyExecutedSteps` would contain all steps through the last delivery. The `capture()` call would return fresh state. There is no "queued" delivery waiting — both are already consumed.

## Fix

The `hasQueuedDelivery` check should distinguish between:
- **Deliveries at different cities** (genuine queue — later delivery hasn't happened yet) → skip re-eval
- **All deliveries at the same city in one composed turn** (all execute together) → allow re-eval

### Option A: Check if deliveries remain AFTER the early-execution point

Replace the count-based check with a check for deliveries that would occur after the last delivery in the early-execution batch. Since `earlyExecutedSteps` includes everything through the last `DeliverLoad`, there are never deliveries remaining after it. This makes `hasQueuedDelivery` effectively always `false` — which raises the question of whether the guard is needed at all.

### Option B: Remove `hasQueuedDelivery` guard entirely

The `earlyExecutedSteps` mechanism (JIRA-91) already handles the stale-state problem: it executes ALL steps through the last delivery against the DB before calling `capture()`. By the time Stage 3d fires, all deliveries have been applied and the snapshot is fresh. The original reason for `hasQueuedDelivery` (stale state during mid-turn delivery) is no longer relevant.

**Recommendation: Option B.** The JIRA-91 early-execution mechanism makes `hasQueuedDelivery` obsolete. Remove the guard from both line 586 and line 992.

### Risk assessment

Low. The guard was a safety measure from before JIRA-91 added proper early-execution. With early-execution in place, all deliveries are applied to DB before the LLM call. The fresh `capture()` returns accurate post-delivery state regardless of how many deliveries occurred.

## Affected Code

- `src/server/services/ai/AIStrategyEngine.ts:583` — remove `hasQueuedDelivery` variable
- `src/server/services/ai/AIStrategyEngine.ts:586` — remove `!hasQueuedDelivery` condition from Stage 3d gate
- `src/server/services/ai/AIStrategyEngine.ts:992` — remove `!hasQueuedDelivery` condition from JIRA-64 fallback gate

## Affected Cities

Any city where the bot can deliver 2+ loads in the same turn. Common scenario: bot picks up 2 loads at different supply cities and delivers both to the same demand city.
