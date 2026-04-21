# JIRA-187: Capacity-aware delivery strategy for entry-capped cities

## Status

Proposal for review. No implementation yet.

## The problem

Eurorails caps how many players can build track into small and medium cities:

- **Small city:** 2 players max
- **Medium city:** 3 players max

When the cap is already reached by opponents, a bot that plans a delivery requiring it to build into that city can **never build** — the `CITY_ENTRY_LIMIT` hard gate rejects the build plan every turn. The BuildAdvisor still proposes the build, the resolver still finds a "valid" segment path, but the TurnValidator strips it and the turn collapses to `PassTurn`. The bot loops forever.

Observed in game `25d8059e-ea12-4d22-9e7d-b35a9844a7df`, Haiku T65–T74 and T81–T84: stuck outside Cardiff with a `Labor → Cardiff` delivery stop. Two opponents already had track into Cardiff. Haiku had $96M cash and all other gates passing — but the city-entry cap made the build illegal. The bot kept re-proposing the same impossible build for 15+ turns and never adapted.

The observability fix in JIRA-??? / commit `24bcb9e`+`0117d5a` now surfaces the real `firstViolation` in the game log so we can detect this condition from outside. But the bot itself is still blind to it.

## What a human player does

Given the same state (two opponents already at Cardiff, one carrying a `Labor → Cardiff` demand), a human evaluates three paths in roughly this order:

1. **Don't commit to the route in the first place.** Before accepting a delivery contract, check whether the destination city has cap room. If two players are already at a small city, planning a build-and-deliver route there is a waste — the demand should be discarded (or deprioritized in the scorer) and a different card pursued.

2. **Pay to use an opponent's track.** Track usage is flat $4M per opponent per turn — not per milepost. If an opponent already has a short stub into the capped city, pay the $4M, roll the bot onto their track, complete the delivery, and come back — all in the same turn if the stub is short enough that the round trip fits inside the movement budget.

   Concrete example from the game: Flash had a 3-segment stub into Cardiff. Haiku's Freight moves 9 mileposts/turn. A round trip across Flash's 3 segments is 6 mileposts, well inside budget. Total cost: **$4M**. Delivery payout was $38M. Net profit: $34M — versus infinite PassTurn.

