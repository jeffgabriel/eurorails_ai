# JIRA-239 — Victory-build branch in `resolveBuildTarget` overrides route-based target without checking for nearby high-value carry delivery (technical)

Companion to `jira-239-buildAdvisorIgnoresCarryDeliveryDirection-behavioral.md`.

## Defect locus

`src/server/services/ai/routeHelpers.ts:68-106` — `resolveBuildTarget()`. This is the single source of truth for which city the bot extends track toward each turn (per its own header comment: "Unified build-target resolver — the single source of truth").

```ts
export function resolveBuildTarget(route, context): BuildTargetResult | null {
  const isVictoryEligible =
    context.money >= VICTORY_BUILD_TRIGGER_M &&        // 230M
    context.connectedMajorCities.length < VICTORY_CITY_COUNT;  // 7

  if (isVictoryEligible) {
    const victoryTarget = findCheapestUnconnectedMajorCity(context);
    if (victoryTarget) {
      return { targetCity: victoryTarget, stopIndex: -1, isVictoryBuild: true };
    }
  }

  return findRouteBasedTarget(route, context);
}
```

When `isVictoryEligible` is true, the function **bypasses the route-based target entirely** and picks `findCheapestUnconnectedMajorCity(context)` — which sorts purely by estimated track cost (line 116) and ignores:
- The active route's delivery destination
- Whether the bot is carrying a high-value load
- The relative distance from the bot's current position to delivery vs. victory candidates

For s2 t67-t69 this branch was hot (cash ≥230M, cities <7), and produced Milano / London / Paris in succession while Wine (22M payout) sat in cargo waiting for a 1-turn delivery to Roma 3 hex south.

## Why BuildAdvisor.ts was a red herring

`BuildAdvisor.advise()` in `src/server/services/ai/BuildAdvisor.ts` is an LLM-driven WAYPOINT picker — given a target city, it returns the hex path to build. It does NOT pick the target city. Also disabled by default (`ENABLE_BUILD_ADVISOR=false`) per a 7-day analysis showing "41.6% LLM success rate with no measurable delivery uplift." The defect surface is upstream in `resolveBuildTarget`.

The `actionBreakdown` entries showing `{actor: 'llm', detail: 'build-advisor'}` with empty `llmCallIds: []` are benign legacy labeling — the heuristic path runs and gets the LLM tag for telemetry. Not blocking; could be cleaned up separately.

## Investigation findings (answering Open Questions from behavioral doc)

1. ~~Does the BuildAdvisor receive activeRoute?~~ **Wrong module.** Build-target choice lives in `resolveBuildTarget(route, context)`. The function HAS access to the route. The victory branch chooses to ignore it.
2. ~~What triggers the victory-build mode?~~ **`cash >= 230M AND connectedMajorCities < 7`** at `routeHelpers.ts:73-75`. Re-evaluated every turn.
3. ~~Could the trip planner have generated a deliver-first plan?~~ **It already does.** At s2 t67 the active route was `[{action: deliver, loadType: Wine, city: Roma}]` — one stop. The deterministic planner had the right next move (deliver Wine). `resolveBuildTarget`'s victory override overruled the route.

## Fix shape — guard inside the victory branch

Add a single guard at the top of the victory branch in `resolveBuildTarget`:

```ts
if (isVictoryEligible) {
  // JIRA-239: defer victory build when a high-value delivery is one move away.
  // The victory build is multi-turn; a 22M delivery 1 hex away is higher
  // marginal velocity than a 5M build segment toward an unconnected city.
  if (hasNearbyHighValueDelivery(route, context)) {
    return findRouteBasedTarget(route, context);
  }

  const victoryTarget = findCheapestUnconnectedMajorCity(context);
  if (victoryTarget) {
    return { targetCity: victoryTarget, stopIndex: -1, isVictoryBuild: true };
  }
}
```

### `hasNearbyHighValueDelivery` — new helper

