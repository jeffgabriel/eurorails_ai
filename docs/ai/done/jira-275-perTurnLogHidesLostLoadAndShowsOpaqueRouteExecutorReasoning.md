# JIRA-275 — Per-turn log hides which load was lost when an event card fires its load_lost effect, and the strategy reasoning shows opaque executor metadata instead of the actual route plan

Two related visibility gaps in `game-<gameId>.ndjson` make it hard to understand at-a-glance what happened on a turn — especially when an event card fires or when the bot is mid-route. Both are observed in real games (Derailment #125 in game 7e18a791 T11; the route-executor reasoning string in every bot turn).

## Source

- **Event card load-loss visibility**: `logs/events-7e18a791-21de-456a-881d-5b1ec13b6007.ndjson` shows `cardId: 125, restrictionTypes: ['load_lost', 'turn_lost']`. The corresponding `logs/game-7e18a791-21de-456a-881d-5b1ec13b6007.ndjson` T11 entry shows `activeEffects: [{ cardId: 125, restrictions: { build: [], movement: [], pickupDelivery: [] } }]` — all three buckets empty, no `load_lost` field visible. The actual load lost (Sheep, diffed between T10 end `[Imports, Sheep]` and T11 start `[Imports]`) is nowhere recorded on T11.
- **Opaque executor reasoning**: every mid-route turn in `game-*.ndjson` has `reasoning: "[route-executor] stop X/N, phase=build"` (or `phase=travel`) with no indication of what the actual route is. The route is in a separate `activeRoute.stops` field, requiring the reader to cross-reference.

## What's wrong

**A. `activeEffects.restrictions` model misses `load_lost` / `turn_lost`.** The per-turn `activeEffects[*].restrictions` object only enumerates three restriction buckets (`build`, `movement`, `pickupDelivery`). Derailment's actual effects — load loss and turn loss — exist in the parallel `events-*.ndjson` file as `restrictionTypes: ['load_lost', 'turn_lost']` but never reach the per-turn log. A reader scanning game-*.ndjson alone sees a Derailment card with empty restriction arrays and reasonably concludes the card had no effect.

**B. No record of which load was lost on the turn it was lost.** Today the only way to identify the lost load is to diff `carriedLoads` between consecutive turn entries. There's no `loadsLost: [{loadType, city}]` field, no annotation on the turn that ate the loss.

**C. Route-executor reasoning surfaces internal metadata instead of the plan.** `"[route-executor] stop 0/1, phase=build"` is true but useless. The reader has to scroll to `activeRoute.stops` and mentally render the sequence. The reasoning should render the route inline, with the current stop highlighted — same information, no cross-referencing.

## What should happen

**A.** Per-turn `activeEffects` for each card should surface all of its restriction types in a form a reader can interpret without consulting separate docs or files. If a Derailment fires `load_lost + turn_lost`, that should be visible on the per-turn entry — not just in the events file.

**B.** When a load is lost on a turn (event card, drop action, anything), the per-turn log should record the specific `{loadType, city}` of the lost load on the turn it was lost, parallel to the existing `loadsDelivered` and `loadsPickedUp` fields.

**C.** Route-executor (and any other mid-route reasoning) should replace `"[route-executor] stop X/N, phase=build"` with an inline rendering of the route plan, current stop marked. Suggested shape:

```
Route: ▶ PICKUP Marble @ Firenze → • PICKUP Marble @ Firenze → • DELIVER Marble @ Ruhr → • DELIVER Marble @ Holland
```

(▶ = current stop, • = future stops, optionally ✓ for completed earlier stops.) The route is rendered once per turn in the reasoning field, so any reader scanning the NDJSON sees the bot's full plan immediately.

## Scope

Three observability changes to the per-turn `game-*.ndjson` writer and the route-executor reasoning string. No game-mechanics changes. No changes to the events file (the underlying data is already there — this ticket surfaces it).
