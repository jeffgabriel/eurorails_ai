# JIRA-24: Bot Picks Up Loads It Can't Deliver, Gets Permanently Stuck

Game: `5e97209c-ad00-4461-8c70-6946d54267a7` (bot: haiku)

---

## What Happened

The bot planned a simple route: pick up Wine at Frankfurt, deliver to Paris for 11M. While traveling toward Frankfurt, it passed through Wroclaw and grabbed Copper — because a demand card wanted Copper delivered to Birmingham. That Copper filled the train to capacity. When the bot arrived at Frankfurt three turns later, it couldn't pick up Wine. It got stuck there permanently.

The Wine and Copper demands are on the **same card** (card 14: Wine→Paris 11M, Copper→Birmingham 29M, Steel→Venezia 19M). If the bot had ignored the Copper and delivered the Wine, card 14 would have been discarded — and the Copper demand would have disappeared with it. The bot sabotaged its own plan to chase a demand it was about to throw away.

Birmingham is in England. The bot's track is entirely on the mainland. Getting to Birmingham means crossing the English Channel — something the bot can't afford with 19M. The Copper was dead weight the moment it was picked up.

---

## Timeline

| Turn | What happened | Money | Loads | Problem |
|------|--------------|-------|-------|---------|
| 21 | Deliver Machinery at Praha. Route completes. | 26M | Imports | |
| 22 | LLM plans Wine@Frankfurt→Paris. Moves through Wroclaw, **grabs Copper**. Builds toward Frankfurt. | 19M | Imports, Copper | Copper fills train. Birmingham is unreachable. |
| 23-25 | Route executor: move toward Frankfurt | 19M | Imports, Copper | |
| 26 | Arrives at Frankfurt. Pickup Wine fails: "Train full (2/2)" | 19M | Imports, Copper | Route abandoned. No audit recorded. |
| 27-29 | Same plan, same failure, every turn | 19M | Imports, Copper | No audits. Bot permanently stuck. |

---

## Bug 1 (Critical): Bot grabs loads it can't feasibly deliver

The bot picks up any load that matches any demand card, without asking whether the delivery is realistic. A load going to a city on your existing track is treated the same as a load going across a body of water to a different landmass.

On turn 22, the bot spotted Copper at Wroclaw. Card 14 wants Copper→Birmingham for 29M. So it picked it up. But Birmingham requires the English Channel crossing — completely out of reach. The bot now has dead weight filling a cargo slot.

A good opportunistic pickup doesn't require the delivery city to already be on the network — just that it's within affordable reach. If Luxembourg is 5M of track away and pays 10M, that's a great opportunity. If Birmingham is across the Channel, it's dead weight. The bot needs to weigh the cost to connect against the payout.

**What should happen:** Before an opportunistic pickup, estimate the track cost to reach the delivery city. If the delivery city is on the network or nearby (build cost well below payout), pick it up. If it requires major infrastructure the bot can't afford, leave it alone.

---

## Bug 2 (Critical): Opportunistic pickup fills last cargo slot, blocking the planned pickup

Picking up Copper at Wroclaw was free — hauling it costs nothing. The problem isn't that the bot grabbed it. The problem is that grabbing it filled the train to 2/2, and the route's next stop was a pickup (Wine at Frankfurt). The Copper blocked the Wine pickup and the entire route collapsed.

If the bot had one empty slot remaining, the Copper would have been harmless cargo. But the bot had exactly one slot left, and the route needed it.

**What should happen:** If the route's next stop is a pickup, reserve a cargo slot for it. Opportunistic pickups are fine when there's spare capacity — but don't fill the last slot when the route plans a pickup ahead.

---

## Bug 3 (Critical): Bot can't drop loads to unblock itself

Once the bot arrives at Frankfurt with a full train (Imports + Copper), it has no way to recover. The pipeline can plan PICKUP, DELIVER, MOVE, BUILD — but never considers DROP. When the pickup fails, the route is abandoned and the bot enters a loop:

1. Plan Wine pickup → fail (train full) → abandon route
2. LLM replans → same route → same failure
3. Repeat forever

