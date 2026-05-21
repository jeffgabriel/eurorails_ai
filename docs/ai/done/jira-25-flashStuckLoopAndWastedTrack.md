# JIRA-25: Bot Spends All Money, Gets Stuck in Pickup-Drop Loop Forever

Game: `d8102498-e1fb-4cee-8247-6d70be6224a8` (bot: flash, green)

---

## Implementation Status

| Bug | Status | Implemented In | Notes |
|-----|--------|---------------|-------|
| Bug 1 (Critical) | Deferred | → Project A | Multi-turn build budget tracking; overlaps JIRA-30 Bug 1 |
| Bug 2 (Critical) | In Progress | Compounds `025751be` Task 1 | Guardrail pickup-drop loop fix |
| Bug 3 (High) | In Progress | Compounds `025751be` Task 3 | Dead-end/ocean segment filtering |
| Bug 4 (High) | Deferred | → Project A | Multi-turn build budget tracking; same root cause as Bug 1 |
| Bug 5 (High) | In Progress | Compounds `025751be` Task 2 | Pickup delivery feasibility check |
| Bug 6 (Medium) | Duplicate | = JIRA-30 Bug 2 | 0M recovery strategy — tracked there |

---

## What Happened

Flash planned to deliver Flowers from Holland to Oslo for 12M. To reach Oslo, it needed to build track — a lot of it. Over three turns (14-16) it spent every last ECU building toward Oslo. When the money ran out, it was still 2M short of connecting. Now it had 0M, a route it couldn't finish, and no way to earn money.

From turn 17 onward, two guardrails fought each other in an infinite loop:
1. Guardrail 4 says "You have loads — you can't pass. Move somewhere."
2. Flash tries to move, can't deliver anything (Oslo unreachable, no other deliveries match).
3. Guardrail 5 says "That load is undeliverable — drop it."
4. Flash drops the load.
5. Next turn: Flash walks through Bremen or Holland, a guardrail forces a pickup (matching demand exists).
6. Go to step 1.

This repeated for 10+ turns. Flash never recovered.

---

## Timeline

| Turn | What happened | Money | Loads | Problem |
|------|--------------|-------|-------|---------|
| 13 | Delivers Coal at München for 8M. Route complete. | 30M | — | |
| 14 | Plans Flowers@Holland→Oslo. Starts building toward Oslo. | 20M | — | Spending everything on one route. |
| 15 | Continues building toward Oslo. | 10M | — | |
| 16 | Continues building. Money hits 0M. Still 2M from Oslo. | 0M | — | Route unfinishable. No money to build, earn, or recover. |
| 17 | Picks up Flowers at Holland (guardrail forces it). Route abandoned — can't reach Oslo. | 0M | Flowers | |
| 18 | Guardrail drops Flowers as undeliverable. | 0M | — | |
| 19 | Moves to Bremen area. | 0M | — | |
| 20 | Guardrail forces Machinery pickup at Bremen. | 0M | Machinery | |
| 21 | Guardrail drops Machinery as undeliverable. | 0M | — | |
| 22-26 | Same pattern repeats every 2 turns. | 0M | cycling | Infinite loop. |

---

## Bug 1 (Critical): Bot spends all money building toward a destination it can't afford to reach

Flash had 30M. It needed ~32M of track to reach Oslo. It spent all 30M and got stuck 2M short. A human player would check the total cost before committing, or at least keep enough cash to do something else if the plan fails.

The bot committed to a multi-turn build plan without verifying the total cost was within budget. Each turn it spent its full 20M build allowance without asking "will I have enough left to finish?"

**What should happen:** Before committing to a multi-turn build, estimate the total cost. If total cost exceeds available cash, either find a cheaper route, pick a different delivery, or reserve enough cash to pivot.

---

## Bug 2 (Critical): Two guardrails fight each other in an infinite loop

Once Flash is stuck at 0M with no deliverable route:
- **Guardrail 4** (no passing with loads): Forces Flash to move instead of passing. But there's nowhere useful to go.
- **Guardrail 5** (drop undeliverable loads): Detects the load can't be delivered and drops it.
- **Next turn**: Flash walks through a city with an available load matching a demand card. A guardrail or the TurnComposer forces the pickup. Now Guardrail 4 kicks in again.

