# JIRA-216 — Technical: In-transit opportunistic pickup splicing in MovementPhasePlanner Phase A

See `docs/jira/jira-216-behavioral.md` for observed behavior.

## Summary of the change

A single mechanical interception in `MovementPhasePlanner.ts`'s movement-emit code path. After `ActionResolver.resolveMove` returns a `MoveTrain` plan with a `path`, but before that plan is pushed to `plans[]`, walk the path. For each intermediate milepost that is a supply city for an unfulfilled demand card with an available chip and a free cargo slot, splice in a `PickupLoad` plan and split the surrounding `MoveTrain` into two segments around the pickup point.

No LLM call. No new advisor. No detour estimation. The decision is fully determined by game rules — pickup costs zero movement and adds one load to the train; if the bot has a matching unfulfilled demand card and a free slot, picking up is strictly value-positive.

## Why this scope

The case is genuinely simple and the existing JIRA-214 advisor doesn't cover it. JIRA-214 fires post-action *at* a city the bot has stopped at; this case is mid-movement *through* a city the bot doesn't stop at. The two are orthogonal:

| Trigger                                  | Owns                                             |
|------------------------------------------|--------------------------------------------------|
| JIRA-214 `RouteEnrichmentAdvisor`        | "While stopped at a city, what else is here?"    |
| JIRA-216 (this) in-transit pickup splice | "While walking through a city, free EV here?"    |

Routing this through the LLM would be wasteful: the answer is always "yes" if all preconditions are met. A pre-LLM filter exhaustive enough to remove all noise *is* the decision. So the JIRA ships the filter and skips the LLM call.

## Component: `spliceOpportunisticPickups` in `MovementPhasePlanner`

### Location

A private static method on `MovementPhasePlanner`, invoked from the "stop city on network" branch of the Phase A loop, immediately after the `MoveTrain` plan is returned from `ActionResolver.resolveMove` (`MovementPhasePlanner.ts:322`) and before the plan is pushed at `MovementPhasePlanner.ts:334`.

```ts
const moveResult = await ActionResolver.resolveMove({ to: targetCity }, snapshot, remainingBudget);
if (!moveResult.success || !moveResult.plan) { /* existing error handling */ }

const movePlan = moveResult.plan as TurnPlanMoveTrain;
const splicedPlans = MovementPhasePlanner.spliceOpportunisticPickups(
  movePlan, snapshot, context, activeRoute, gridPoints, tag,
);

plans.push(...splicedPlans);
// ... existing budget/position bookkeeping using the *final* MoveTrain segment's path tail
```

### Signature

```ts
private static spliceOpportunisticPickups(
  movePlan: TurnPlanMoveTrain,
  snapshot: GameSnapshot,
  context: TurnContext,
  activeRoute: ActiveRoute,
  gridPoints: GridPoint[],
  tag: string,
): TurnPlan[]
```

Returns either `[movePlan]` (no opportunities, unchanged) or `[MoveTrain segment 1, PickupLoad, MoveTrain segment 2, PickupLoad, ..., MoveTrain segment N]` — interleaved.

### Algorithm

1. Build `pathCoords = movePlan.path` (already a `Coord[]` from `ActionResolver.resolveMove`).

2. Build a quick lookup: `cityByCoord: Map<string, GridPoint>` for any path coord that is a city milepost. Use the existing `loadGridPointsMap()` (see usage at `MovementPhasePlanner.ts:354`) keyed `${row},${col}`.