3. **Drop at a reachable nearby city.** If track-usage fees exceed the delivery payout (e.g. payout is $15M but the opponent's stub is long enough that fees compound across multiple turns), head toward a city that IS on the bot's own network *in the same direction* (e.g. Birmingham for a Cardiff-bound delivery), drop the load there, and discard the demand card. This salvages the turn's movement spend and clears the hand for fresh cards.

A human almost never chooses option 1 alone — they use it as a pre-commit gate. Once a route is already committed (load is on the train), options 2 and 3 are the real choice.

## Proposed bot behavior

Introduce a capacity check at two layers:

### Layer 1 — Pre-route scoring (`TripPlanner` / demand scorer)

Before the LLM is asked to pick among demand cards, the demand-scoring pipeline should know for each candidate demand:

- Is the delivery city small or medium?
- How many players (excluding this bot) already have track into the delivery milepost?
- Is the cap already reached?

If capacity is reached AND this bot does not already have track there, the demand's score should be penalized heavily — not zeroed, because options 2 and 3 may still be viable and profitable, but penalized enough that a comparable demand with an unrestricted destination is preferred.

### Layer 2 — Post-commit strategy (`TurnExecutorPlanner` / guardrail)

Once the bot has an active route whose next stop's delivery city is capacity-capped, the bot must NOT keep proposing illegal builds. Each turn it should evaluate three alternatives in order:

**2a. Track-usage delivery.** Is there an opponent with owned track connecting the bot's network to the capped delivery city? If yes, and the total fee cost (flat $4M per opponent per turn of traversal) is less than the delivery payout minus a reasonable reserve, generate a `MoveTrain` plan that pays the fee and reaches the delivery milepost. Deliver, collect payout, move on.

**2b. Opportunistic drop.** If 2a is not viable (no opponent stub, or fees exceed payout), find the nearest city that is already on the bot's network AND lies roughly in the direction of the capped destination. Issue a `DropLoad` at that city, then `DiscardHand` the demand card (or let the stuck-detector handle the discard). The turn's movement is still useful because the bot repositions toward something else.

**2c. Abandon the route.** If neither 2a nor 2b produces a positive turn, abandon the route explicitly (`routeAbandoned = true`) so the TripPlanner re-plans on the next turn against a different demand. This is the fallback of last resort — never the default behavior, because it costs the LLM call budget.

## Why not just audit the gridPoints.json data?

One hypothesis during debugging was that Cardiff was mis-classified as a small city (the game treats it with the 2-player cap, but in some editions Cardiff is a medium city). Fixing the data may or may not be correct depending on the canonical source — but even with correct data, the underlying problem persists. Any small city where 2 opponents arrive first, or any medium city where 3 opponents arrive first, creates the same trap. Data corrections reduce the frequency but do not solve the class of bug. JIRA-187 targets the class.

## Implementation surfaces (for the fix ticket, not this one)

- `ContextBuilder.ts` / demand scorer — add `cityEntryCapacityRemaining` to each demand's metadata.
- `TripPlanner.ts` — factor capacity remaining into `scoreDemand`.
- `TurnExecutorPlanner.ts` — add a capacity-cap pre-check when the next route stop is a delivery into a small/medium city. If capped, run the 2a/2b/2c decision tree before falling through to `executeBuildPhase`.
- `ActionResolver.resolveMove` — already handles opponent-track fees; verify it correctly computes fee cost for a round-trip path across an opponent's stub.
- Add a new turn-plan primitive for "pay fee and deliver" if the existing `MoveTrain + DeliverLoad` MultiAction doesn't cleanly cover the round-trip pattern.

## Open questions for review

1. **Threshold for the 2a vs 2b decision.** What's the right expected-net-profit floor for paying fees? $5M? 20% of payout? Configurable per skill level?
2. **How many turns should 2a span?** If the opponent's stub is 10 mileposts and the bot needs 2 turns of fee-paying ($8M) to reach the city, is that still preferred over 2b? Probably yes if payout > $20M. Needs a concrete decision rule.
3. **Does 2b require a cost-benefit check vs. 2c?** A drop at a nearby city salvages the turn's movement but loses the payout. Abandonment costs an LLM re-plan. In some states 2c may be cheaper long-term. Worth modeling.
4. **Interaction with JIRA-186 (`upgradeOnRoute` never consumed).** If the bot is movement-starved AND trapped outside a capped city, paying fees requires extra movement budget. Fast Freight (+3 mp) may be the enabling prerequisite. Fix JIRA-186 first.
5. **Interaction with JIRA-180 (the "not-implementing" ticket).** JIRA-180 assumed the bot always maintains one connected network. A capacity-capped delivery city is a case where the bot is explicitly NOT connected (and cannot become connected). This is an argument for revisiting JIRA-180's close-as-not-implementing decision if capacity-aware deliveries are going to rely on routing over opponent track into a cluster the bot can't build into.

## Success measure

- A replay of game `25d8059e-ea12-4d22-9e7d-b35a9844a7df` with this fix in place must NOT produce any 10+ turn PassTurn streak at Cardiff. Haiku should either (a) pay Flash's track fee and deliver, (b) drop at Birmingham and discard, or (c) abandon the route within 2 turns.
- In games where no bot runs into a capped-city problem, behavior must be byte-identical to today (no regression on unrelated paths).
- Demand scorer: in a test scenario where one demand has a capped delivery city and another has an open one with identical payout and distance, the open-destination demand ranks higher.

## Out of scope

- Building auto-discovery of which cities are small vs medium (the data exists in `configuration/gridPoints.json`).
- Data-level correctness of specific city classifications (that's a separate ticket).
- Track-usage fee schema changes — the $4M/turn/opponent rule is already implemented for movement; this ticket just leans on it.
- Trading or purchasing track between players (future ticket if the competitive dynamics warrant it).