Each guardrail is individually correct. Together they create a permanent loop. Neither guardrail knows the bot is broke and stuck — they just see "you have a load, move" and "that load is undeliverable, drop it."

This is the same class of bug as JIRA-24 Bug 3 and Bug 6: the pipeline has no concept of "I'm stuck and need a fundamentally different strategy." Individual guardrails optimize locally but create global deadlocks.

**What should happen:** Detect the stuck state. If the bot has 0M, no deliverable loads, and no route that doesn't require building, it should either: discard its hand for new demand cards, or pass turns until an event changes the situation. The guardrails need a circuit breaker.

---

## Bug 3 (High): Bot builds 2 segments into the ocean

Flash's Norwegian track includes two segments that lead nowhere:

1. **(9,49)→(8,50)**: At Hirshals, instead of just crossing the ferry, the bot also built a branch segment east — 1M wasted on a dead-end spur next to the ferry port.
2. **(2,49)→(2,50)**: At the far north end of the Norwegian coast, the bot built a segment leading off the edge of the map into the ocean. Another 1M gone.

The Hirshals-to-Oslo route itself was a reasonable gambit — Oslo is a major city with good deliveries. But the bot built sloppily. Two segments lead literally into water, adding 2M of waste to an already tight budget. On a route where the bot ended up 2M short of connecting to Oslo, those 2 wasted segments are the difference between success and permanent bankruptcy.

**What should happen:** The build planner should never build to ocean/water mileposts. Track segments should only target valid land mileposts that advance toward the destination.

---

## Bug 4 (High): Wasted track near Hirshals ferry — expensive infrastructure that never paid off

Flash built an 8M ferry crossing at Hirshals (rows 8-9) plus ~8M of mountain track into coastal Norway (rows 2-5). This track was never used for a single delivery. After running out of money 2M short of Oslo, the entire Norwegian spur became dead infrastructure — 16M+ that could have connected to actual delivery cities.

The ferry gambit could have worked if the bot had built efficiently. But between the 2 ocean segments (Bug 3) and the tight budget, it burned through 30M without completing the route.

**What should happen:** Before building expensive infrastructure (especially ferry crossings at 8M), verify the total cost to complete the route fits within budget. Track the running total across turns and abort early if the math stops working.

---

## Bug 5 (High): Bot doesn't check if route is completable before picking up the load

On turn 17, Flash picks up Flowers at Holland for the Oslo delivery. But the route to Oslo is incomplete — Flash is 2M short with 0M in the bank. The bot knows the route is unfinished. It picks up the load anyway.

This is related to JIRA-24 Bug 1 (bot picks up infeasible loads), but the mechanism is different. In JIRA-24, the delivery city was on a different landmass. Here, the delivery city is on the planned route — but the route isn't built yet and can't be completed.

**What should happen:** Before picking up a load, verify the delivery destination is actually reachable — not just planned, but connected or affordably connectable.

---

## Bug 6 (Medium): No recovery strategy when broke

Once Flash hits 0M, the bot has no strategy for recovery. It doesn't:
- Discard its hand to get new, potentially closer/cheaper demand cards
- Look for loads it could deliver on its existing track without building
- Evaluate which of its current demands are achievable from its current position with 0M

A human player at 0M would scan their hand for any delivery achievable on existing track, even a low-value one. Earn 5M, then you can build again. The bot doesn't consider this — it keeps trying the same unfinishable route.

**What should happen:** When money is 0, switch to "survival mode": find the highest-value delivery achievable on existing track without any building. If none exist, discard hand.

---

## Summary

| # | Severity | Bug | Impact |
|---|----------|-----|--------|
| 1 | Critical | Bot spends all money on route it can't afford to complete | Permanent 0M state |
| 2 | Critical | Guardrails fight: force-pickup → drop-undeliverable → repeat | Infinite loop |
| 3 | High | Bot builds 2 segments into the ocean (invalid water mileposts) | 2M wasted — the exact shortfall |
| 4 | High | Expensive ferry infrastructure never paid off, no budget tracking across turns | 16M+ dead infrastructure |
| 5 | High | Bot picks up load for incomplete/unaffordable route | Wasted turns |
| 6 | Medium | No recovery strategy at 0M — doesn't discard hand or find easy deliveries | Stuck forever |
