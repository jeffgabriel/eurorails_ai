# JIRA-244 — Ferry-aware `citiesOnNetwork` + A3 empty-result disambiguation (technical)

Companion to `jira-244-citiesOnNetworkIgnoresPaidFerryDestinations-behavioral.md`.

## Defect locus

Two coupled sites:

1. **`NetworkContext.computeCitiesOnNetwork` at `src/server/services/ai/context/NetworkContext.ts:189-201`** — iterates only `network.nodes` (segment endpoints) and emits the city at each. Hybrid city/ferry-port destinations (Dublin, Belfast) are never segment endpoints when the bot has track to the partner port; they're reached *across* the paid ferry. The function silently omits them.

2. **`MovementPhasePlanner.ts:468` (A3 empty-result interpretation)** — when `computeBuildSegments` returns `[]` because the target is already reachable (no segments need to be built), the caller treats it as `build_dijkstra_failed`. There is no path that distinguishes "no path found" from "no path needed."

The first bug causes A2 to incorrectly enter the A3 fall-through. The second bug turns that into a terminal PassTurn instead of a graceful "move there directly" recovery.

## Fix shape

### Fix A — Ferry-aware `computeCitiesOnNetwork`

Modify `NetworkContext.computeCitiesOnNetwork` to also include cities that are reachable across ferry edges where the bot owns at least one endpoint. Pattern is already established in `computeBuildSegments.ts:240-260` (ferry adjacency map). Adapt it here:

```ts
static computeCitiesOnNetwork(
  network: ReturnType<typeof buildTrackNetwork>,
  gridPoints: GridPoint[],
): string[] {
  const cityNames = new Set<string>();
  for (const nodeKey of Array.from(network.nodes)) {
    const point = gridPoints.find(gp => `${gp.row},${gp.col}` === nodeKey);
    if (point?.city?.name) {
      cityNames.add(point.city.name);
    }
  }

  // JIRA-244: Add cities reachable across paid ferries. When the bot has track
  // to one endpoint of a ferry pair, the partner endpoint is reachable (the
  // build to the owned port paid the full ferry cost per game rules).
  const ferryEdges = getFerryEdges();
  for (const ferry of ferryEdges) {
    const aKey = `${ferry.pointA.row},${ferry.pointA.col}`;
    const bKey = `${ferry.pointB.row},${ferry.pointB.col}`;
    const aOwned = network.nodes.has(aKey);
    const bOwned = network.nodes.has(bKey);
    if (aOwned && !bOwned) {
      const partner = gridPoints.find(gp => `${gp.row},${gp.col}` === bKey);
      if (partner?.city?.name) cityNames.add(partner.city.name);
    } else if (bOwned && !aOwned) {
      const partner = gridPoints.find(gp => `${gp.row},${gp.col}` === aKey);
      if (partner?.city?.name) cityNames.add(partner.city.name);
    }
  }

  return Array.from(cityNames);
}
```

Lines added: ~15. `getFerryEdges` is already imported in `NetworkContext.ts:22`.

### Fix B — Distinguish "no path needed" from "no path found" in A3

At `MovementPhasePlanner.ts:468`, when `a3OriginResult.length === 0`, check whether the target's coord is already reachable from the bot's network. If yes, set a different termination reason and fall through to MoveTrain handling rather than to PassTurn.

The cleanest check: is `a3TargetCoord` in `network.nodes` OR in any ferry-pair partner of a node in `network.nodes`? If so, `a3.terminationReason = 'a3_target_already_reachable'` and let the outer loop continue with `continue` so A2 retries with the move budget.

If Fix A is applied correctly, Fix B becomes nearly unreachable for the specific Dublin case (because A2 will now see Dublin in `citiesOnNetwork` and never call A3). But Fix B is still worth doing as a belt-and-braces defense against future variants of "empty result is not failure."

### Why not just fix A?

Fix A alone unsticks s1. But the A3 empty-result trap is a latent bug that will reappear whenever:
- A new ferry topology is added (e.g., a third hybrid city/ferry endpoint)
- A future `citiesOnNetwork` consumer disagrees with the build-time pathfinder's reachability
- The build pathfinder grows additional reachability mechanics (e.g., red-area passage, opponent track via fee) that aren't immediately mirrored in `citiesOnNetwork`

Each future divergence would trigger the same A3 trap. Fix B closes that vulnerability class.

## Test coverage

`NetworkContext.test.ts`:

- **AC1** — Fix A: fixture with segments terminating at Liverpool `(13,29)`. Assert `computeCitiesOnNetwork` returns set including `"Dublin"`.
- **AC4** — Fix A symmetry: fixture with segments terminating at Stranraer `(7,28)`. Assert returned set includes `"Belfast"`.
- **AC5** — Fix A non-regression: fixture with no ferry-port-touching segments. Assert returned set is unchanged from pre-fix behavior.
- Edge: fixture where bot has BOTH ferry endpoints (Liverpool and Dublin coords both as segment endpoints). Assert Dublin appears once, not twice.

`MovementPhasePlanner.test.ts`:

- **AC2** — Fix A: fixture with s1's t20 snapshot inputs. Run `MovementPhasePlanner.run` for one turn. Assert it enters the MoveTrain branch (line 362), not the `stop_city_not_on_network` fall-through (line 429).
- **AC2b** — Fix B: synthetic fixture where the target is reachable via paid ferry but `citiesOnNetwork` has been deliberately stubbed to exclude it (simulating a future regression). Assert `a3.terminationReason === 'a3_target_already_reachable'` and the outer loop continues rather than emitting PassTurn.

`integration/jira244.test.ts` (new):

- **AC3** — full regression: replay s1's t20 snapshot (50 segments incl. Liverpool, carrying Cheese, route `deliver:Dublin`) through 10 turns. Assert: at least one PickupTrain/MoveTrain/DeliverLoad action emitted, Cheese load delivered to Dublin, no PassTurn emitted, cash strictly increases at some point during the 10 turns.

## Risk

- `citiesOnNetwork` is read by ~10 production files (`routeHelpers`, `SolvencyCheck`, `MovementPhasePlanner`, `TurnExecutorPlanner`, `BuildAdvisor`, `DemandContext`, `ContextSerializer`, `DemandEngine`, `ContextBuilder`, others). Expanding the set's semantic from "directly on track" to "directly on track OR reachable via paid ferry" could shift planner decisions in games where this matters. Compounds impact analysis on `computeCitiesOnNetwork` (the function) showed 11 affected entities at depth 2 — small surface for the function itself. The field consumers were enumerated by grep.
- Most consumers will benefit from the expanded set (they want "can the bot deliver here without building more"). The risk is for callers that specifically wanted "is this city on my literal track segments" — those should be audited.

## Out of scope

- Trip planner cost estimator that undershoots multi-ferry routes (a separate ticket).
- Drop-load mechanism when a carried-load delivery proves impossible (mooted by this fix for the Dublin case; separate concern for other terminal states).
- Track-use fees when partner ferry endpoint is on another player's track.
- Generalizing Fix B to other phases of the executor (only A3 is affected by the observed bug).