A human player would immediately drop the Copper (it's going nowhere useful) and pick up the Wine.

**What should happen:** When a pickup fails due to full capacity, evaluate current cargo. Which loads have feasible deliveries? Which are dead weight? Drop the worst one, then retry.

---

## Bug 4 (High): Bot replans the same abandoned route every turn

Turn 26: Route `Wine@Frankfurt → Paris` fails and is abandoned. The system saves `lastAbandonedRouteKey = "Wine:Frankfurt"`.

Turn 27: LLM plans the exact same route. Fails again. Abandoned again.

Turns 28, 29: Same route, same failure, same abandonment.

The abandoned route key exists in the bot's memory for exactly this purpose, but the LLM route planner never checks it.

**What should happen:** After abandoning a route, don't replan the identical route on the next turn. Try a different route or address the underlying blocker (full train) first.

---

## Bug 5 (High): Bot wastes turns by not combining actions

Throughout the game the bot performs one action per turn when it could do several.

**Turns 7-9:** The bot needs to travel to Wroclaw for Coal. It spends three turns just moving. On turn 10 it finally picks up Coal, then spends two more turns moving to deliver. A human player would move to Wroclaw, pick up Coal, and start moving toward the delivery city — all in one turn.

**Turn 14:** The bot picks up Chocolate at Bruxelles using 2 of its 9 movement points. It tries to continue toward Berlin but can't because Berlin isn't connected yet. It builds 1 segment toward Berlin. Turn ends with 7 movement points unused. After building that segment, it could have started moving — but it waits until next turn.

**Turn 21:** After delivering at Praha, the bot tries a continuation move but generates a path of 18 mileposts on a 9-milepost budget. The guardrail catches and truncates it, but the path shouldn't be double the budget in the first place.

**What should happen:** Each turn should use the full movement budget. Move to a city, pick up, continue moving, build — all in one turn. Per game rules, loading and unloading don't cost movement points.

---

## Bug 6 (Medium): Guardrail override produces broken moves

When the bot tries to pass while carrying loads, a guardrail blocks it and overrides to a Move. But the override move has an empty path — it says "move toward Ruhr" but doesn't compute an actual route.

In the Frankfurt loop, every turn:
- Guardrail says: "Blocked PASS with loads: overriding to MOVE toward Ruhr to pick up Steel"
- The target is irrelevant — the bot doesn't need Steel, it needs to DROP a load
- The override produces an empty movement path
- Execution fails: "Empty movement path"

**What should happen:** The override should either compute a real path or not override at all.

---

## Bug 7 (Medium): No audit trail when bot is stuck

Turns 26-29 have zero records in both `turn_actions` and `bot_turn_audits`. The bot played 4 turns and left no trace. The only way to discover what happened was querying the raw database and reverse-engineering the game state.

**What should happen:** Every bot turn should produce an audit record, even — especially — when it fails.

---

## Bug 8 (Medium): Post-delivery replanning erases the existing route instead of extending it

After a delivery, the bot draws a new demand card. The LLM should evaluate whether the new card creates a nearby opportunity — maybe the new demand is for a city the bot is about to pass through, or a load available at the next stop. That's worth changing plans for.

But today the active route is simply erased and the LLM starts from scratch. It doesn't see the previous plan. It can't weigh "stick with the current route" against "detour for this new opportunity." It's forced to plan as if nothing was in progress.

This means multi-stop routes are fragile. Deliver at the first stop, draw a new card, and the remaining stops are gone. The LLM might replan the same route — or it might not.

**What should happen:** After a delivery, call the LLM with the existing route as context. Let it decide: continue the current route, extend it with a new stop, or abandon it for a better opportunity. Don't erase the route before asking.

---

## Summary

| # | Severity | Bug | Impact |
|---|----------|-----|--------|
| 1 | Critical | Bot picks up loads it can't feasibly deliver (no cost/distance check) | Dead weight fills cargo |
| 2 | Critical | Opportunistic pickup fills last cargo slot, blocking planned pickup | Route collapses |
| 3 | Critical | Bot can't drop loads to unblock itself | Permanent stuck state |
| 4 | High | Bot replans the same failing route after abandoning it | Infinite loop |
| 5 | High | Bot wastes turns doing one action instead of chaining move+pickup+move+build | Slow play, wasted movement |
| 6 | Medium | Guardrail override produces empty movement paths | Failed recovery |
| 7 | Medium | No audit trail when pipeline errors | Invisible failures |
| 8 | Medium | Post-delivery replanning erases route instead of extending it | Fragile multi-stop routes |
