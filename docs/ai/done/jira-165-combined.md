# JIRA-165 Combined: Game 308d2270 — All Bugs, Gaps, and Fix Plan

Consolidated from: `jira-165-game308d2270-buglist.md`, `jira-165-sunday.md`, `jira-165b-contextBuilderGaps.md`, `jira-165b-sundayGaps.md`.

## Game Summary

60-turn game, Haiku vs Flash. Both bots end at $0 — Haiku from overspending on track (Bug 2), Flash from chasing a stale demand card (Bug 1). Neither upgrades or discards stale cards.

| | Haiku | Flash |
|---|---|---|
| Deliveries | 4 (67M) | 7 (153M) |
| Final cash | $0 | $0 |
| Track cost | 117M (174% of income) | 203M (133% of income) |
| Connected cities | 2/7 | 3/7 |
| Movement efficiency | 57.6% | 88.0% |
| Train upgrades | None | None |

---

## Bug 1: Post-delivery replan uses stale demand cards — CRITICAL

### What happens
Flash delivers China at Ruhr on T40. Card #79 is replaced in the DB with newly drawn card #30. But the post-delivery replan calls the trip planner with the original context — still containing card #79's demands (Cork at 59M, Wheat at 26M). LLM picks Cork→Wroclaw. Flash builds 22M of track to Sevilla, arrives, can't pick up Cork (no demand card), wastes 7 turns + 22M.

### Root cause (verified)
`TurnExecutorPlanner.ts:311` — post-delivery replan calls `tripPlanner.planTrip(snapshot, context, ...)`. After delivery, lines 270-296 filter out ONLY the delivered demand (China) but leave the other demands from the now-replaced card (Cork, Wheat). The demand refresh in `AIStrategyEngine.ts:922` (JIRA-64) runs AFTER the executor returns — too late.

### Code trace
```
TurnExecutorPlanner.execute() called with (route, snapshot, context)
  → Phase A movement loop
  → Delivery detected at line 250
  → Lines 270-296: Filter delivered demand from context.demands
    (only removes the ONE delivered demand — China on card #79)
  → Line 311: tripPlanner.planTrip(snapshot, context, gridPoints, memory)
  → context.demands still contains Cork and Wheat from card #79  ← BUG
  → LLM picks Cork→Wroclaw route from stale data
```

### Fix (verified implementable)
After filtering the delivered demand at line 296, refresh context.demands from the database:
```typescript
const freshSnapshot = await capture(snapshot.gameId, snapshot.bot.playerId);
context.demands = ContextBuilder.rebuildDemands(freshSnapshot, gridPoints);
snapshot.bot.resolvedDemands = freshSnapshot.bot.resolvedDemands;
```
- `ContextBuilder.rebuildDemands()` exists at line 167
- `capture()` exists at WorldSnapshotService.ts:23

### Gap: JIRA-64 partially mitigates but doesn't prevent
- JIRA-64 (AIStrategyEngine.ts:897-921) refreshes demands AFTER executor returns and invalidates routes referencing cards no longer in hand
- So the stale route IS caught — but only after 1 turn of execution + any build commitment
- Edge case: if the new card shares a demand city with the replaced card, JIRA-64 invalidation might not catch it

### Status: NEEDS FIX — small code change, high impact

---

## Bug 2: Route ordering ignores deliverable carried loads — HIGH

### What happens
Haiku at T24 has Imports loaded, deliverable at Lodz (on-network via Wien). Route: pickup Imports → pickup Fish at Aberdeen → deliver Imports at Lodz → deliver Fish at Krakow. Current stop is Aberdeen (index 1). Bot spends 43M building toward Aberdeen, goes broke, oscillates for 33 turns — while carrying a load deliverable for 19M+ by moving on its own track (free).

### Root cause (verified)
TurnExecutorPlanner always follows `currentStopIndex` in order (line 199). No mid-execution reordering exists. RouteValidator.reorderStopsByProximity() (line 417) promotes carried-load deliveries at route creation time, but only if no nearby pickup is within 4 hops (lines 415-438). RouteEnrichmentAdvisor (JIRA-156) can reorder stops but only at planning time, not mid-execution.

### Gap: existing carried-load prioritization has a loophole
The 4-hop proximity gate means if the pickup (Aberdeen) appears "close" in terms of network hops (even if it requires expensive building), the delivery won't be promoted. The gate should also consider build cost, not just hop distance.

### Fix
When the current stop requires building to an off-network city AND the bot is carrying a load deliverable at an on-network city, reorder: deliver first, then resume the route. This is a new mid-execution capability — doesn't exist anywhere currently.

### Status: NEEDS FIX — new capability, medium complexity

---

## Bug 3: Ferry oscillation at $0 — HIGH

### What happens
Haiku at $0 oscillates London↔(22,33) for 33 turns. Speed alternates 9/5 — ferry crossing every turn. Bot reaches London, tries to go toward Aberdeen (off-network), reverses back across the ferry, repeats.

