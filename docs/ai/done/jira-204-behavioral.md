# JIRA-204 — Bot stays married to an unfundable active route while a fully achievable alternative demand sits in the same hand

A bot at $0 cash, mid-route, with sufficient cargo space and at least one demand card whose supply, delivery, and full traversal path are already on its own track, emits `PassTurn` indefinitely. The bot does not abandon the route, does not pursue the achievable alternative, and does not discard. It freezes for the rest of the game.

## Game evidence — `d7c3fd78-fcf3-40d9-8d59-8bf95a2fa60e`

Player: **Nano** (gpt-5.4-nano).

Active route at the moment of lockup (set on T17, unchanged through T50, game still in progress):
1. pickup Oil @ Newcastle *(completed on T17 — Oil is in carry from T17 onward)*
2. **deliver Oil @ Zurich** ← `currentStopIndex = 1`

Connected major cities at the time of lockup: `[Paris, Holland]`. Carried loads: `[Oil]` (1 of 2 capacity used — room for 1 more).

| Turn | Position | Cash | Action | Notes |
|---|---|---|---|---|
| 17 | (13,30) | $0 | BuildTrack | Picked up Oil; started moving south toward Zurich |
| 18 | (19,34) | $0 | MoveTrain | |
| 19 | (25,34) | $0 | MoveTrain | |
| 20 | (30,34) | $0 | MoveTrain | Network ends here; Zurich still off-network |
| 21–50 | (30,34) | $0 | **PassTurn** × 30 | identical state every turn |

The active route's current stop, **deliver Oil@Zurich**, requires 14M of new track to reach Zurich (per the engine's own demand ranking, `trackCostToDelivery: 14`). Nano has $0 cash and zero way to fund any build, so the active route is permanently un-completable from this state.

## A demand in the same hand is fully achievable

Nano holds 9 demand cards. The engine's demand ranking on T21+ shows one of them — **Cheese: Holland → Cardiff (15M payout)** — with both endpoints already on the bot's track:

- `trackCostToSupply: 0` (Holland is connected)
- `trackCostToDelivery: 0` (Cardiff is connected via the already-paid English Channel ferry)
- `ferryRequired: true` — the ferry segment is built; using it is free (no ECU cost to traverse)
- `estimatedTurns: 5`

Cargo space is available (1 of 2 used; Cheese can be picked up alongside the Oil currently on board). Movement on Nano's own track costs $0/turn. The route Holland → ferry → Cardiff is entirely on Nano's network. The 15M payout would unfreeze the bot.

The bot does not pursue this. It stays parked on T21–T50 with `activeRoute.currentStopIndex = 1` (deliver Oil@Zurich) and emits PassTurn each turn.

## What the existing recovery mechanisms do

- **Broke-and-stuck guardrail**: doesn't fire — its `hasAchievableDemand` predicate correctly returns `true` because Cheese qualifies. Discarding the hand would throw away the very card that could rescue the bot, so the guardrail is right not to discard.
- **Route abandonment**: never triggers. Nothing in the per-turn flow detects "active route's next stop is unachievable given current cash" and clears the route.
- **No-active-route replan path**: never reached, because the active route is never cleared.

So the bot is stuck in a state where one of the recovery paths (DiscardHand) would be wrong, and the other (route abandonment + replan, which would surface Cheese) is never invoked.

## Why it matters

Nano is functionally out of the game from T21. By T50 it has lost 30 turns of compounding income velocity while a 15M-payout, fully-on-network demand sits in its hand untouched. The bot is not actually stuck — it has a path forward — but the executor refuses to release the route that's blocking it. Per the project's North Star, every wasted turn is a turn an opponent uses to pull ahead; here we are wasting them while the means of escape is visible to the engine itself.
