# JIRA-165: Sunday Bug Roundup — Game 308d2270

## Game at a glance

60-turn game, Haiku vs Flash. Haiku goes broke at T28 and oscillates for 33 turns. Flash chases a demand card that no longer exists and wastes 7 turns + 22M of track. Neither bot upgrades or discards stale cards. Nobody wins.

| | Haiku | Flash |
|---|---|---|
| Deliveries | 4 (67M) | 7 (153M) |
| Final cash | $0 | $0 |
| Track cost | 117M (174% of income) | 203M (133% of income) |
| Connected cities | 2/7 | 3/7 |

---

## Bug 1: Post-delivery replan uses stale demand cards (CRITICAL)

**What happens:** Flash delivers China at Ruhr on T40. The database replaces card #79 with newly drawn card #30. But the post-delivery replan calls the trip planner with the original context — still containing card #79's demands (Cork at 59M, Wheat at 26M). The LLM picks Cork→Wroclaw because it's the highest-scoring route in the data it was given. Flash builds 22M of track to Sevilla over 7 turns, arrives, can't pick up Cork (no demand card for it), abandons the route.

**The LLM did nothing wrong.** The prompt said Card 79: Cork from Sevilla → Wroclaw (59M). The LLM picked the best route from the data. The data was stale.

**Root cause:** `TurnExecutorPlanner.ts:311` — post-delivery replan calls `tripPlanner.planTrip(snapshot, context, ...)`. After delivery, lines 270-296 filter out the delivered demand (China) but leave the other demands from the now-replaced card (Cork, Wheat). The demand refresh in `AIStrategyEngine.ts:922` (JIRA-64) runs AFTER the executor returns — too late.

**Fix:** After filtering the delivered demand at line 296, refresh `context.demands` from the database before calling the trip planner:

```typescript
const freshSnapshot = await capture(snapshot.gameId, snapshot.bot.playerId);
context.demands = ContextBuilder.rebuildDemands(freshSnapshot, gridPoints);
snapshot.bot.resolvedDemands = freshSnapshot.bot.resolvedDemands;
```

---

## Bug 2: Route ordering ignores deliverable carried loads (HIGH)

**What happens:** Haiku at T24 has Imports loaded, deliverable at Lodz (on-network via Wien). Route: pickup Imports → **pickup Fish at Aberdeen** → deliver Imports at Lodz → deliver Fish at Krakow. Current stop is Aberdeen (index 1). Bot spends 43M building toward Aberdeen, goes broke, oscillates for 33 turns — while carrying a load it could deliver for 19M+ by just moving on its own track.

**North star violation:** Delivering Imports first = free movement + 19M income + funds to build toward Aberdeen later. Building toward Aberdeen first = 43M spent + $0 + stuck. The math is obvious but the pipeline doesn't do it.

**Root cause:** The route executor follows stops in order. It doesn't skip ahead to a deliverable stop when the current stop requires expensive building. The trip planner generated the route with pickups before deliveries, which is normally correct — but not when the pickup requires building and the delivery is free.

**Fix:** When the current stop requires building to an off-network city AND the bot is carrying a load deliverable at an on-network city, reorder: deliver first, then resume the route. This is a capital allocation decision — deliver for income before spending on builds.

---

## Bug 3: Ferry oscillation (HIGH)

**What happens:** Haiku at $0 oscillates London↔(22,33) for 33 turns. Speed alternates 9/5 — the bot crosses the English Channel ferry every turn (stop at port, half rate next turn). It reaches London, tries to go toward Aberdeen (off-network), reverses back across the ferry, repeats.

**Partially addressed by JIRA-162 + JIRA-164.** The directional runway fix (JIRA-162) and broke-bot-gate removal (JIRA-164) prevent some oscillation patterns, but this specific pattern combines $0 cash + ferry crossing + off-network target. The bot should detect that oscillating across a ferry achieves nothing and switch to delivering its carried Imports.

**Fix:** Ferry-aware oscillation detection. If the bot's last 4 positions alternate between the same two points and one involves a ferry crossing, break the loop — either deliver a carried load, discard the hand, or pass turn.

---

## Bug 4: No train upgrades (LOW)

Neither bot upgrades from Freight in 60 turns. Flash had 51M at T21 — could have upgraded to Fast Freight for 20M. At 88% movement efficiency over 59 turns, +3 speed would have saved turns on every delivery.

**Already noted in previous games.** Upgrade consideration is gated behind the build phase — when build target is invalid or skipped, upgrades aren't considered.

---

## Bug 5: No hand discard despite stale cards (LOW)

Haiku holds card#128 for 59 turns. Flash holds card#122 for 59 turns. Neither bot discards once. With JIRA-164's broke-bot-gate removal, the LLM now has to decide when to discard — but it needs guidance in the prompt about when holding stale cards is costing more than a fresh draw.

---

## ContextBuilder gaps found during investigation

These aren't game-specific bugs — they're structural weaknesses in the context pipeline:

1. **In-place mutation of snapshot during execution** — `snapshot.bot.resolvedDemands` and `snapshot.bot.loads` are mutated mid-turn by TurnExecutorPlanner and ActionResolver. The snapshot stops being a snapshot. Not causing bugs today but fragile.

2. **`canBuild` uses `money > 0`** — should be `money >= 1` for clarity. Both are equivalent ($0 can't build, $1 can build clear terrain) but `> 0` reads like an arbitrary floor.

3. **No integrity check on resolved demands** — `WorldSnapshotService` reads `hand` from the DB and resolves via `DemandDeckService.getCard()`. If the DB is stale from a concurrent update, no check catches it.

4. **Null supplyCity after JIRA-164** — `supplyCity` is now `null` for carried loads (was "OnTrain"). Most consumers handle null safely. Need to verify `formatDemandView` (line 1283) and `serializeRoutePlanningPrompt` (line 1019).

---

## What to fix first

Bug 1 is the only one that needs code. The fix is small — add a `rebuildDemands` call in TurnExecutorPlanner after delivery, before the replan. Everything else is either already addressed by JIRA-162/164, a design improvement (route reordering), or a defensive check (null handling, integrity validation).
