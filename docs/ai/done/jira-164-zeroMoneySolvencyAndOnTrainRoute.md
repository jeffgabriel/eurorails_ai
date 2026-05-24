# JIRA-164: Remove cash floors, broke-bot-gate, hand quality — let the pipeline work

## Summary

The bot pipeline already knows how to move on own track (free), deliver loads, pick up loads, skip builds when broke, and call the LLM for new routes. But arbitrary cash gates short-circuit the pipeline before any of that can happen, causing 157-turn death spirals. The fix is removal, not addition.

### Design principle

Per CLAUDE.md Bot Strategic Principles: the game rules define what a bot can and can't do at any cash level. We don't need to invent additional constraints. A bot at $0 can move on its own track, deliver carried loads, and pick up loads. A bot at $3 can also build clear terrain. The pipeline should handle all of this through its normal flow.

---

## What to remove

### 1. The broke-bot-gate (AIStrategyEngine.ts:370-390)

**Delete entirely.** This gate checks `money < 5` and force-discards the hand, bypassing the LLM. Without it, the normal flow takes over:

- If the bot has an active route → TurnExecutorPlanner executes it (move, deliver, pick up — all free on own track)
- If the bot has no route → LLM is called to plan one. The LLM can see the bot's cash and decide whether to plan a delivery route, discard, or pass. That's the LLM's job — not a hardcoded gate's.

The gate was introduced to "save LLM calls" but it costs 157 dead turns when it misfires. One LLM call is cheaper than one wasted turn.

**Lines to delete:** 370-390 (the entire `if (isBroke && ...)` block). The `else` on line 391 becomes the unconditional path.

### 2. The `money < 5` pickup skip (ActionResolver.ts:1092-1093)

**Delete the guard.** Pickups are free. Cash level is irrelevant.

```
// Delete:
const isBrokeWithNoAffordableDemands = snapshot.bot.money < 5 && context.demands.every(d => !d.isAffordable);
if (context.canPickup && context.canPickup.length > 0 && !isBrokeWithNoAffordableDemands) {

// Replace with:
if (context.canPickup && context.canPickup.length > 0) {
```

### 3. The `money < 5` heuristic fallback discard (ActionResolver.ts:1103-1111)

**Delete the cash check.** If the heuristic fallback needs to decide whether to discard, it should check whether the bot has any productive action — not whether cash is below a magic number. With the broke-bot-gate removed, this path is less likely to fire anyway.

### 4. `computeHandQuality()` and all references

**Delete entirely.** It's not a game concept, it contains the `money < 5` cash floor (JIRA-71), it doesn't drive any decisions, and its thresholds (3.0, 1.0) are arbitrary.

| File | What to delete |
|---|---|
| `AIStrategyEngine.ts:1278-1314` | `computeHandQuality()` method |
| `AIStrategyEngine.ts:92` | `handQuality` field on memory type |
| `AIStrategyEngine.ts:983-988` | Call site and log line |
| `AIStrategyEngine.ts:1093` | `handQuality` in result object |
| `BotTurnTrigger.ts:146,181,231` | `handQuality` pass-through |
| `GameLogger.ts:78` | `handQuality` field in log entry type |
| `DebugOverlay.ts` | `handQuality` rendering |

### 5. GuardrailEnforcer: restore carried-loads guard

`GuardrailEnforcer.ts:66`: JIRA-120 removed the `loads.length === 0` check from stuck detection, so it force-discards even when the bot is carrying deliverable loads. Restore a targeted guard:

```typescript
const hasDeliverableLoad = snapshot.bot.loads.length > 0 &&
  context.demands.some(d => d.isLoadOnTrain && d.isDeliveryOnNetwork);

if (noProgressTurns >= 3 && planType !== AIActionType.DiscardHand
    && !hasActiveRoute && !hasDeliverableLoad) {
```

This is the one place we ADD a condition — because the guardrail is actively destroying value by discarding hands that contain demand cards matching carried loads.

---

## What to fix: "OnTrain" prompt leakage

### Root cause

`ContextBuilder.ts:757` stores `supplyCity: supplyCity ?? 'OnTrain'` — a sentinel string in the data model. `ContextBuilder.ts:1322` shows it to the LLM in the prompt. The LLM echoes it back as a city name.

### Fix: one root cause, one safety net

**Root cause fix — stop storing "OnTrain" as a city:**

```typescript
// ContextBuilder.ts:757 — change:
supplyCity: supplyCity ?? 'OnTrain',
// to:
supplyCity: supplyCity ?? null,
```

Then in the prompt serializer (line 1322):
```typescript
const supplyNote = d.isLoadOnTrain ? '(already carried)' : d.supplyCity;
```

**Safety net — reject it in the response parser:**

```typescript
// In TripPlanner, when parsing LLM route response:
const validStops = parsedStops.filter(stop => {
  if (stop.action === 'pickup' && (stop.city === 'OnTrain' || stop.city === '(already carried)')) {
    return false;
  }
  return true;
});
```

Two fixes, not four. The root cause (don't put sentinel strings in data models) and one safety net (filter on parse). No need for resolveBuildTarget guards or RouteValidator checks — if the sentinel never enters the data, downstream doesn't need to handle it.

---

## Net effect

| Before | After |
|---|---|
| 4 locations with `money < 5` threshold | 0 |
| Broke-bot-gate (10 lines of hardcoded logic) | Deleted — normal pipeline handles all cash levels |
| `computeHandQuality()` (40 lines + 7 references) | Deleted |
| "OnTrain" stored as city name in data model | `null` — prompt shows "(already carried)" |
| 4-layer OnTrain defense | 2 fixes: root cause + parser safety net |
| GuardrailEnforcer discards with carried loads | Guarded: won't discard if carrying deliverable loads |

The pipeline gets simpler. The bot has fewer reasons to PassTurn. The LLM makes the decisions that were being made by hardcoded gates.

---

## Test plan

1. Bot with $0, active route, carried load → pipeline executes normally, moves on own track, delivers
2. Bot with $0, no route, no carried loads → LLM is called (not force-discarded). LLM decides what to do
3. Bot with $3 → can pick up loads, can build clear terrain. No gates block it
4. Bot with $0, no route, LLM plans a delivery route for carried load → works
5. `computeHandQuality` removed — no runtime references remain
6. GuardrailEnforcer: bot carrying deliverable load with 3+ no-progress turns → NOT force-discarded
7. GuardrailEnforcer: bot with no loads, 3+ no-progress turns → still force-discards (correct)
8. ContextBuilder: `supplyCity` is `null` for carried loads, not "OnTrain"
9. Prompt shows "(already carried)" not "OnTrain"
10. TripPlanner response with "OnTrain" city → filtered out in parser
11. Integration: replay game 4e7f3385 Haiku T11→T12 — bot continues playing, no 157-turn spiral
12. Integration: replay game 4e7f3385 Haiku T214 — no OnTrain oscillation
