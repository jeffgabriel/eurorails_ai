# JIRA-240 — BuildAdvisor used full t71 budget on a victory build target and left a ~3M pickup-city connector un-built, costing 1 wasted turn at Firenze (behavioral)

In game `a864f7e1-9d83-43e5-845a-e3507cceba4a`, bot s2 at t71 had 226M cash, the 20M per-turn build budget, and two distinct needs: (a) extend its network to Wien for the 7-city victory connection, and (b) build a ~3M single-segment connector to Firenze so the next route's Marble pickup could happen. The BuildAdvisor selected Wien as the build target and spent the majority of the 20M budget there, leaving the Firenze connector un-built. At t72 the bot moved only 6 hex (not its full 12), stopped adjacent to Firenze (48,43) without picking up Marble, and used a separate small ~3M build to lay the missing Firenze segment. At t73 the bot finally entered Firenze, picked up Marble, and continued north. The Firenze connector and the Wien extension could have been done in a single t71 turn within the 20M budget.

## Source

`logs/game-a864f7e1-9d83-43e5-845a-e3507cceba4a.ndjson` — bot s2, t71 (Wine delivered at Roma, Wien build, post-delivery replan picks Marble Firenze→Birmingham) through t73 (Marble picked up at Firenze). Discovered 2026-05-13.

## Observed trace

| Turn | posStart → posEnd | move hex | carry | active route | build target | connectedMajorCities |
|------|-------------------|----------|-------|--------------|--------------|---------------------|
| t71 | (44,41) → (53,45) | 13 | None (Wine delivered at Roma) | pickup Marble @ Firenze | **Wien** | 6 (Paris, Holland, Milano, Ruhr, Berlin, London) |
| t72 | (53,45) → (48,43) | **6** | None | pickup Marble @ Firenze | **Firenze** | 7 (+Wien) |
| t73 | (48,43) → (39,39) | 13 | [Marble] | deliver Marble @ Birmingham | (skipped) | 7 |

At t72, with a full 12-hex movement budget on fast_freight, the bot moved only 6 hex. The reduced movement means the bot stopped mid-route — almost certainly because the route-executor reached the end of buildable track (network ran out before Firenze) and had to lay new track. `composition.build.target = Firenze` at t72 confirms a build action was emitted at Firenze. `composition.pickups = []` at t72 confirms the Marble pickup did NOT happen on t72 even though the bot was at (48,43), ~1 hex from Firenze. The pickup happened at t73 after the t72 build segment connected the bot's network into Firenze.

## Budget arithmetic

Cash trajectory across t71-t72:

```
t70 → t71: 218 → 226   (+8 net: +22 Wine delivery − 14 build spend on Wien direction)
t71 → t72: 226 → 223   (−3:  build spend on the Firenze connector)
```

Total build spend across t71+t72 ≈ 17M. The 20M per-turn budget at t71 ALONE would have covered both the Wien extension (~14M) AND the Firenze connector (~3M) within a single turn.

## What composition.build shows

```
t71: build.target=Wien    (planHorizon: Route: deliver(Wine@Roma) — but Wine delivered THIS turn; post-delivery replan picks Firenze→Birmingham; BuildAdvisor target = Wien for victory)
t72: build.target=Firenze (planHorizon: Route: pickup(Marble@Firenze) → deliver(Marble@Birmingham) — BuildAdvisor target = Firenze to fix the connector gap)
```

`pickups: []` at t72 confirms the bot was at/adjacent to Firenze but the city was NOT on its network — Firenze isn't in `connectedMajorCities` at t72.

## Cost of the defect

**1 full turn wasted** — t72 stopped 6 hex short of its movement budget and built a separate connector that should have been bundled into t71. The bot could have:
- Done both builds at t71 (Wien + Firenze connector), then at t72 moved full 12 hex into Firenze, picked up Marble, and continued north — saving the t72 connector turn entirely.

## What was expected

When the post-delivery replan produces a next-route whose pickup city is close to (but not on) the bot's network, AND budget remains after the planned victory build, the BuildAdvisor should bundle the pickup-city connector into the same turn's build action. The two builds can share the 20M budget when their combined cost fits.

Concretely at t71: Wien direction ~14M, Firenze connector ~3M. Combined 17M < 20M budget. Bundle.

## What actually happened

BuildAdvisor selected exactly ONE build target per turn (Wien at t71, Firenze at t72). No multi-target or bundled-build logic appears to be invoked. The BuildAdvisor sees t71's available budget but only spends it on the single chosen target.

## Investigation findings

1. **Wrong module — the defect is NOT in `BuildAdvisor.ts`.** Build-target selection lives in `routeHelpers.resolveBuildTarget()` at `src/server/services/ai/routeHelpers.ts:68-106`. The function returns a single `BuildTargetResult` (one `targetCity` field). The downstream `BuildPhasePlanner.executeBuild` consumes that single target.
2. **Single-target by design at the return-shape level.** Adding a secondary target requires extending `BuildTargetResult` and updating the build executor. The data needed for the secondary decision (next-route pickup) is already in `context` and `route`; the victory branch just doesn't look at it.
3. **Post-delivery replan runs BEFORE the victory branch.** By t71's build phase, the new route (Marble Firenze→Birmingham) is already in the active route's stops. `resolveBuildTarget` has full visibility but the victory branch ignores non-victory stops.

Priority question (Wien vs. Firenze if budget covered only one) is deferred — current fix scope is the "both fit in budget" case, which is unambiguous.

See the companion technical doc for the fix shape.

## Acceptance

- A unit test reconstructing s2's t71 post-Wine-delivery snapshot (bot at Roma area, 226M cash, 6 connected cities including planned Wien target, next route Marble Firenze→Birmingham with Firenze ~3M of new track from current network) and running the BuildAdvisor:
  - Either emits a combined Wien + Firenze-connector build action whose total cost fits the 20M budget, OR
  - Selects Firenze as the build target at t71 (deferring Wien to t72) on the grounds that Firenze unblocks the next route's pickup, OR
  - Returns explicit reasoning that the trade-off was considered and Wien-only was chosen for stated victory-progress reasons.
- An end-to-end regression test runs the same snapshot through t71-t73 and asserts that Marble is picked up at Firenze by t72 (not t73 as observed).

## Not in scope

- Generalizing this defect to other build-bundling scenarios — current scope is the single observation at t71 in game `a864f7e1`.
- The primary delivery-direction defect at t67-t70 (JIRA-239).
- LLM-path build-target selection — does not exist today; would be new infrastructure. The `actor: 'llm'` label in `actionBreakdown` with empty `llmCallIds: []` is benign legacy telemetry, not an LLM call.