### Root cause (verified)
`noProgressTurns` stuck detection exists (GuardrailEnforcer lines 63-73) but has a critical gate: only fires when `!hasActiveRoute`. The bot HAS an active route (pointing to off-network Aberdeen), so stuck detection is entirely bypassed. The ferry oscillation continues indefinitely.

### Gap: stuck detection bypass is the real root cause
The doc attributes this to JIRA-162 + JIRA-164 combinations, but the core issue is simpler: stuck detection doesn't fire when an active route exists, even if the route is making zero progress. The ferry aspect is secondary — any oscillation with an active route bypasses stuck detection.

### Fix options
1. Remove `hasActiveRoute` gate from stuck detection (risky — may trigger false positives for bots traveling long routes)
2. Add separate oscillation detector: if last N positions form a cycle (same 2-4 positions repeating), force route abandonment regardless of active route status
3. Add build-affordability check: if current stop requires building and bot has $0, skip to next deliverable stop or abandon route

Option 3 addresses both Bug 2 and Bug 3 simultaneously.

### Status: PARTIALLY ADDRESSED by JIRA-162/164 — needs oscillation detection

---

## Bug 4: No train upgrades — CLOSED

### Status: FIXED by JIRA-161
Gate 2 removed (AIStrategyEngine.ts line 643). Suppression visibility added (line 274). Bots can now upgrade when eligible.

---

## Bug 5: Sevilla track waste — MEDIUM

### What happens
Flash builds 22 segments toward Sevilla for the fabricated Cork demand. Track connects nothing useful.

### Status: CONSEQUENCE OF BUG 1 — fixes with Bug 1

---

## Bug 6: No hand discard despite stale cards — LOW

### What happens
Haiku holds card #128 for 59 turns. Flash holds card #122 for 59 turns. Neither discards.

### Root cause
The LLM is never prompted to consider hand quality or staleness. After JIRA-164's broke-bot-gate changes, the LLM must decide when to discard — but needs prompt guidance about when holding stale cards costs more than a fresh draw.

### Status: PROMPT IMPROVEMENT — low priority

---

## ContextBuilder Structural Gaps

These aren't game-specific bugs — they're fragility in the context pipeline.

### Gap A: In-place mutation of snapshot during execution
`snapshot.bot.resolvedDemands` and `snapshot.bot.loads` are mutated mid-turn by TurnExecutorPlanner (line 285-296) and ActionResolver (line 1014). The snapshot stops being a snapshot. Not causing bugs today but fragile.

### Gap B: context.loads diverges from snapshot.bot.loads mid-turn
After delivery, both are modified in-place. Currently consistent but a single missed update creates a mismatch.

### Gap C: canBuild hardcodes money > 0
`ContextBuilder.ts:103`: `(20 - turnBuildCost) > 0 && snapshot.bot.money > 0`. Semantically should be `>= 1` but equivalent for integers. Also checks remaining build budget — more nuanced than originally noted.

### Gap D: No integrity check on resolved demands
`WorldSnapshotService.ts:86-100` reads `hand` from the DB and resolves via `DemandDeckService.getCard()`. If the DB is stale from a concurrent update, no check catches it.

### Gap E: supplyCity sentinel value confusion
- JIRA-164 filters `'OnTrain'` and `'(already carried)'` at the TripPlanner level (line 266)
- supplyCity in ContextBuilder uses `'NoSupply'` as sentinel (line 492), NOT null
- The jira-165b-contextBuilderGaps.md doc incorrectly claims supplyCity is set to null after JIRA-164
- formatDemandVictoryNote line 1387 has a minor edge case (`u.cityName === d.supplyCity` could match if both null) but unlikely with `'NoSupply'` sentinel

---

## Fix Priority

| # | Bug | Severity | Effort | Dependencies |
|---|-----|----------|--------|--------------|
| 1 | Bug 1: Stale demand cards in post-delivery replan | CRITICAL | Small | None — standalone fix in TurnExecutorPlanner |
| 2 | Bug 2: Route ordering ignores deliverable carried loads | HIGH | Medium | None — new mid-execution reorder in TurnExecutorPlanner |
| 3 | Bug 3: Ferry/general oscillation with active route | HIGH | Medium | Benefits from Bug 2 fix (option 3 addresses both) |
| 4 | Bug 6: No hand discard for stale cards | LOW | Small | Prompt change only |
| 5 | Gap D: No integrity check on resolved demands | LOW | Small | Defensive — not causing bugs yet |

Bug 4 is closed (JIRA-161). Bug 5 is a consequence of Bug 1.

### Recommended approach
Fix Bug 1 first (small, standalone, highest impact). Then tackle Bugs 2+3 together — a mid-execution "can I deliver instead of building?" check in TurnExecutorPlanner would resolve both the capital allocation failure and the oscillation pattern.

### Bug interaction
Bug 1 and Bug 2 compound into the same end state: broke bots that can't recover. Flash's stale-demand route (Bug 1) wasted 22M → $0. Haiku's wrong ordering (Bug 2) wasted 43M → $0. Both produce $0 bots caught by JIRA-164's death spiral. Fixing these together prevents the compound failure mode.
