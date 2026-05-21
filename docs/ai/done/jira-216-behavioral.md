# JIRA-216 — In-transit opportunistic pickups: bot ignores load chips at supply cities it passes straight through during movement

## Game evidence

- Game: `c2a4df33-0ed9-4abf-adfa-213869ea0b89`, Flash (the winning bot), turn 88
- Log: `logs/game-c2a4df33-0ed9-4abf-adfa-213869ea0b89.ndjson`
- Game outcome: Flash declared victory at turn 105 (264M cash, 7 cities). Haiku and Nano finished at 233M / 4 cities and 206M / 4 cities respectively. Game ran ~17 turns longer than a competent human run (~60 turns).

### The smoking-gun turn (Flash, turn 88)

```
position:        passing through Ruhr (movementPath dist 0 to Ruhr milepost)
trainCapacity:   3 (Superfreight)
carriedLoads:    ["Beer"]                  → 2 free slots
demand cards:    Tourists @ Ruhr → Madrid    (35M)
                 Tourists @ Ruhr → Valencia  (35M)
                 ... 7 others
activeRoute:     pickup Cheese@Holland → pickup Copper@Wroclaw
                 → pickup Oil@Beograd → deliver Oil@Munchen
                 → deliver Cheese@Napoli → deliver Copper@Hamburg
reasoning:       "[route-executor] stop 0/5, phase=build"
```

The bot's movement path went straight through Ruhr's milepost. Two demand cards in hand had `supplyCity = Ruhr`. The Tourists chip was available at Ruhr. The Superfreight had two free slots. **Per game rules, picking up a load costs zero movement** — there is no trade-off, no opportunity cost, no risk. Flash skipped both 35M opportunities and continued to Holland for a Cheese pickup it had planned earlier.

### This is a structural pattern, not a one-off

A scan of Flash's full game (105 turns) for *(turn ∈ Flash, free cargo slot, movementPath within 2 mileposts of a held demand card's supplyCity, load available, not already on route)* yields **36 missed opportunities**. The Ruhr/Tourists miss alone repeats on turns **78, 83, 84, 88, 89** — five separate passes through the same supply city carrying the same card. The chip was sitting on the table, the card was in the hand, the bot walked past five times.

### Cargo slot utilization data

This pattern shows up clearly in slot-utilization stats from the same log:

| Bot       | Train         | Turns on Superfreight | Carrying 0 | 1 | 2 | **3 (full)** | Slot util |
|-----------|---------------|-----------------------|------------|---|---|--------------|-----------|
| Flash     | Superfreight  | 74                    | 7          | 28 | 34 | **5**       | 50%       |
| Nano      | Superfreight  | 79                    | 20         | 53 | 6  | **0**       | 27%       |
| Haiku     | Superfreight  | 52                    | 17         | 34 | 1  | **0**       | 23%       |

**Haiku and Nano never used all three slots once.** Each spent 20M to upgrade and then ran the train like a Fast Freight. Flash hit 3/3 exactly five times, and all five were in a single end-game scramble (turns 92–96). The dominant operating mode for every bot is "carrying 1 load, two slots empty."

A bot that cannot fill its train cannot achieve human-level income velocity, no matter how good its routing or build planning is.

## Current behavior

`MovementPhasePlanner` Phase A's stop loop (`src/server/services/ai/MovementPhasePlanner.ts:122`) is structured around the *currentStop* — the next planned action in `activeRoute.stops`. For each iteration it asks one question: *am I at the current stop's city?* If yes, execute the stop action; if no, move toward it. When moving, it calls `ActionResolver.resolveMove({ to: targetCity }, ...)` (`MovementPhasePlanner.ts:322`), which returns a single `MoveTrain` plan with a `path` array of mileposts. That plan is pushed verbatim. The bot's movement deducts mileposts; the loop iterates again.

At no point does any code inspect the *intermediate* mileposts of `path`. The pickup logic in the post-action branches (lines 156–175) and the JIRA-214 P2 advisor hook (`maybeFireAdvisor`, line 173) both fire only when the bot's *currentStop city* matches its position. They never see the cities the bot passes through on the way.

