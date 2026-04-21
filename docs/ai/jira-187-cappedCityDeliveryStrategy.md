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

Fold expected track-usage fees directly into the demand's effective payout during scoring. No separate penalty, no capped/uncapped flag.

For each demand the scorer is evaluating:

1. Call the shared `computeTrackUsageFees(demand, snapshot)` function — the same function Layer 2 uses for its profitability algorithm. It returns the expected fees the bot would pay in opponent track-usage to reach the supply city, deliver to the destination, and (if the route continues) return to the bot's own network.
2. Compute `effectivePayout = payout - computedFees`.
3. Use `effectivePayout` (not `payout`) in every downstream scoring component — efficiency-per-turn, ROI, rank. Existing formulas stay unchanged; only their input changes.

`computeTrackUsageFees` returns zero transparently when:
- The delivery city is NOT capped (bot would build its own track as normal, no fees).
- The bot already has track touching the delivery milepost (self is counted; no opponent-track traversal needed).
- No opponent path connects the bot's reachable network to the delivery city (no viable opponent-track route; demand naturally scores worse because other components — estimatedTurns, trackCost — already dominate).

This means the scoring pipeline treats capped and uncapped deliveries with the same code path. A $38M payout that costs $4M in fees scores from `effectivePayout = $34M`. A $30M payout that would cost $40M in fees scores from `effectivePayout = -$10M` — naturally sinks to the bottom of the ranking without any special case. A $30M payout with no fees scores from `effectivePayout = $30M`, identical to today's behavior.

Pre-commit detection still prevents the bot from pursuing an unbuildable route, but it falls out of the math rather than from a separate gate: a fee-laden demand either clears the existing `> 3M/turn` income-velocity floor on its own merits, or it doesn't.

### Layer 2 — Post-commit strategy (`TurnExecutorPlanner` / guardrail)

Once the bot has an active route whose next stop's delivery city is capacity-capped, the bot must NOT keep proposing illegal builds. Each turn it should evaluate three alternatives in order:

**2a. Track-usage delivery.** Is there an opponent with owned track connecting the bot's network to the capped delivery city? If yes, and the total fee cost (flat $4M per opponent per turn of traversal) is less than the delivery payout minus a reasonable reserve, generate a `MoveTrain` plan that pays the fee and reaches the delivery milepost. Deliver, collect payout, move on.

**2b. Opportunistic drop.** If 2a is not viable (no opponent stub, or fees exceed payout), find the nearest city that is already on the bot's network AND lies roughly in the direction of the capped destination. Issue a `DropLoad` at that city, then `DiscardHand` the demand card (or let the stuck-detector handle the discard). The turn's movement is still useful because the bot repositions toward something else.

**2c. Abandon the route.** If neither 2a nor 2b produces a positive turn, abandon the route explicitly (`routeAbandoned = true`) so the TripPlanner re-plans on the next turn against a different demand. This is the fallback of last resort — never the default behavior, because it costs the LLM call budget.

## Discovery: when and how the bot notices

The capacity problem is detected during the **per-turn pre-flight check** inside `TurnExecutorPlanner`, before any build or move plan is generated. On every turn where the bot's active route has a pending delivery stop, the planner runs:

1. Look up the delivery city's `cityType` from `gridPoints.json` (small = cap 2, medium = cap 3).
2. Count how many distinct players (excluding this bot) already have at least one track segment touching any milepost of that city.
3. If `opponentCount >= cap AND bot has no track into that city` → **capped-city flag set**.

The check is cheap (one index lookup + a filter over the known track graph) and happens unconditionally each turn — not just when a build fails. This is intentional: a city that was open last turn may become capped this turn if an opponent finished building in, and the bot must adapt immediately rather than waiting to discover the block through a failed build attempt.

When the flag is set, the planner skips `executeBuildPhase` entirely and falls through to the 2a/2b/2c decision tree described above. The flag is **not persisted** between turns; the check is stateless and re-evaluated fresh each cycle.

## Profitability algorithm

