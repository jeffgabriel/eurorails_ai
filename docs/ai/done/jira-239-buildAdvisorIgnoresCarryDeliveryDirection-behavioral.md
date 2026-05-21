# JIRA-239 — BuildAdvisor selected victory-network build targets that pulled the bot far from its pending carry delivery, costing ~3 wasted turns in the endgame (behavioral)

In game `a864f7e1-9d83-43e5-845a-e3507cceba4a`, bot s2 had just delivered Coal at Napoli and was holding a Wine card payable at Roma (22M, 3 hex north-west of Napoli — a 1-turn delivery at fast_freight speed 12). Instead of delivering Wine next, the BuildAdvisor selected a sequence of victory-network build targets — Milano, London, Paris, Roma, Wien — for four consecutive turns (t67–t70), all far from Roma. The route-executor followed the build targets, sending the bot north past Roma (t68→row 40), further north (t69→row 32), then back south (t70→row 44), finally delivering Wine at Roma at t71. The active route throughout said `Route: deliver(Wine@Roma)`; the BuildAdvisor's target selection ignored it.

## Source

`logs/game-a864f7e1-9d83-43e5-845a-e3507cceba4a.ndjson` — bot s2, t65 (Coal delivered at Napoli) through t71 (Wine finally delivered at Roma). Discovered 2026-05-13.

## Observed trace

Bot positions, carry, active-route target, and BuildAdvisor's `composition.build.target` per turn:

| Turn | posStart → posEnd | carry | active route | build target | cities |
|------|-------------------|-------|--------------|--------------|--------|
| t65 | (45,39) → (47,36) | [Coal,Wine] | deliver Coal @ Napoli | — | 3 |
| t66 | (47,36) → (51,44) | [Coal,Wine] | deliver Coal @ Napoli | — | 3 |
| t67 | (51,44) → (51,44) (delivered Coal) | [Wine] | deliver Wine @ Roma | **Milano** | 3 |
| t68 | (51,44) → **(40,40) north** | [Wine] | deliver Wine @ Roma | **London** | 4 (+Milano) |
| t69 | (40,40) → **(32,40) further north** | [Wine] | deliver Wine @ Roma | **Paris** | 5 (+London) |
| t70 | (32,40) → **(44,41) back south** | [Wine] | deliver Wine @ Roma | **Roma** | 6 (+Paris) |
| t71 | (44,41) → (53,45) (delivered Wine) | None | (post-delivery replan) | **Wien** | 6 |

The bot's `connectedMajorCities` count progressed 3 → 4 → 5 → 6 → 7 (Wien added at t72) — racing the victory network in parallel with the pending Wine delivery, except the build targets sent the bot in the OPPOSITE direction of the delivery destination.

## Geometry

- Napoli ≈ (51,44). Roma ≈ (50,43) — ~3 hex from Napoli.
- At t67, Roma was a 1-turn move from the bot's position. Wine (22M) was deliverable on turn 67 itself or t68 at the latest.
- BuildAdvisor's chosen sequence (Milano (~40,40), London (~17,33), Paris (~33,36), Roma) sent the bot through (40,40)→(32,40)→(44,41)→(53,45) — total round-trip distance ~40+ hex of movement that did not need to happen on the way to Roma.

## What composition.build shows

For each of t67–t70, `composition.build.target` was a NORTHERN city. The bot's movement direction tracked the build target. The active-route delivery destination (Roma, south) had no influence on movement until t70 when the BuildAdvisor finally selected Roma itself as the build target.

```
t67: build.target=Milano,  active=deliver Wine @ Roma   → bot moves north
t68: build.target=London,  active=deliver Wine @ Roma   → bot moves north
t69: build.target=Paris,   active=deliver Wine @ Roma   → bot moves north (overshoots Milano)
t70: build.target=Roma,    active=deliver Wine @ Roma   → bot moves south (back toward Roma)
t71: (delivers Wine), build.target=Wien                 → post-delivery replan
```

## Cost of the defect

At least **2 full turns wasted** on the round-trip north-south detour relative to the optimal "deliver Wine first, then start victory build" sequence. In the endgame with 200M+ cash and 6+ connected cities, every wasted turn is a real loss-of-margin against the 250M+7-cities victory threshold.

## What was expected

For a bot carrying a near-by deliverable load (1-2 turn delivery, high payout), deliver it before pivoting to longer-haul victory builds. The BuildAdvisor should either:
- Defer build-target selection until after the carry delivery, OR
- Select build targets that align with the bot's required path to the delivery destination, OR
- Be aware that the active route's delivery target is closer than the candidate build targets, and prefer "deliver-then-build" sequencing in such cases.

## What actually happened

BuildAdvisor selected build targets purely on victory-network expansion criteria without considering the pending carry delivery. The route-executor's movement followed the build target, pulling the bot away from Roma for three consecutive turns before the BuildAdvisor finally targeted Roma at t70.

## Investigation findings

1. **Wrong module — the defect is NOT in `BuildAdvisor.ts`.** `BuildAdvisor.advise()` is an LLM waypoint picker (disabled by default; `ENABLE_BUILD_ADVISOR=false`). Build-target SELECTION lives in `routeHelpers.resolveBuildTarget()` at `src/server/services/ai/routeHelpers.ts:68-106`. The function receives both `route` and `context` — the victory-build branch chooses to ignore the route.
2. **Trigger: `cash >= 230M AND connectedMajorCities < 7`** at `routeHelpers.ts:73-75`. Re-evaluated every turn. Active at t67/t68/t69/t71 for s2; inactive at t70/t72.
3. **The trip planner already had the right plan.** At t67 the active route was `[{deliver, Wine, Roma}]` — single stop. `resolveBuildTarget`'s victory override (line 78) bypassed the route's stop list and called `findCheapestUnconnectedMajorCity` instead.

See the companion technical doc for the fix shape.

## Acceptance

- A unit test reconstructing s2's t67 snapshot (bot at Napoli with Wine carried for Roma, 3 cities connected, 216M cash, 9 demand cards including a Marble Firenze→Birmingham pair) and running the BuildAdvisor:
  - Either selects a build target compatible with the bot's path to Roma (i.e., somewhere along the Napoli→Roma corridor or Roma itself), OR
  - Defers/suppresses the build action in favor of completing the Wine delivery first, OR
  - Returns an explicit reasoning string indicating the delivery-vs-build trade-off was considered and victory-network expansion was chosen for stated reasons.
- An end-to-end regression test runs the same snapshot through several turns and asserts that Wine reaches Roma within 2 turns of t67 (not 4 as in the observed game).

## Not in scope

- Generalizing this defect to other carry+build scenarios — current scope is the single observation in game `a864f7e1` t67-t71.
- Tuning the victory-network expansion priority weights — that's a separate scoring concern.
- The secondary Firenze-connector defect at t71-t72 (JIRA-240).
- LLM-path build-target selection — does not exist today; would be new infrastructure. The `actor: 'llm'` label in `actionBreakdown` with empty `llmCallIds: []` is benign legacy telemetry, not an indication of an actual LLM call.
