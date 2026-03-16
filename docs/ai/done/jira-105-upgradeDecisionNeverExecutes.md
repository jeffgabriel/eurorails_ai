# JIRA-105: Train Upgrade Decision Never Executes

## Problem

The bot never upgrades from its starting Freight train, even when it has abundant cash and the upgrade would clearly improve performance.

### Evidence: Game 44bdcc48

- Both bots stayed on basic Freight for **75+ turns** — never upgraded once
- LLM was called 27 times for route planning. **Zero** responses mentioned UPGRADE
- `upgradeConsidered=true` on 124 out of 149 turns, but never acted on
- URGENT upgrade advice injected starting at turn 15 — completely ignored
- Bot sat on 40-60M cash for dozens of turns while crawling at 9 speed with 2 cargo slots

### Previous Evidence: Game 883aae52, player "flash" (410740d4)

- Flash played **89 turns** on a basic Freight and **never upgraded**
- By T8, had $32M. By T79, had $144M
- At T67, LLM planned a 6-stop route with **3 pickups** for a 2-load train — physically impossible
- At T79, bot dropped Tourists to make room for Oil, wasting turns on round-trip re-pickup

## Root Cause

The LLM has **no mechanism to express an upgrade decision**. The route planning response format only allows:

```json
{ "route": [...], "startingCity": "...", "reasoning": "...", "planHorizon": "..." }
```

There is no `upgrade` field. Even though the system prompt describes UPGRADE as an action, the LLM is in "route planning mode" where it can only output PICKUP/DELIVER sequences. The upgrade advice text goes into the prompt but the LLM cannot act on it structurally.

Additionally, the strategic guidance is too conservative and doesn't convey competitive reality:
- Current threshold says "DO upgrade when you have 60M+ cash" — way too late
- Doesn't tell the LLM that **no one wins this game on a basic Freight**
- Doesn't explain capital deployment: sitting on 40M cash mid-game is a strategic error
- Doesn't convey that winners upgrade early and upgrade twice

## Design Decision

**Keep upgrades as an LLM strategic decision, not a heuristic enforcement.** The LLM should decide when to upgrade based on game state, competitive position, and strategic reasoning. The fix gives the LLM the mechanism and information to make this decision well.

## Solution

### 1. Add `upgradeOnRoute` field to route planning response format
**File**: `src/server/services/ai/prompts/systemPrompts.ts` (~line 211)

Add an optional `"upgradeOnRoute"` field to the route planning JSON schema:
```json
{
  "route": [...],
  "startingCity": "...",
  "upgradeOnRoute": "FastFreight",
  "reasoning": "...",
  "planHorizon": "..."
}
```

This gives the LLM a concrete way to say "upgrade my train as part of executing this route."

### 2. Rewrite upgrade strategy section with competitive urgency
**File**: `src/server/services/ai/prompts/systemPrompts.ts` (~lines 190-209)

Replace the TRAIN UPGRADE STRATEGY section. Key points to convey:

**Competitive reality:**
- No one wins this game on a basic Freight train. Winners upgrade twice to Superfreight.
- Winners are often the **first** to upgrade. They calculate risk vs reward and invest rather than hoard.
- Games are won by ~turn 100. Players who reach Superfreight by turn 50 dominate.
- First upgrade is either Fast Freight (12 space movement) or a 3 load capacity train (better for short hauls - typically if you have a lot of track in the islands where ferry travel shortens distances)
- Fast Freight (12 space movement) is usually the best first upgrade

**Capital deployment (not cost avoidance):**
- Sitting on 40M cash mid-game is a strategic error. That money should be working for you.
- The upgrade trigger is a **guaranteed income opportunity**: when you have a double-delivery route across a long distance, you know ~40M is coming. Upgrade NOW to carry those loads cross-country faster.
- Human players upgrade as soon as they have a guaranteed delivery queued — they don't wait for a cash pile.

**Concrete guidance:**
- After your first delivery, if you have 30M+ cash, upgrade. The 20M pays for itself within 2-3 deliveries.
- Remove the old "60M+ cash" threshold — far too conservative.
- Fast Freight is almost always the right first upgrade (speed > capacity early game).
- Plan your second upgrade (to Superfreight) around turn 25-35.

### 3. Parse `upgradeOnRoute` from LLM response
**File**: `src/server/services/ai/ResponseParser.ts` (~line 388)

After parsing `reasoning` and `startingCity`, extract the optional `upgradeOnRoute` field from the parsed JSON and store it on the `StrategicRoute`.

### 4. Add `upgradeOnRoute` to StrategicRoute interface
**File**: `src/shared/types/GameTypes.ts` (~line 450)

Add: `upgradeOnRoute?: string;`

### 5. Consume `upgradeOnRoute` when route execution begins
**File**: `src/server/services/ai/AIStrategyEngine.ts` (~line 206)

When a new route is created with `upgradeOnRoute` set, inject an UpgradeTrain action into the first turn's plan as Phase B. The field is consumed once on route start.

### 6. Lower upgrade advice eligibility gates
**File**: `src/server/services/ai/ContextBuilder.ts` (~line 956)

- Current gate: `deliveryCount >= 3 && money >= 50` — too conservative
- New gate: `deliveryCount >= 1 && money >= 30`
- Strengthen RECOMMENDED language when on Freight past turn 10

## Files to Modify

- `src/server/services/ai/prompts/systemPrompts.ts` — upgrade strategy rewrite + response format
- `src/shared/types/GameTypes.ts` — StrategicRoute interface
- `src/server/services/ai/ResponseParser.ts` — parse upgradeOnRoute
- `src/server/services/ai/AIStrategyEngine.ts` — consume upgradeOnRoute on route start
- `src/server/services/ai/ContextBuilder.ts` — upgrade advice eligibility + urgency

## Verification

- Run `npm test` — no regressions
- Check ResponseParser tests for route parsing with new field
- Start a new game and verify LLM responses include `upgradeOnRoute`
- Verify bot actually upgrades when the LLM decides to
