# JIRA-211 — Validator falsely rejects feasible delivery when an unaffordable stop precedes it

## Game evidence

- Game: `b1dc793c-0b91-43d8-b150-d87ceb7057c3`
- Player: Haiku, turn 13
- Position: Krakow, cash 27M ECU, freight train, Labor on board (already picked up earlier)
- Track network: 36 mileposts centered on Wien; Antwerpen unreachable without ~36M of new build, Milano reachable via Warszawa for ~23M of new build (~4M to Warszawa pickup, ~19M to Milano delivery)
- Demand cards in hand at this moment include both Labor → Antwerpen (26M, on the same card as Coal → Madrid) and Ham Warszawa → Milano (26M)

## What happened

Trip planner called the LLM with both options visible. The LLM's first response combined them into a single multi-stop trip: deliver the carried Labor at Antwerpen first, then pick up Ham at Warszawa, then deliver Ham at Milano. The validator rejected the route. The retry feedback the LLM received read:

> Route infeasible: Cumulative budget exceeded: need ~36M track to reach Antwerpen, only ~27M remaining after prior stops.; Deliver for Ham was infeasible — pickup without viable delivery is wasteful.; Cumulative budget exceeded: need ~19M track to reach Milano, only ~13M remaining after prior stops.

The Antwerpen rejection is correct — Labor → Antwerpen needs 36M of build with 27M cash, no way to fund it. The Milano rejection is **wrong**. With 27M cash the bot can afford 4M to Warszawa, then deliver Ham at Milano for 26M, which more than covers the 19M build to Milano. End-of-route cash would be ~30M. The route is profitable.

The validator gave Milano "13M remaining after prior stops" — but the only "prior stop" the validator deducted was the Antwerpen one it had just marked infeasible. The bot was never going to visit Antwerpen, so its cost should not have been charged against the budget for Milano.

The LLM saw the retry feedback, concluded that the only viable play was a single-stop Labor → Antwerpen delivery (which is unprofitable and unaffordable but matches the carried load), and submitted that. The validator rejected that for the same Antwerpen budget reason. Two more retries hit the same wall, then the strategy-brain fallback fired three times with the same validator behavior. The turn ended with no route accepted.

## What we wanted

The bot already had the answer in front of it: pick up Ham at Warszawa, deliver Ham at Milano, keep carrying Labor for now (capacity 2, one slot free). That route should pass validation. Instead, an unrelated infeasible stop earlier in the LLM's proposed sequence poisoned the running-cash math for every stop after it, and we sent the LLM into a loop trying to recover from a problem of our own making.

The validator should treat infeasible stops as "the bot won't take this" — they should not drain the running budget for the stops that actually would be taken. The pruned route in this scenario should be `pickup Ham → deliver Ham at Milano`, with Antwerpen surfaced as the rejected stop.

## Scope

Single observation on a single turn in a single game. Not generalizing.

## Out of scope

- LLM reasoning quality on retry (the second-attempt single-stop response, which proposed an unaffordable Labor → Antwerpen). This is a prompt/strategy concern, not a validator concern.
- Strategy-brain fallback also failing (it hit the same validator).
- Whether the bot should drop the Labor when no profitable Antwerpen route exists. Stuck-state recovery is a separate concern.