This is why the Ruhr/Tourists miss repeats: every turn 78–89 Flash had Ruhr as an intermediate milepost, but Ruhr was never the `currentStop.city`. The advisor wasn't blind — it was never invoked.

The deterministic-pickup gap is independent of the JIRA-214 post-pickup advisor. JIRA-214 handles "while you're stopped at a city, are there other loads here?" and is the right answer to that question. The unaddressed case is "while you're walking through a city without stopping, are there free loads here that match cards in your hand?" — and unlike the post-pickup case, it requires no judgment call: free movement + free EV = always pick up.

## Desired behavior

When the bot's movement path traverses an intermediate milepost that is a supply city for an unfulfilled demand card the bot holds, AND the corresponding load chip is available at that city, AND the bot has at least one free cargo slot, the bot picks the load up while passing through. The pickup costs no movement (game rule). No LLM call. No deferral.

If a future stop in the active route plans to come back to the same city for the same `(loadType, deliveryCity)` pickup, that future stop is removed (the pickup happened early). The deliver leg for that demand card remains in the route — or is added to the route — exactly as it would be after a planned pickup.

If the path crosses multiple eligible supply cities, pickups occur in path order until cargo capacity is full.

Player-visible result: the Tourists chip at Ruhr would have been on Flash's train on the very first pass-through (turn 78). The deliver leg to Madrid (1 of the 7 cards) would have entered the route on the next replan. In the Ruhr case, that's a 35M payout claimed for zero marginal movement cost and a deliver-leg detour quantified by JIRA-214's existing `RouteDetourEstimator` if it's worth taking now or merging into a later trip.

## Player-visible impact

The impact compounds across the game because the Superfreight upgrade is what unlocks 3-slot mode, and currently no bot meaningfully uses the third slot. Closing the slot-utilization gap from ~50% (winner) to ~80% — a realistic ceiling, since not every milepost will pass a supply city — is roughly equivalent to upgrading each delivery cycle from 1.5 loads to 2.4 loads. That's a ~60% increase in deliveries per movement turn.

In Flash's specific game, a credible run of those 36 missed pickups (assume ~1/3 are actually capturable with deliver legs that fit cleanly) yields roughly 10–15 extra deliveries at ~20M average payout. That's 200–300M extra cash. Even discounting heavily for the deliver legs needing extra movement turns, the bot reaches the 250M cash threshold and the 7-city threshold meaningfully sooner — credible target compression of **8–12 turns on the winning bot** (105 → ~93–97), and even larger gains on Haiku and Nano (who currently never use the third slot at all).

The fix also produces a secondary income-velocity benefit independent of cargo: the deliver-leg replanning that happens after each opportunistic pickup feeds existing JIRA-214 logic with richer route material, allowing the post-pickup advisor to find cleaner double-deliver patterns.

## Out of scope

- **Adding the matching DELIVER stop to the route at pickup time.** The pickup itself is the value-positive action; route-replan is downstream. This JIRA leaves the deliver-leg insertion to the existing post-pickup advisor (JIRA-214), `PostDeliveryReplanner`, or the next `NewRoutePlanner` turn. We pick up first, plan the deliver second.
- **Speculative pickup of loads with no matching demand card.** Game rules permit picking up any load, but the value is unclear without a card. Skipped here to keep the trigger deterministic.
- **Path re-routing to deliberately pass through additional supply cities.** That's detour optimization (JIRA-214's territory). This JIRA only opportunistically captures cities the existing path already traverses.
- **Pickups during the build phase (Phase B / Phase C).** Build phase doesn't move the train, so no pass-through happens.
- **Loads dropped at a city via the field-warehousing variant.** That variant isn't enabled in this implementation.
- **Multi-load pickups at the same milepost across multiple matching cards** — handled implicitly by the loop (path-order until capacity fills), no special prioritization in v1.
- **Coordinating with same-turn delivery executions to avoid double-using slot capacity** — the in-line load count update in the implementation handles the trivial case; complex interleavings are deferred.
