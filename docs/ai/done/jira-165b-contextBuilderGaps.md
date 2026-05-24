# JIRA-165b: ContextBuilder Gaps — Stale Demand Cards in Post-Delivery Replan

## Critical Gap: Post-delivery replan uses stale demand card data

### The bug

When a bot delivers a load mid-turn, the demand card is replaced in the database with a newly drawn card. But the post-delivery replan in `TurnExecutorPlanner` (line 311) calls `tripPlanner.planTrip(snapshot, context, ...)` with the **original context** from the start of the turn. This context contains demands for the old card, not the newly drawn replacement.

### Evidence — Game 308d2270, Flash T40

1. **Start of T40:** Flash has cards #79 (China, Wheat, Cork), #122, #67
2. **Mid-turn:** Flash delivers China at Ruhr → card #79 is replaced in DB by card #30 (Potatoes, Fish, China)
3. **Post-delivery replan (TurnExecutorPlanner.ts:311):** `tripPlanner.planTrip(snapshot, context, ...)` is called
4. **Context still contains card #79** (Cork, Wheat) — only the delivered China demand was filtered out (lines 270-296)
5. **Trip planner prompt shows:** `Card 79: Cork from Sevilla → Wroclaw (59M)` — a demand that no longer exists
6. **LLM picks Cork→Wroclaw** as the best route (59M, 1.6M/turn) — correctly following the data it was given
7. **Result:** Flash builds 22M of track to Sevilla, arrives, can't pick up Cork (no demand card), wastes 7 turns

### Root cause trace

```
TurnExecutorPlanner.execute() called with (route, snapshot, context)
  ↓
Phase A movement loop
  ↓
Delivery detected at line 250
  ↓
Lines 270-296: Filter delivered demand from context.demands
  (only removes the ONE delivered demand — China on card #79)
  ↓
Line 299: "Triggering post-delivery replan"
  ↓
Line 311: tripPlanner.planTrip(snapshot, context, gridPoints, memory)
  ↓
context.demands still contains Cork and Wheat from card #79  ← BUG
  (card #79 has been replaced in DB by card #30, but context wasn't refreshed)
  ↓
TripPlanner serializes prompt with stale card #79 demands
  ↓
LLM picks Cork→Wroclaw route
```

The demand refresh in `AIStrategyEngine.ts` (lines 922-946, JIRA-64) happens AFTER `TurnExecutorPlanner.execute()` returns — too late. The post-delivery replan inside TurnExecutorPlanner runs with stale data.

### Fix

**In `TurnExecutorPlanner.ts`, after filtering the delivered demand (line 296), refresh context.demands from the database:**

```typescript
// After line 296 (filtering delivered demand):
// Refresh demands from DB — the delivered card has been replaced with a new draw
const freshSnapshot = await capture(snapshot.gameId, snapshot.bot.playerId);
context.demands = ContextBuilder.rebuildDemands(freshSnapshot, gridPoints);
// Also update snapshot.bot.resolvedDemands for downstream consistency
snapshot.bot.resolvedDemands = freshSnapshot.bot.resolvedDemands;
```

This mirrors the same pattern already used in `AIStrategyEngine.ts:922-925` (JIRA-64) but moves it to the right place — inside the turn executor, before the replan, not after the executor returns.

---

## Other ContextBuilder Gaps Found During Review

### Gap 2: `snapshot.bot.resolvedDemands` mutated in-place during execution

Multiple locations mutate `snapshot.bot.resolvedDemands` during turn execution:
- `TurnExecutorPlanner.ts:285-296` — filters out delivered demands
- `ActionResolver.ts:1014` — filters after delivery

These in-place mutations mean the snapshot no longer reflects the DB state. If any downstream code re-reads the snapshot expecting original data, it gets modified data. This isn't causing bugs currently but is fragile.

### Gap 3: `context.loads` diverges from `snapshot.bot.loads` mid-turn

After delivery, `context.loads` is updated (line 258-265) but `snapshot.bot.loads` is also spliced (line 263). Both are modified in-place. If any code checks one but not the other, they could diverge. Currently consistent but fragile — a single missed update creates a mismatch.

### Gap 4: `canBuild` hardcodes `money > 0` check

`ContextBuilder.ts:103`: `const canBuild = (20 - turnBuildCost) > 0 && snapshot.bot.money > 0`

This is the `money > 0` check from JIRA-164. With the broke-bot-gate removed, this still prevents the context from reporting `canBuild = true` at $0. The bot can't build at $0 (correct per game rules — 1M minimum for clear terrain), but this should be `money >= 1` not `money > 0` since $0 truly can't build but $1 can. Currently equivalent but semantically wrong.

### Gap 5: No validation that `resolvedDemands` card IDs match `hand` column

`WorldSnapshotService.ts:86-100` reads `botRow.hand` (array of card IDs) and resolves them via `DemandDeckService.getCard()`. If `hand` in the DB is stale (e.g., concurrent update), the resolved demands will be stale. No integrity check exists.

### Gap 6: `supplyCity` set to `null` for carried loads (JIRA-164 fix) — downstream null handling

After the JIRA-164 fix, `supplyCity` is `null` instead of `'OnTrain'` for carried loads. Code that compares `supplyCity` to city names (e.g., `supplyCity === someCity`) will correctly not match `null`. But code that uses `supplyCity` without null checks could throw. Need to verify all consumers handle `null`.

Consumers to check:
- `ContextBuilder.ts:555` — `if (isColdStart && supplyCity && !isLoadOnTrain)` — safe (checks truthiness)
- `ContextBuilder.ts:569` — `isSupplyOnNetwork || !supplyCity || isLoadOnTrain` — safe
- `ContextBuilder.ts:762` — `isSupplyOnNetwork: supplyCity ? citiesOnNetwork.includes(supplyCity) : false` — safe
- `formatDemandView` (line 1283) — needs check
- `serializeRoutePlanningPrompt` (line 1019) — needs check
