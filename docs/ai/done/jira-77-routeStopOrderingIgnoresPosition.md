# JIRA-77: Route Stop Ordering Ignores Bot's Current Position

## Observed in Game
`000cb369-2a94-4ffd-adf4-42745a9a0fe9` — Flash bot (`41b24096`, gemini-3-flash)

## Problem

When the LLM plans a multi-stop route, it orders stops by demand score (highest first), not by geographic proximity to the bot's current position. This causes the bot to travel away from nearby pickup opportunities, only to return later — wasting multiple turns on unnecessary round trips.

### Evidence from game log

**Turn 20**: Flash bot is near **Barcelona** after delivering Cheese. The LLM replans with a 4-stop route:

```
Route: pickup(Steel@Ruhr) → deliver(Steel@Praha) → pickup(Oranges@Valencia) → deliver(Oranges@Ruhr)
```

Demand ranking:
| Rank | Demand | Score | Location relative to bot |
|------|--------|-------|------------------------|
| #1 | Steel Ruhr→Praha | 9.1 | Ruhr is ~20 hexes NORTH |
| #2 | Oranges Valencia→Ruhr | 5.6 | Valencia is ~3 hexes SOUTH |

The LLM put Steel first because it scores higher (9.1 vs 5.6). But the bot is physically next to Valencia — Oranges is right there for pickup. Instead:

1. **Turn 20**: Bot moves 9mp NORTH toward Ruhr (away from Valencia). Build phase extends track 12M toward Valencia.
2. **Turns 21-22**: Bot continues north to Ruhr, picks up Steel.
3. **Turns 23-24**: Bot travels to Praha, delivers Steel.
4. Bot would then need to travel ALL the way back south to Valencia (~20+ hexes) for Oranges.

### What a human would do

A human near Barcelona with demands for both Steel@Ruhr and Oranges@Valencia would:
1. Build track to Valencia (3 hexes south, ~5M)
2. Pick up Oranges at Valencia immediately
3. Head north to Ruhr — deliver Oranges AND pick up Steel in one trip
4. Continue to Praha to deliver Steel

**One trip north instead of north-south-north.** Savings: ~6-8 turns of wasted travel.

### The A1 Scanner Can't Save This

The A1 opportunistic scanner (TurnComposer Phase A1) scans cities along the bot's movement path for pickup opportunities. On turn 20:
- A1 scanned 8 cities, found 0 opportunities
- The bot moved north (toward Ruhr), so Valencia was not on the path
- Track to Valencia was built AFTER movement, so Valencia wasn't reachable during movement anyway

A1 is designed for en-route opportunities — it can't fix a fundamentally backwards route ordering.

## Root Cause Analysis

### 1. LLM orders stops by demand priority, not geography

The LLM receives demand rankings sorted by score. Steel scores 9.1 (easy pickup at Ruhr, already on network) vs Oranges at 5.6. The LLM naturally puts the higher-scoring demand first in the route, without considering that Oranges is right next to the bot.

The system prompt doesn't instruct the LLM to consider current position when ordering multi-stop routes. The demand context shows scores and costs but doesn't highlight "you are currently 3 hexes from Valencia."

### 2. PlanExecutor executes stops sequentially

`PlanExecutor.execute()` processes `route.stops[currentStopIndex]` and advances the index only after completing each stop. It has no mechanism to reorder stops based on proximity. If stop 0 is "pickup Steel@Ruhr" and the bot is next to Valencia (stop 2), PlanExecutor will dutifully head to Ruhr first.

### 3. RouteValidator doesn't optimize stop order

`RouteValidator.validateRoute()` checks budget feasibility and rejects infeasible routes, but doesn't reorder stops for geographic efficiency. It validates the route as given by the LLM.

## Proposed Fix

### Approach: Post-LLM route stop reordering in RouteValidator or PlanExecutor

After the LLM produces a route, reorder the stops to minimize total travel distance from the bot's current position. The reordering must respect pickup-before-delivery constraints (can't deliver Oranges before picking them up).

