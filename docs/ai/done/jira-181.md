# JIRA-181: Trip-planner discards good plans because our schema can't express carried loads

## What happened in game `189a6327`, turn 54

Nano was carrying Sheep + Steel with 0M cash. Three demand cards in hand: Steel→Wroclaw (14M), Ham→Stuttgart (21M), plus an unaffordable one. The ideal trip was a sequential 35M two-card plan:

1. Deliver the carried Steel at Wroclaw (+14M, easy — Wroclaw on-network).
2. Build a short spur from Wroclaw to Warszawa with the new cash.
3. Pickup Ham @ Warszawa.
4. Deliver Ham @ Stuttgart (+21M, already on-network).

Nano did none of it. The trip-planner installed "deliver Ham at Stuttgart" as the route — a single orphan deliver with no pickup — dropped Sheep, nearly dropped Steel, and wandered to Stuttgart carrying Steel it had no plan to deliver. 0M earned.

## Why: three things compounding

**1. Our schema can't express "the bot is already carrying this load."** Trip Rule #1 says "PICKUP before DELIVER for each load", and every DELIVER must be paired with a PICKUP in the stop list. For a load already on the train, the LLM had no clean encoding — so it invented `PICKUP Steel @ "null"` as a placeholder. Our validator correctly rejected that placeholder (no city named `"null"`), then the pair-prune rule dragged DELIVER Steel @ Wroclaw down with it. Easy money, thrown away.

**2. Our prompt teaches the LLM to reason single-turn.** We say "plan the best multi-stop trip for **this turn**" and show cash as a single number alongside per-card build costs. Nothing tells the LLM that mid-trip deliveries pay out immediately and fund later builds. So when the LLM saw "0M cash, 9M to build Warszawa spur", it treated the Ham leg as unaffordable — even though 14M from delivering Steel first would cover it. That's why it omitted the Ham PICKUP from Candidate 2 and then self-rejected the plan as "not realistically executable".

**3. Our selector ignores the LLM's choice.** The LLM picked Candidate 0 (safe, 14M). Our code re-scored every candidate post-pruning and installed whatever had the highest payout — which turned out to be Candidate 2's gutted skeleton (just `DELIVER Ham @ Stuttgart`, 21M, no pickup) because the validator pruned its two PICKUPs but left the orphan DELIVER. We overrode the LLM with a candidate the LLM had already rejected.

## The fix

Four changes, in order:

**Fix 1 — Stop making the LLM lie about carried loads.** Change the schema and prompt so carried loads are implicit starting state, not encoded as PICKUP stops. Tell the LLM: *"Loads already on the train at turn start are ready to deliver. Do NOT emit a PICKUP for them. Begin the plan with the DELIVER for any carried load whose matching demand card you hold."* Add one sentence to the TRIP RULES: *"Deliveries mid-trip pay out immediately; later pickups and builds can be funded by earlier deliveries' income in the same trip."* Update the validator to accept a DELIVER as feasible when the load is already on the train, whether or not a PICKUP for it appears in the candidate. Remove the pair-prune rule that drops a DELIVER because its same-loadType PICKUP was infeasible.

**Fix 2 — Add a `DROP` action to the schema.** Today the LLM sometimes encodes "dump this unwanted load" as `DELIVER` with `demandCardId: null` and `payment: 0` (seen in turns 45, 51, 54). We silently accept those and the bot routes to a city to execute a zero-payout "delivery". Add a proper `DROP` primitive so the LLM can say "drop Sheep at Holland" cleanly. Make `DELIVER` strictly require a matching demand card the bot holds — any `DELIVER` with a null, zero, or unmatched `demandCardId` is infeasible. Update the prompt, schema, and example to show `DROP` usage.

**Fix 3 — Reject DELIVERs that have no home.** A DELIVER is feasible only if the bot either (a) already carries the load, or (b) has a feasible PICKUP earlier in the same candidate — AND references a real demand card (from Fix 2). Orphan deliveries get pruned. This closes the other half of the hole that let Candidate 2's Ham-deliver skeleton survive.

**Fix 4 — Respect the LLM's `chosenIndex`.** Use the LLM's pick as the primary selector. Fall back to internal scoring only when the chosen candidate is out of range or fails validation entirely. Our scoring is a sanity check, not an override.

## What the bot does after this ships

On turn 54 with the improved schema and prompt, the LLM writes Candidate 2 cleanly as three stops: DELIVER Steel @ Wroclaw, PICKUP Ham @ Warszawa, DELIVER Ham @ Stuttgart. It picks that candidate (35M over ~6 turns beats 14M over ~3 turns). The validator accepts all three stops — carried-Steel DELIVER passes, PICKUP Ham passes, Ham DELIVER pairs with its PICKUP. The route installs as written. Nano delivers Steel, builds the Warszawa spur, picks up Ham, delivers Ham. 35M banked.

## What does NOT change

- The three-candidate contract with the LLM.
- The scoring math (role shrinks to fallback/tiebreaker).
- Everything downstream of route installation (movement, building, pickup execution).

## Success measure

Replay turn 54 and verify:
- The installed route has no orphan DELIVER (every DELIVER is either for a carried load or has a PICKUP earlier in the route).
- Nano keeps Steel through turn 54 and delivers it at Wroclaw.
- The LLM's `chosenIndex` is honored whenever the chosen candidate validates.

Unit tests:
- Validator: DELIVER Steel feasible when bot carries Steel and no PICKUP is in the candidate; infeasible for Ham when not carried and no PICKUP.
- Validator: DELIVER with unmatched `demandCardId` is infeasible; DROP with any loadType at any city is feasible.
- TripPlanner: `chosenIndex: 2` where Candidate 2 validates — Candidate 2 wins regardless of internal score.