Returns true iff:
- The active route's CURRENT stop is a `deliver` action, AND
- The bot is carrying that load (`context.demands` has a matching `isLoadOnTrain` entry, OR `route.stops[currentStopIndex].action === 'deliver'` and `carriedLoads` includes that loadType), AND
- The delivery city is `isDeliveryOnNetwork` (already on the bot's network — no build needed to reach it), AND
- The Chebyshev hex distance from `context.position` to the delivery city is ≤ `trainSpeed` (1-turn deliverable).

A 22M delivery 1 hex away is the canonical case. Tightening the predicate to "deliverable this turn on existing network" is conservative — false negatives just fall through to current behavior, false positives don't exist (the bot really can deliver this turn).

Signature: `hasNearbyHighValueDelivery(route: StrategicRoute, context: GameContext): boolean`.

Tuning: no payout threshold initially. Any deliverable-this-turn load wins over a multi-turn victory build, because the delivery is essentially free (1 turn) and the post-delivery replan can immediately schedule the next victory build.

### Why this is the right shape

- It's a single-line guard in the existing single-source-of-truth function.
- It uses data already in `context` and `route` — no new inputs to thread through.
- It only changes behavior in the narrow case where the bot is one move from a delivery — doesn't disturb victory-build behavior in any other case.
- It naturally interacts with the `findRouteBasedTarget` fallback: if no nearby delivery, victory build runs as before.

## Test coverage

`routeHelpers.test.ts` (or wherever `resolveBuildTarget` is tested today — grep for existing tests):

- **AC1 — guard fires when deliverable-on-network at distance ≤ speed:** fixture: `cash=240`, `connectedMajorCities=3`, route `[{deliver, Wine, Roma}]`, bot at Napoli (3 hex from Roma), Roma on network, fast_freight speed 12. Assert `resolveBuildTarget` returns `{targetCity: Roma, isVictoryBuild: false}` (route-based, not victory).
- **AC2 — guard does NOT fire when carry is far:** fixture: same cash/cities but bot at Hamburg (35 hex from Roma). Assert returns victory target.
- **AC3 — guard does NOT fire when carry is on bot but delivery city is OFF-network:** same fixture, Roma NOT in `citiesOnNetwork`. Assert returns victory target (the bot still needs to build toward delivery, but that's `findRouteBasedTarget`'s job, not the victory branch's).
- **AC4 — guard does NOT fire when bot is NOT carrying:** fixture: cash 240, no carry, route stops `[{pickup, X@Y}, {deliver, X@Z}]`. Assert returns victory target.
- **AC5 — regression: s2 t67 fixture:** reconstruct the snapshot from the game log (bot at Napoli ~(51,44), cash 241, 3 connected cities, route `[deliver Wine @ Roma]`, Roma reachable on existing network). Assert `resolveBuildTarget` returns `{targetCity: Roma, isVictoryBuild: false}`.

## Why deterministic (not LLM)

Considered LLM-driven target selection in the victory branch (gated to `classifyGamePhase === 'late'`). Rejected for THIS fix because:
- The defect is mechanically localized — one function, one branch, one guard.
- The signal is binary (carrying-deliverable-this-turn vs. not) — no nuanced judgment needed.
- Latency cost: even Haiku adds seconds per turn; this guard runs in microseconds.

LLM remains a valid option for future endgame defects that involve fuzzier trade-offs ("should I deliver this 10M load now vs. spend the turn extending toward an unconnected city that's slightly cheaper?"). For the s2 t67 scenario, the answer is mechanically obvious.

## Relationship to JIRA-240

Both defects ship in `resolveBuildTarget`. JIRA-240 adds a secondary guard AFTER the victory target is chosen (bundle pickup-city connector when budget remains). Implementing both together is natural — same function, same branch, same test file. See JIRA-240's technical doc for the bundling guard.

## Out of scope

- LLM-driven target selection (deferred; may revisit if more endgame defects surface).
- `actor: 'llm'` legacy labeling cleanup (separate, non-blocking).
- Generalizing beyond the single observation in game `a864f7e1`.
- Changing the 230M victory threshold or 7-city target — those are tunables, not defects.
