# JIRA-206 — Trip-planner committed the bot to a route it could not fund, while a fully achievable on-network alternative was visible to the LLM

A bot's trip-planner replan, run on the same turn as a $20M train upgrade, selected a route whose build estimate exceeded the bot's post-upgrade cash. The LLM's own reasoning explicitly named a better, on-network alternative, but that alternative did not appear in the planner's candidate set, and the fallback rule silently committed to the unaffordable route. The bot then ran out of cash mid-route and froze for the rest of the game.

## Game evidence — `d7c3fd78-fcf3-40d9-8d59-8bf95a2fa60e`

Player: **Nano** (`gpt-5.4-nano`).

### Turn 14 — pre-replan state

- Position: Cardiff (just delivered Cheese — the prior active route's deliver stop).
- Cash: **$32M**.
- Train: freight (9 speed, 2 cargo).
- Carried loads: none.
- Connected major cities: Paris, Holland.
- Hand: 9 demand cards including a freshly-drawn **Cheese: Holland → Cardiff (15M payout)**.

### Turn 15 — trip-planner replan + train upgrade in the same turn

The action recorded was `UpgradeTrain` (freight → fast_freight, –20M, cash $32M → $12M). The same turn, the LLM trip-planner ran with `trigger: no-active-route` (the prior route had completed) and produced this candidate set:

| llmIndex | Stops | Build estimate | Net value | Estimated turns | Score |
|---|---|---|---|---|---|
| 0 | pickup Oil@Newcastle → deliver Oil@Zurich | **24M** | +1M | 10 | 0.04 |
| 1 | pickup Steel@Birmingham → deliver Steel@Berlin | 29M | –21M | 8 | –1.35 |

`chosenByLlm: 0`. `fallbackReason: chosen_not_in_validated`. `chosen: 0`. The selected route became Nano's new `activeRoute` for subsequent turns.

The LLM's own reasoning, captured in `tripPlanning.llmReasoning`:

> "Oil Newcastle → Zurich has near-neutral efficiency (0.1M/turn), but it still requires off-network pickup/build (Newcastle/Zurich not on your network). Given you can already profit immediately via ON-NETWORK Cheese → Cardiff, this is slower and less cash-efficient for this turn."

The Cheese: Holland → Cardiff demand sat in Nano's hand at this exact moment with `trackCostToSupply: 0`, `trackCostToDelivery: 0`, `payout: 15M`. Holland and Cardiff were already on Nano's track and the English Channel ferry had already been built. Nano had cargo space (0 of 2 used) and could move on its own track for free. The route from Cardiff back through the bot's network to Holland and across the ferry would have been fundable from $12M post-upgrade cash without spending a single new ECU on track.

Despite naming Cheese → Cardiff in the reasoning, the trip-planner did not include it as a candidate. The candidate list contained only Oil and Steel — both with build estimates ($24M and $29M) larger than the bot's post-upgrade cash ($12M).

### Turns 16–20 — the unfundable route plays out

| Turn | Action | Cash | Notes |
|---|---|---|---|
| 16 | BuildTrack | $12M → $1M | 11M of track toward Newcastle |
| 17 | BuildTrack + PickupLoad | $1M → $0M | Final 1M segment, picked up Oil at Newcastle |
| 18 | MoveTrain | $0M | Moved south on existing track |
| 19 | MoveTrain | $0M | |
| 20 | MoveTrain | $0M | Train at (30,34); 14M of track still required to reach Zurich |

### Turns 21+ — the lockup (separately tracked as JIRA-204)

From T21 onward Nano emits `PassTurn` indefinitely at $0 cash, mid-route, carrying Oil, with the achievable Cheese: Holland → Cardiff demand still untouched in hand. The lockup itself is documented in JIRA-204; this ticket covers the upstream decision that put the bot in that position.

## Why it matters

The trip-planner's job at T15 was to choose the best route the bot could afford given its current cash and pending upgrade. Three things failed simultaneously:

1. The candidate set was incomplete — the bot's best option by every metric (zero build cost, on-network endpoints, immediate payout) wasn't on the slate.
2. The LLM noticed the gap and called it out in plain English, but the trip-planner had no way to act on that text.
3. The chosen-not-in-validated fallback locked in candidate 0 without checking whether candidate 0 was even fundable from the post-upgrade cash position.

Per the project's North Star, every wasted turn after the bot ran out of cash is a turn an opponent uses to pull ahead. This single replan committed Nano to losing the rest of the game starting on T15.