3. Build the filter inputs once (constant across the path walk):
   - `freeSlots = snapshot.bot.trainCapacity - snapshot.bot.loads.length`
   - `loadsCarried = new Set(snapshot.bot.loads)` — for the "load not already carried" check (Empire-Builder rule: a train can't carry two chips of the same load type)
   - `eligibleCards = context.demands.filter(d => !routeAlreadyDelivers(d, activeRoute))` — exclude demands whose deliver leg is already past the bot in the active route (i.e., already delivered or about to be); the helper inspects `activeRoute.stops.slice(currentStopIndex)` for a matching DELIVER

4. Walk `pathCoords` index `i = 0…path.length-1`. For each coord:
   - If `freeSlots === 0`: stop scanning (no more capacity).
   - Look up `gp = cityByCoord.get(${row},${col})`. Skip if not a city.
   - For each `card` in `eligibleCards`:
     - Skip if `card.supplyCity !== gp.cityName`.
     - Skip if `card.loadType ∈ loadsCarried` (game rule: no duplicate chips on board the same train).
     - Skip if `(snapshot.loadAvailability[gp.cityName] ?? []).indexOf(card.loadType) === -1` (chip not on the table at this city right now).
     - **Match.** Record `{ pickupAt: i, loadType: card.loadType, supplyCity: gp.cityName, demandCardId: card.cardId }`. Decrement `freeSlots`. Add `card.loadType` to `loadsCarried`. Remove `card` from `eligibleCards` (one card per pickup; second matching card waits for the next opportunity). Break the inner card loop.

5. If no matches were recorded, return `[movePlan]` unchanged.

6. Build the spliced plan list. Walk pickups in `pickupAt` ascending order:
   - For each pickup, slice the `MoveTrain.path` into the segment ending at `pickupAt` (inclusive — the bot needs to *be* at the milepost to pick up) and the remainder.
   - Emit a `MoveTrain` plan whose `path` is the closed segment, then a `PickupLoad` plan for `(loadType, supplyCity, demandCardId)`, then continue with the remainder for the next iteration.
   - The final remainder (post the last pickup) becomes the trailing `MoveTrain` segment.

7. **Skip empty MoveTrain segments.** If two pickups happen at the same milepost (rare — same supply city covered by two cards but capacity allows both within one stop), or a pickup happens at the very first or very last milepost of the original path, one of the surrounding segments may have only a single coord. A `MoveTrain` plan with `path.length < 2` (no actual movement) must not be emitted; suppress it. The pickup itself is still valid.

8. **Reconcile the active route.** For each pickup recorded, if `activeRoute.stops.slice(currentStopIndex)` contains a `pickup` stop with the same `(loadType, supplyCity)`, mark it for removal (the pickup happened early; the planned future pickup is no longer needed). Mutate the returned `activeRoute` — but this happens *after* the spliced plans are pushed and is handled by the caller, not inside `spliceOpportunisticPickups`. See "Caller follow-up" below.

9. Return the interleaved plan list.

### Caller follow-up in the Phase A loop

After `plans.push(...splicedPlans)`, the caller updates loop state:

- **Loads / capacity**: each `PickupLoad` in `splicedPlans` mutates `snapshot.bot.loads` and `context.loads` (push the new `loadType`). Subsequent loop iterations see updated capacity.
- **Active route reconciliation**: walk the spliced PickupLoad entries. For each, if `activeRoute.stops` (slice from `currentStopIndex`) contains a `pickup` stop matching `(loadType, supplyCity)`, splice it out of the `stops` array and re-run `TurnExecutorPlanner.skipCompletedStops(activeRoute, context)` to advance the index past any now-redundant stops. This mirrors the behavior already in place at `MovementPhasePlanner.ts:161-162` after a planned pickup completes.
- **Movement budget**: pickups are free per game rules, so no decrement. The existing `milesConsumed` calculation at `MovementPhasePlanner.ts:338` operates on the *full* original `movePlan.path`, which equals the sum of all segment-path lengths in `splicedPlans` — so no change to the budget bookkeeping is needed if the helper preserves total path length. The implementation must guarantee that property: `sum(segment.path.length - 1 for each MoveTrain segment) === movePlan.path.length - 1`. This is true by construction when segments share boundary coords at pickup mileposts (each pickup coord appears as the *last* coord of one segment and the *first* coord of the next).
- **Position update**: the existing logic at `MovementPhasePlanner.ts:343-350` reads `dest = movePlan.path[movePlan.path.length - 1]`. Switch to `dest = splicedPlans[splicedPlans.length - 1].path[...]` if the last spliced plan is a `MoveTrain`, or to the pickup coord if the splice ends on a `PickupLoad` (because a pickup at the final milepost means no trailing move). Equivalent handling: extract `dest` from whichever of the final two spliced plans owns the trailing coord.

### Example

Input `movePlan.path` (Flash, turn 88): `[A, B, Ruhr, D, E, Holland]` where Ruhr is at index 2 and Holland is at index 5.

Demand cards in hand: `Tourists @ Ruhr → Madrid (35M)`, `Tourists @ Ruhr → Valencia (35M)`, `Cheese @ Holland → Napoli (already in plan as activeRoute pickup)`.

Loads available at Ruhr: `[Tourists, Steel, Imports, ...]`. Loads available at Holland: `[Cheese, Flowers, ...]`.

Capacity: 3, carrying `[Beer]` → `freeSlots = 2`.

Walk:
- index 0 (A): not a city. Skip.
- index 1 (B): not a city. Skip.
- index 2 (Ruhr): match `Tourists @ Ruhr → Madrid`. Record `{pickupAt: 2, loadType: "Tourists"}`. `freeSlots → 1`. `loadsCarried → {Beer, Tourists}`. The second Tourists card is filtered (`loadType ∈ loadsCarried` after this iteration), so it's not picked up at Ruhr — the bot can only carry one Tourists chip.
- index 3 (D): not a city. Skip.
- index 4 (E): not a city. Skip.
- index 5 (Holland): the Cheese pickup is already in `activeRoute.stops` (planned), so `routeAlreadyDelivers` filtering excludes it — but the filter checks for *deliver* legs in the active route, not pickup legs. Need a parallel `routeAlreadyPicksUp` check to dedupe planned pickups against opportunistic ones. **However**, since the planned pickup at Holland is *the bot's currentStop*, the splice at Holland would pre-empt it; instead, let the existing post-arrival pickup logic at `MovementPhasePlanner.ts:156` handle it (the bot is going to arrive at Holland anyway and execute the planned pickup there). To avoid double-pickup, the splice helper *also* checks: `card.supplyCity === activeRoute.stops[currentStopIndex].city && activeRoute.stops[currentStopIndex].action === 'pickup'` → skip (the planned arrival will pick this up).

Output `splicedPlans`:
1. `MoveTrain` with `path = [A, B, Ruhr]`
2. `PickupLoad` with `loadType: "Tourists"`, `city: "Ruhr"`, `demandCardId: <Madrid card id>`
3. `MoveTrain` with `path = [Ruhr, D, E, Holland]`

Total path length is preserved: 6 coords across 2 segments with one shared boundary = 6 unique coords, identical to the input. Movement budget identical.

Game-state result: bot arrives at Holland carrying `[Beer, Tourists]`, executes planned `pickup Cheese@Holland`, becomes `[Beer, Tourists, Cheese]` — full Superfreight, three loads, exactly the operating mode the data shows is currently almost never achieved.

### Edge cases

| Case | Handling |
|------|----------|
| Path crosses Major City red zone with multiple mileposts | Each milepost is a separate coord in `path`; pickup may happen at any one. Game rule: load can be picked up at any major city milepost. The walk handles naturally. |
| Path uses ferry crossing | Ferry traversal in this implementation appears as a path segment ending at the ferry port (turn ends there, see `MovementPhasePlanner.ts:356-360`). The splice helper sees only the path it's given; ferry termination is handled before the splice runs. |
| Bot is on opponent's track | Pickup is still legal at the city itself (game rules don't forbid pickup on opponent track, only charge for movement). The splice helper doesn't need to know about track ownership. |
| Bot's `path[0]` is a city it could pick up at | Already handled by the existing post-action branch at line 156 — the bot doesn't *move* into its current city, it *starts* there. The splice helper walks from index 0 but the bot's starting city is the first coord; if it's eligible, the splice creates a degenerate first MoveTrain segment of `[start, start]` which is filtered by the `path.length < 2` rule, leaving `[PickupLoad, MoveTrain]`. Equivalent semantics to the bot picking up before moving. |
| `activeRoute` includes a planned pickup at a pass-through city | Skip splicing for that card — the planned arrival's own pickup logic handles it. |
| `activeRoute` includes a planned pickup at a different city for the same `loadType` | Splice anyway; the planned pickup will fail when the bot arrives (load already carried), and the existing handler at `currentStop.action === 'pickup'` should detect "already carrying" and advance the stop index without re-pickup. (Verify in execution; if not handled, add a `loadsCarried` short-circuit to `executeStopAction`.) |
| Two pickups in the same path, second one's supply city has the same load type | The `loadsCarried` mutation prevents this — the inner loop skips. The bot only carries one chip per load type per game rules. |
| `snapshot.loadAvailability` is stale (chip taken by an opponent between snapshot capture and turn execution) | The downstream `TurnExecutor.executePlan` for the spliced `PickupLoad` will fail on availability check; bubble up as a warning, drop that pickup, continue with remaining plans. Existing pattern from JIRA-173 early-execution at `MovementPhasePlanner.ts:222-245`. |

