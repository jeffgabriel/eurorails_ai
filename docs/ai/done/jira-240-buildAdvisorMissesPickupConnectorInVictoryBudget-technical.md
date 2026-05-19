# JIRA-240 — Victory-build branch in `resolveBuildTarget` returns a single target, leaving budget unused for a small adjacent connector to the next-route pickup city (technical)

Companion to `jira-240-buildAdvisorMissesPickupConnectorInVictoryBudget-behavioral.md`.

## Defect locus

Same function as JIRA-239: `src/server/services/ai/routeHelpers.ts:68-106` — `resolveBuildTarget()`. After the victory branch picks `findCheapestUnconnectedMajorCity`, the function returns immediately:

```ts
if (isVictoryEligible) {
  const victoryTarget = findCheapestUnconnectedMajorCity(context);
  if (victoryTarget) {
    return { targetCity: victoryTarget, stopIndex: -1, isVictoryBuild: true };
  }
}
```

The return shape is single-target (`BuildTargetResult` has one `targetCity` field). The 20M per-turn build budget can cover both the chosen victory city's reach AND a small connector to a near-by pickup city, but the function offers no way to surface that second target. Downstream consumers (the build executor) see only one target and lay track toward it until budget exhausts or the target is reached.

For s2 t71 the victory target was Wien (~14M of segments), and the next route's pickup was Firenze — ~3M of new track from the bot's network. Combined 17M < 20M budget, but only Wien was built. At t72, after cash dropped below 230M, the route-based branch took over and picked Firenze. By then the bot was already at Roma area, not heading toward Firenze, so a turn was wasted re-routing.

## Why BuildAdvisor.ts was a red herring

Same as JIRA-239: `BuildAdvisor.ts` is a waypoint picker (disabled by default), not the target selector. The single-target shape is a property of `resolveBuildTarget`, not of any LLM advisor.

## Investigation findings (answering Open Questions from behavioral doc)

1. ~~Does the BuildAdvisor support multi-target builds?~~ **Wrong module.** `resolveBuildTarget` returns a single `BuildTargetResult`. The downstream build executor reads this single target. Adding a secondary-target capability requires extending the return shape and updating the executor's consumption.
2. ~~Does the post-delivery replan know about the next pickup at t71?~~ **Yes — by t71's build phase, the post-delivery replan has already committed the new route (Marble Firenze→Birmingham).** The route is in `context.demands` AND in the active route's stops. `resolveBuildTarget` has full visibility into it via the `route` argument; the victory branch just doesn't look at non-victory stops.
3. ~~Priority between victory completion and pickup prep?~~ **No priority needed if budget covers both.** The scenario is "bundle when feasible", not "choose between." When the victory build's cost leaves budget remaining AND a pickup connector fits in that budget, do both.

## Fix shape — return-shape extension + bundling guard

### 1. Extend the return shape

```ts
interface BuildTargetResult {
  targetCity: string;
  stopIndex: number;
  isVictoryBuild: boolean;
  // JIRA-240: optional secondary build target to bundle with the primary.
  // Consumed by the build executor: lay primary track first, then if budget
  // remains, lay secondary connector. Null means no secondary.
  secondaryTarget?: string | null;
  secondaryEstimatedCost?: number;
}
```

### 2. Add the bundling guard inside the victory branch

```ts
if (isVictoryEligible) {
  // JIRA-239 guard goes here (delivery-first)

  const victoryTarget = findCheapestUnconnectedMajorCity(context);
  if (victoryTarget) {
    const victoryCost = estimatedCostFor(victoryTarget, context);
    const remainingBudget = TURN_BUILD_BUDGET - victoryCost;  // 20M - victoryCost

    // JIRA-240: bundle the next-route pickup connector if remaining budget covers it.
    const nextPickup = findNextRoutePickupOffNetwork(route, context);
    const nextPickupCost = nextPickup ? estimatedCostFor(nextPickup, context) : Infinity;

    if (nextPickup && nextPickupCost <= remainingBudget) {
      return {
        targetCity: victoryTarget,
        stopIndex: -1,
        isVictoryBuild: true,
        secondaryTarget: nextPickup,
        secondaryEstimatedCost: nextPickupCost,
      };
    }

    return { targetCity: victoryTarget, stopIndex: -1, isVictoryBuild: true };
  }
}
```

### 3. `findNextRoutePickupOffNetwork` — new helper

Returns the first `pickup`-action stop in the active route whose city is NOT yet on the bot's network. Effectively a stripped-down version of `findRouteBasedTarget` that only looks at pickups (not deliveries), because pickups are what the bot needs to reach before it can continue the route.