#### Algorithm: Greedy nearest-neighbor with dependency constraints

```
Input: bot position, list of stops [{action, load, city}]
Output: reordered stops

1. Build dependency graph: for each DELIVER stop, its prerequisite PICKUP must come first
2. Initialize: current_pos = bot.position, remaining = all stops
3. While remaining is not empty:
   a. Find eligible stops (no unmet prerequisites)
   b. Among eligible, pick the one closest to current_pos (hop distance)
   c. Add to ordered list, update current_pos to that stop's city
   d. Remove from remaining
4. Return ordered list
```

For the Flash scenario:
- Eligible at start: pickup(Steel@Ruhr), pickup(Oranges@Valencia) — both pickups, no prereqs
- Bot near Barcelona: Valencia (3 hops) < Ruhr (20 hops) → pick **Oranges@Valencia** first
- After Valencia: eligible = pickup(Steel@Ruhr), deliver(Oranges@Ruhr) — both go to Ruhr
- Ruhr is closest (and only option): pick **pickup(Steel@Ruhr)** (pickup before delivery at same city)
- After Ruhr pickup: eligible = deliver(Oranges@Ruhr), deliver(Steel@Praha)
- Deliver Oranges@Ruhr first (already there, 0 hops), then Steel→Praha

Result: `pickup(Oranges@Valencia) → pickup(Steel@Ruhr) → deliver(Oranges@Ruhr) → deliver(Steel@Praha)`

This saves ~8 turns of unnecessary north-south-north travel.

#### Where to implement

**Option A: In RouteValidator (preferred)**
After the LLM route passes validation, reorder stops before returning the validated route. This keeps PlanExecutor simple and fixes all LLM-produced routes.

**Option B: In PlanExecutor.execute()**
Before processing the current stop, check if a later stop is closer and has no unmet prerequisites. Swap the stop index. This is more surgical but adds complexity to PlanExecutor.

**Option C: In the LLM prompt**
Add geographic context ("You are currently at Barcelona, 3 hexes from Valencia") and instruct the LLM to order stops by proximity. This is fragile — LLMs don't reliably optimize geographic routing.

**Recommendation: Option A** — deterministic reordering in RouteValidator provides consistent behavior regardless of LLM quality.

### Edge cases

- **Same-city pickup and delivery** (e.g., both Oranges pickup and delivery at Ruhr): pickup must precede delivery, greedy algorithm handles this naturally
- **Single-stop routes**: no reordering needed
- **All stops at same city**: order doesn't matter, pickup-before-deliver constraint maintained
- **Ferry crossings**: hop distance should account for ferry, `estimateHopDistance` already does this
- **Capacity constraints**: if bot has 2-load capacity and route has 3 pickups, the greedy order might pick up 2 loads then be unable to pick up the 3rd. But current LLM routes rarely exceed capacity, and RouteValidator already checks this.

## Acceptance Criteria

1. Multi-stop routes are reordered by geographic proximity to the bot's current position
2. Pickup-before-delivery constraints are maintained (can't deliver a load before picking it up)
3. For the Flash scenario: Oranges@Valencia is ordered before Steel@Ruhr when bot is near Barcelona
4. Single-stop and already-optimal routes are unchanged
5. Existing tests continue to pass

## Files to Modify

1. **`src/server/services/ai/RouteValidator.ts`** — Add `reorderStopsByProximity()` method, call after validation passes
2. **`src/server/services/ai/MapTopology.ts`** — May need `estimateHopDistance` (already exists)
3. **`src/server/__tests__/ai/RouteValidator.test.ts`** — Tests for reordering with dependency constraints

## Test Plan

1. Unit test: 4-stop route near Valencia reorders Oranges pickup before Steel@Ruhr
2. Unit test: Pickup-before-delivery constraint maintained after reordering
3. Unit test: Single-stop route unchanged
4. Unit test: Route where score-order matches geographic order — no change
5. Integration: Replay game 000cb369 scenario, verify bot picks up Oranges at Valencia before heading north