### Logging

```
[opportunistic-pickup] Path scan at turn N for player P: 6 coords, 1 city milepost (Ruhr)
[opportunistic-pickup] Match: Tourists @ Ruhr (card #X, deliver Madrid 35M) — slots before=2 after=1
[opportunistic-pickup] Spliced 1 pickup; emitted 3 plans (Move[A→Ruhr], Pickup, Move[Ruhr→Holland])
[opportunistic-pickup] Removed redundant planned pickup from activeRoute: pickup Tourists@Ruhr (was stop index Y)
[opportunistic-pickup] Skipped Tourists @ Ruhr — already carrying Tourists
[opportunistic-pickup] Skipped Cheese @ Holland — already planned as currentStop
[opportunistic-pickup] No eligible candidates (slots=0)
```

## Files touched

| Path | Change |
|------|--------|
| `src/server/services/ai/MovementPhasePlanner.ts` | Add `spliceOpportunisticPickups` private static method. Modify the "stop city on network" branch (around line 322) to invoke it and push spliced plans. Add caller follow-up: load count mutation, active-route pickup-stop reconciliation, dest-coord extraction. |
| `src/server/services/ai/TurnExecutorPlanner.ts` | If not already present, ensure `executeStopAction` for `pickup` is a no-op when `context.loads` already contains the requested load type (covers the rare case where an opportunistic pickup pre-empted a planned pickup at a *different* city). |
| `src/server/__tests__/ai/MovementPhasePlanner.test.ts` | Extend with the test cases below. |