Before choosing between 2a (pay fees) and 2b (opportunistic drop), the bot computes an **income-velocity estimate** for the fee-paying path and rejects it unless the result clears a minimum floor.

### Inputs

| Symbol | Meaning |
|--------|---------|
| `P` | Delivery payout (ECU M) |
| `F` | Total track-usage fee for the traversal path (ECU M) — flat $4M per opponent per turn of traversal, not per milepost |
| `T` | Estimated turns to complete the delivery via the opponent's track, including any return travel to resume the bot's own network |

### Formula

```
netProfit = P - F
incomeVelocity = netProfit / T          # ECU M / turn
```

The bot proceeds with the fee-paying path (2a) only if:

```
incomeVelocity >= 3   # ECU M / turn floor
```

The **3 M/turn floor** is the minimum acceptable income rate. Below it, the capital tied up in the traversal turns is better redeployed via 2b or 2c.

### Worked example — Cardiff (game `25d8059e`)

- **Payout:** $38M (`Labor → Cardiff`)
- **Opponent stub length:** 3 mileposts (Flash's track from the junction into Cardiff)
- **Fee:** $4M × 1 opponent × 1 traversal turn = **$4M**
- **Turns to complete:** 1 turn to reach Cardiff via Flash's track + 0 extra return turns (bot's own network is adjacent to the junction) = **T = 1**

```
netProfit       = 38 - 4  = 34 M
incomeVelocity  = 34 / 1  = 34 M/turn   ✓  (>> 3 M/turn floor)
```

Result: proceed with 2a (pay fee, deliver). The floor is cleared by a factor of 11×. In this case 2b would have been strictly worse — the bot collects $34M instead of $0.

If the stub were longer — say 10 mileposts requiring 2 traversal turns at $8M total fees:

```
netProfit       = 38 - 8  = 30 M
incomeVelocity  = 30 / 2  = 15 M/turn   ✓  (still >> 3 M/turn floor)
```

Still viable. The floor only triggers if payout is low (e.g. a $12M demand with a 3-turn, $12M fee path: `netProfit = 0`, `incomeVelocity = 0 < 3` → reject 2a, fall to 2b).

## Why this is a class bug, not a data bug

Cardiff is correctly classified as a small city in `gridPoints.json` (small-circle icon on the board; medium cities use square icons). The data is authoritative. The underlying problem persists regardless: any small city where 2 opponents arrive first, or any medium city where 3 opponents arrive first, creates the same trap. JIRA-187 targets that class of bug.

## Implementation surfaces (for the fix ticket, not this one)

- `TripPlanner.ts` / demand scorer — call `computeTrackUsageFees(demand, snapshot)` and subtract its return value from `payout` before running any downstream scoring formula. Do not branch on a capped/uncapped flag.
- `TurnExecutorPlanner.ts` — add a capacity-cap pre-check when the next route stop is a delivery into a small/medium city. If capped, run the 2a/2b/2c decision tree before falling through to `executeBuildPhase`.
- `ActionResolver.resolveMove` — already handles opponent-track fees; verify it correctly computes fee cost for a round-trip path across an opponent's stub.
- Add a new turn-plan primitive for "pay fee and deliver" if the existing `MoveTrain + DeliverLoad` MultiAction doesn't cleanly cover the round-trip pattern.

## Success measure

- A replay of game `25d8059e-ea12-4d22-9e7d-b35a9844a7df` with this fix in place must NOT produce any 10+ turn PassTurn streak at Cardiff. Haiku should either (a) pay Flash's track fee and deliver, (b) drop at Birmingham and discard, or (c) abandon the route within 2 turns.
- In games where no bot runs into a capped-city problem, behavior must be byte-identical to today (no regression on unrelated paths).
- Demand scorer: in a test scenario where one demand has a capped delivery city and another has an open one with identical payout and distance, the open-destination demand ranks higher.

## Out of scope

- Track-usage fee schema changes — the $4M/turn/opponent rule is already implemented for movement; this ticket just leans on it.
- Trading or purchasing track between players (future ticket if the competitive dynamics warrant it).