Signature: `findNextRoutePickupOffNetwork(route: StrategicRoute, context: GameContext): string | null`.

### 4. `estimatedCostFor` — likely already exists

`context.unconnectedMajorCities` already includes per-city `estimatedCost`. For pickup cities (often non-major), need a small Dijkstra call against the bot's network. Reuse `PathCostEstimator.estimateGraphPathCost` (used elsewhere for similar estimates).

### 5. Build executor changes

The consumer of `BuildTargetResult` — likely `BuildPhasePlanner` at `src/server/services/ai/BuildPhasePlanner.ts:170-193` — currently passes a single `targetCity` to the BuildAdvisor / heuristic Dijkstra. Update it to:
- Lay track toward `targetCity` first (existing behavior).
- After the primary build, if `secondaryTarget` is set AND build budget remains, lay track toward `secondaryTarget`.
- Log both in the build trace.

Confirm by reading `BuildPhasePlanner.executeBuild` (or whatever method consumes the result) at implementation time.

### Why this is the right shape

- The bundling decision lives in the same function that already chose the primary target — no new orchestration layer.
- The return-shape extension is additive (optional fields) — existing call sites that don't read `secondaryTarget` continue to work.
- It only adds a secondary target when the budget cleanly covers both — no aggressive over-commitment, no need for partial-build retry logic.
- The consumer (build executor) handles the "primary first, secondary if budget remains" sequencing naturally.

## Test coverage

`routeHelpers.test.ts`:

- **AC1 — bundles when budget covers both:** fixture: cash 240, 6 connected cities (incl. all of Paris/Holland/Milano/Ruhr/Berlin/London), route `[{pickup, Marble, Firenze}, {deliver, Marble, Birmingham}]`, Wien estimated 14M, Firenze 3M from network. Assert `resolveBuildTarget` returns `{targetCity: Wien, secondaryTarget: Firenze, secondaryEstimatedCost: 3, isVictoryBuild: true}`.
- **AC2 — does NOT bundle when budget too tight:** same fixture, Wien estimated 18M, Firenze 3M. Assert `secondaryTarget` is undefined (18+3=21 > 20).
- **AC3 — does NOT bundle when no next-route pickup off-network:** fixture: route's pickup city already on network. Assert single-target result.
- **AC4 — does NOT bundle when next route has no pickup stop:** fixture: route is delivery-only (carry-and-deliver). Assert single-target result.
- **AC5 — regression: s2 t71 fixture:** reconstruct snapshot from the game log (bot at Roma area, cash 240 mid-turn after Wine delivery, 6 connected cities, route `[{pickup Marble@Firenze}, {deliver Marble@Birmingham}]`, Wien estimated ~14M, Firenze ~3M). Assert top-level result has `secondaryTarget: Firenze`.

`BuildPhasePlanner.test.ts`:

- **AC6 — executor lays primary then secondary:** fixture: `BuildTargetResult` with `targetCity: Wien` and `secondaryTarget: Firenze`. Assert track is laid toward Wien first, then toward Firenze, total spend ≤ 20M.
- **AC7 — executor respects budget exhaustion on primary:** fixture: primary cost is 19M (over expected 14M due to terrain), secondary cost 3M. Assert primary is built fully, secondary is skipped (no partial build that ends mid-segment).

## Why deterministic (not LLM)

Same reasoning as JIRA-239:
- The decision is mechanical (does budget cover both? if yes, bundle).
- One arithmetic comparison; no judgment.
- Latency: microseconds.

LLM remains an option for harder bundling trade-offs ("budget covers victory OR pickup but not both — which one?"). Current scope is the "both fit" case, which is unambiguous.

## Relationship to JIRA-239

Both fixes land in `resolveBuildTarget`'s victory branch:
- JIRA-239: delivery-first guard at the TOP of the branch (return early to route-based).
- JIRA-240: bundling guard at the BOTTOM of the branch (extend the return shape with secondary).

They're independent but compatible — neither affects the other's behavior. The natural implementation order is JIRA-239 first (smaller, no return-shape change), then JIRA-240 (extends the return shape, requires executor update). Both can ship in one PR if desired.

## Out of scope

- LLM-driven bundling decisions (deferred).
- N-target builds beyond the 2-target bundle (premature generalization).
- Bundling delivery-stop builds with victory builds (would require route reordering — separate concern).
- Tuning the 230M / 7-city victory thresholds.
- Generalizing beyond the single observation in game `a864f7e1`.
