# JIRA-163: Game 4e7f3385 Bug List

## Game Summary

| | Haiku | Nano |
|---|---|---|
| Turns | 367 | 366 |
| Deliveries | 8 (154M) | 7 (124M) |
| Final cash | 68M | 44M |
| Connected major cities | 4 (Paris, Ruhr, Berlin, London) | 3 (Milano, Ruhr, Wien) |
| Train upgrades | None | None |
| Movement efficiency | 22.9% | 55.9% |
| PassTurn streak | 157 turns (T12-T168) | 155 turns (T12-T166) |
| Oscillation streak | 154 turns (T215-T368) | 166 turns (T202-T367) |

---

## Bug 1: "OnTrain" treated as a city in route stops (CRITICAL)

**Both bots** enter permanent oscillation because a route stop has `city: "OnTrain"` — a sentinel value meaning the load is already being carried — but the route executor treats it as a literal city name to navigate to.

**Evidence:**
- Haiku T214: delivers Bauxite at London, then the trip planner creates route `[{pickup Bauxite at "OnTrain"}, {deliver Bauxite at "Holland"}]`
- Nano T201: delivers Coal at Roma, then route becomes `[{pickup Labor at "OnTrain"}, {deliver Labor at "München"}]`
- `resolveBuildTarget()` sees "OnTrain" as an off-network city, so build target is set to "OnTrain" — which doesn't exist on the map
- The route executor can't pathfind to "OnTrain", so the bot oscillates forever
- Haiku oscillates Berlin↔Szczecin for 154 turns (T215-T368) with $68M cash
- Nano oscillates Milano↔(42,51) for 166 turns (T202-T367) with $44M cash

**Root cause:** The trip planner generates a "pickup" stop for a load already on the train, using "OnTrain" as the supply city. The route executor and build target resolver don't handle this sentinel value. The pickup stop should be skipped (the load is already carried) or "OnTrain" should be filtered out during route creation.

---

## Bug 2: Route executor doesn't use remaining movement toward frontier (HIGH)

When the next stop isn't on the network (`stop_city_not_on_network`), the route executor stops moving entirely instead of continuing along owned track toward the destination.

**Evidence — Haiku T4:**
- Bot at Berlin (23,52), moves 2 hops to Szczecin (21,53) for Potatoes pickup
- Returns 2 hops to Berlin (23,52) — 4/9 movement used
- Has 13+ segments of own track extending westward from Berlin toward Antwerpen
- Route executor terminates because Antwerpen isn't on the network
- 5 movement points wasted — bot should have continued west along its own track

**Impact:** This wastes movement on every turn where the bot needs to reach an off-network city. In this game, Haiku had 154 of 189 move turns with wasted movement (avg 5.6 wasted/turn).

---

## Bug 3: 157-turn PassTurn death spiral from $0 cash (HIGH)

After T11, Haiku has $0 cash and enters a PassTurn loop for 157 consecutive turns (T12-T168). The composition is `undefined` — the turn pipeline appears to not execute at all.

**Evidence:**
- T11: Haiku builds 4 segments for 4M, ending at $0. Route: Wroclaw→Hamburg→Antwerpen→Bern
- T12-T168: All PassTurn with `cash: undefined`, `composition: undefined`, `route: undefined`
- Haiku has Copper loaded (from Wroclaw pickup) and should be able to deliver
- No discard, no replanning, no recovery attempt for 157 turns
- Same pattern for Nano: T12-T166 all PassTurn with undefined state

**Root cause:** When a bot reaches $0 cash, the turn pipeline produces no plans. The bot can't build (no money) and apparently can't move either. The bot should still be able to move its train on its own track at no cost and deliver loads for income. The $0 cash state should not prevent movement on owned track.

---

## Bug 4: Build advisor routes track through unnecessary major city (London) (MEDIUM)

On T4, the build advisor sent Haiku's track toward Antwerpen through London's mileposts, accidentally connecting London as a major city. London has no relevance to Haiku's route (Szczecin→Antwerpen).

**Evidence:**
- T4: Build advisor waypoints `[[21,32],[20,32],[19,32],[18,32],[17,32],[16,32]]` — going northwestward from Szczecin through London area
- By T5: London appears as connected major city
- Haiku's route is Szczecin→Antwerpen — London is not needed
- A more direct westward route along row 23-24 would have been shorter and cheaper

**Impact:** Wastes track budget connecting an irrelevant city. Haiku ends the game with 4 connected major cities (Paris, Ruhr, Berlin, London) but London was accidental and provided no strategic value.

---

## Bug 5: JIT build gate defers too early — doesn't respect "≤2 turns of track" threshold correctly (MEDIUM)

The user reports haiku builds around London too soon instead of waiting until ≤2 turns of track remain. With the JIRA-162 fix applied, `calculateTrackRunway` now measures directional runway. However, the issue here is that the build advisor builds in the wrong direction (through London) rather than the JIT gate deferring incorrectly. The JIT gate correctly allowed building on T4 (Antwerpen was off-network, cash was 28M) — the problem was the build advisor's waypoint selection, not the gate timing.

---

## Bug 6: No train upgrades despite ample cash (LOW)

Neither bot upgrades from Freight (9 speed, 2 capacity) despite having sufficient cash at various points:
- Haiku had 68M for 154 turns (T215-T368) — could have upgraded twice
- Nano had 44M for 166 turns (T202-T367)

**Root cause:** The upgrade check is inside the build phase (`upgradeConsidered: false` on every turn). When the build target is "OnTrain" or the build otherwise fails, upgrade consideration is skipped. The upgrade path should be independent of the build target resolution.

---

## Bug 7: No hand discard or route replanning after extended stall (LOW)

- Haiku holds stale demand cards for up to 211 turns (card#130)
- Nano discards 3 times (T176-T178) but only after 155 turns of PassTurn
- Neither bot has a circuit breaker that triggers hand discard or route replanning after N unproductive turns

---

## Priority Order

1. **Bug 1 (OnTrain as city)** — CRITICAL — causes permanent oscillation for both bots, game-ending
2. **Bug 3 ($0 PassTurn spiral)** — HIGH — 157 turns of dead game, no recovery mechanism
3. **Bug 2 (wasted movement)** — HIGH — consistent movement waste every turn
4. **Bug 4 (London waypoints)** — MEDIUM — build advisor spatial reasoning
5. **Bug 5 (JIT gate timing)** — MEDIUM — clarification, not a code bug with JIRA-162 applied
6. **Bug 6 (no upgrades)** — LOW — upgrade consideration gated behind build phase
7. **Bug 7 (no stall detection)** — LOW — missing guardrail, same class as JIRA-162 secondary bugs