No changes to schemas, no changes to LLM prompts, no new files. The change is contained to one method on one class plus its call site.

## Test strategy

Unit tests added to `src/server/__tests__/ai/MovementPhasePlanner.test.ts` covering `spliceOpportunisticPickups` directly (it's a pure function over snapshot inputs, easy to test):

- **No matches → unchanged**: path coords contain no cities, returns `[movePlan]`.
- **No matches → has city but no demand**: path crosses a city but no demand card references it; returns `[movePlan]`.
- **No matches → no free slots**: `loads.length === trainCapacity`; returns `[movePlan]`.
- **No matches → load not available**: card's `loadType` is not in `snapshot.loadAvailability[city]`; returns `[movePlan]`.
- **Single match, mid-path**: emits `[Move, Pickup, Move]` with path lengths summing to the original; pickup `loadType` matches the card.
- **Single match, first coord**: emits `[Pickup, Move]` (no degenerate leading segment).
- **Single match, last coord**: emits `[Move, Pickup]` (no degenerate trailing segment).
- **Two matches, two cities**: emits `[Move, Pickup, Move, Pickup, Move]`; both pickups recorded; total path length preserved.
- **Two cards same supply city, capacity 2**: only one card claimed (the one earlier in `eligibleCards`); the second is skipped because `loadType ∈ loadsCarried` after the first match. (Game rule: one chip per load type per train.)
- **Capacity exhaustion mid-path**: third potential pickup at later milepost is skipped because `freeSlots === 0`.
- **Already-planned pickup at pass-through city**: `activeRoute.stops[k].action === 'pickup'` with matching `(loadType, supplyCity)` for `k > currentStopIndex` — splice still happens (early pickup is preferred), and the active route is mutated to remove stop `k`.
- **Pass-through city is the currentStop city**: the splice helper does not pre-empt the planned arrival pickup; returns `[movePlan]` (the existing arrival branch handles the pickup).
- **Snapshot stability**: the helper does not mutate `snapshot.bot.loads` directly — it returns the spliced plan list and lets the caller's existing post-pickup state-update path (mirroring lines 156–175) update `loads`. (Or, if the implementation chooses to mutate locally for slot tracking within the helper, asserting that the mutation is on a *cloned* state is sufficient.)

Integration check: re-play the Flash turn 88 snapshot from game `c2a4df33` (load the NDJSON record, reconstruct snapshot/context) and verify that the splice produces the expected `[Move(A→Ruhr), Pickup(Tourists), Move(Ruhr→Holland)]` plan list. This is the strongest regression guard: the exact game state that motivated the JIRA must produce the desired output.

## Failure modes & fallback

- **Splice produces a `PickupLoad` for a chip taken by another player between snapshot and execution**: `TurnExecutor.executePlan` returns failure; caller logs and drops the pickup, continuing with the rest of the spliced plans. Existing failure-tolerance pattern.
- **Splice produces a path segment of length 0 or 1**: filtered before emission (degenerate segment skip rule). Asserted in tests.
- **`activeRoute.stops` mutation collides with downstream logic that holds a stale stop reference**: covered by the existing `assertStopsNotMutatedAfterPickup` (`MovementPhasePlanner.ts:165`); the helper must call this after its own mutation, with the same semantics.
- **Helper called when `gridPoints` is empty/undefined**: short-circuit to `[movePlan]` (can't look up cities). Log a warning, since this likely indicates a misconfiguration.
- **Helper invoked on a `MoveTrain` plan with `path.length < 2`**: short-circuit to `[movePlan]` (no movement, no pass-through). Defensive; shouldn't occur in normal flow.

## Out of scope (deferred)

- **Updating the deliver leg in `activeRoute` after an opportunistic pickup.** Once the bot has a load on board with no planned deliver stop, the next `PostDeliveryReplanner` invocation (after the next delivery) or the next `NewRoutePlanner` call will incorporate it into the route. The pickup adds the load; the existing replanner machinery does the rest.
- **Speculative pickup of loads with no matching demand card.** Out per the behavioral spec.
- **Coordinating with JIRA-214's post-pickup advisor when both fire on the same turn.** They operate at different points (JIRA-216 during movement, JIRA-214 after a planned action); each runs independently. If they collectively over-load the train, the second one's filter (`freeSlots > 0`) naturally short-circuits.
- **Telemetry counters** for "pickups via splice" vs "pickups via planned route" — useful for measuring impact across many games, but not required for v1. Add later when we want to validate the behavioral spec's "8–12 turns of compression" estimate against real games.
