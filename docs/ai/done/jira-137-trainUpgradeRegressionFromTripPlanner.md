# JIRA-137: Train Upgrade Regression from TripPlanner Migration

## Problem
Bots never upgrade their train. In game `60b0c45a`, Haiku played 900 turns on a basic Freight with 2,800M cash. Flash didn't upgrade until turn 397.

## Root Cause
JIRA-126 replaced `LLMStrategyBrain.planRoute()` with `TripPlanner.planTrip()` as the primary route planning call. The old `planRoute()` used the main system prompt which included:
- Upgrade instructions ("No one wins this game on a basic Freight train")
- `upgradeOnRoute` field in the `ROUTE_RESPONSE_SCHEMA` (line 88 in `schemas.ts`)
- The response parser extracted `upgradeOnRoute` and AIStrategyEngine consumed it

The TripPlanner has a completely separate prompt and schema (`TRIP_PLAN_SCHEMA`) that:
- Has no `upgradeOnRoute` field in its output schema
- Only accepts route candidates with stops (PICKUP/DELIVER)

**Partial context exists but is dead-ended:** `buildTripPlanningContext()` (systemPrompts.ts:522-529) does inject `UPGRADE AVAILABLE` and upgrade advice into the prompt. The LLM sees it but has no schema field to act on it.

## Evidence
- `TripPlanner.ts`: zero references to "upgrade" anywhere in the file
- `TRIP_PLAN_SCHEMA` (schemas.ts:197): no `upgradeOnRoute` field
- `ROUTE_RESPONSE_SCHEMA` (schemas.ts:88): has `upgradeOnRoute` but is no longer the primary path
- `buildTripPlanningContext()` (systemPrompts.ts:522-529): injects upgrade advice into prompt — but schema blocks expression
- `TRIP_PLANNING_SYSTEM_SUFFIX` (systemPrompts.ts:316-449): no mention of upgrades in instructions or response format example
- Game `60b0c45a`: 1,796 turns, Haiku never upgraded, Flash upgraded at turn 397 only

## The Severed Chain
```
Before JIRA-126:
  LLMStrategyBrain.planRoute()
    → main system prompt (has upgrade instructions + response format with upgradeOnRoute)
    → ROUTE_RESPONSE_SCHEMA (has upgradeOnRoute field)
    → ResponseParser extracts upgradeOnRoute
    → AIStrategyEngine.tryConsumeUpgrade() executes it
    ✅ Upgrades happened

After JIRA-126:
  TripPlanner.planTrip()
    → trip planning prompt (has upgrade context in dynamic section but NOT in instructions or response format)
    → TRIP_PLAN_SCHEMA (NO upgradeOnRoute field)
    → Returns candidates with stops only
    → TripPlanResult has no upgrade field
    → AIStrategyEngine checks activeRoute.upgradeOnRoute — always undefined
    ❌ Upgrades never happen
```

## Fix: Add upgradeOnRoute to TripPlanner pipeline

### 1. Schema — `schemas.ts`
Add optional `upgradeOnRoute` as a top-level field in `TRIP_PLAN_SCHEMA` (alongside `candidates`, `chosenIndex`, `reasoning`):
```typescript
upgradeOnRoute: {
  type: 'string',
  enum: ['FastFreight', 'HeavyFreight', 'Superfreight'],
}
```
Keep it optional (not in `required` array) — most turns won't include an upgrade.

### 2. Prompt instructions — `systemPrompts.ts`

**In `TRIP_PLANNING_SYSTEM_SUFFIX` (line 316)**, add upgrade instructions after the TRIP PLANNING RULES section:

```
TRAIN UPGRADES:
No one wins this game on a basic Freight train. Upgrades cost 20M and replace track building for that turn.
- Freight → Fast Freight (20M): +3 speed saves ~1 turn per delivery. Best first upgrade.
- Freight → Heavy Freight (20M): +1 cargo slot. Only if you have corridor deliveries needing 3 loads.
- Fast Freight/Heavy Freight → Superfreight (20M): 12 speed + 3 cargo. The endgame train.

When to upgrade:
- You have 1+ completed deliveries AND 50M+ cash AND you're still on Freight → upgrade NOW
- You have 100M+ cash and are not yet on Superfreight → strongly consider upgrading
- No critical track build is needed this turn (or you can afford both next turn)

To upgrade, include "upgradeOnRoute" in your top-level response (not inside a candidate).
```

**In the response format example** (line 405-418), add `upgradeOnRoute`:
```json
{
  "candidates": [...],
  "chosenIndex": 0,
  "reasoning": "...",
  "upgradeOnRoute": "FastFreight"
}
```

**In the example** (line 420-449), add a variant showing an upgrade decision.

**In `buildTripPlanningContext()`** (line 522-529), the existing upgrade injection is fine — it already shows `UPGRADE AVAILABLE` and the upgrade advice. No change needed here.

### 3. TripPlanner response parsing — `TripPlanner.ts`

In the `LLMTripPlanResponse` interface (line 48), add:
```typescript
upgradeOnRoute?: string;
```

In `planTrip()` after building the `StrategicRoute` (line 172-178), propagate:
```typescript
const route: StrategicRoute = {
  stops: chosen.stops,
  currentStopIndex: 0,
  phase: 'build',
  createdAtTurn: context.turnNumber,
  reasoning: chosen.reasoning,
  upgradeOnRoute: parsed.upgradeOnRoute,  // ← NEW
};
```

### 4. No changes needed downstream
- `StrategicRoute.upgradeOnRoute` field already exists (GameTypes.ts:461)
- `AIStrategyEngine.tryConsumeUpgrade()` already reads `activeRoute.upgradeOnRoute` (line 307)
- The execution path is fully intact — it just needs the field populated

## Files to Change

| File | Change | Effort |
|------|--------|--------|
| `src/server/services/ai/schemas.ts` | Add `upgradeOnRoute` to `TRIP_PLAN_SCHEMA` | Trivial |
| `src/server/services/ai/prompts/systemPrompts.ts` | Add upgrade instructions + response format to `TRIP_PLANNING_SYSTEM_SUFFIX` | Small |
| `src/server/services/ai/TripPlanner.ts` | Add field to `LLMTripPlanResponse`, propagate to `StrategicRoute` | Trivial |
| `src/server/__tests__/ai/TripPlanner.test.ts` | Add test for upgrade field parsing and propagation | Small |

## What NOT to Change
- `AIStrategyEngine.ts` — the `tryConsumeUpgrade()` call at line 307 already works; it just needs `upgradeOnRoute` to be non-undefined
- `ContextBuilder.ts` — the upgrade advice generation is fine
- `ResponseParser.ts` — only used by the old `planRoute()` path
- `buildTripPlanningContext()` — already injects upgrade context correctly

## Complexity
Trivial-small. The downstream consumption chain is fully intact. The fix is: add the field to the schema, tell the LLM about it in the prompt, and pass it through from the parsed response to the route object. Three touchpoints, all mechanical.
