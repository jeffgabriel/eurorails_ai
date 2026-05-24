# JIRA-231 — Filter structurally unreachable demands at the DemandEngine layer (technical)

See `jira-231-structuralGateImmediateReplan-behavioral.md` for the observed behavior and acceptance criteria.

## Root-cause trace (game 32964f24, turns 20 & 48, player S1)

Firenze is a Small City at `(row=48, col=44)`. Two other players have track to it; S1 does not. `TurnValidator.computeSaturatedCityKeys(snapshot)` (`TurnValidator.ts:176-271`) correctly returns a set containing `"48,44"` for S1's snapshot.

The pipeline:

1. **`ContextBuilder.rebuildDemands`** (`ContextBuilder.ts:225-248`) calls `computeAllDemandContexts(snapshot, network, gridPoints, reachableCities, citiesOnNetwork, connectedMajorCities)` to produce `DemandContext[]`. **It does NOT consult `saturatedCityKeys`.**
2. **`computeAllDemandContexts`** (`src/server/services/ai/context/DemandEngine.ts:741`) builds a `DemandContext` per (card × commodity), computing `estimatedTrackCostToSupply` and `estimatedTrackCostToDelivery` via `estimateTrackCost` / cold-start logic (`DemandEngine.ts:506-558`). For Marble@Firenze: `estimatedTrackCostToSupply = 7`. The function does not know (48, 44) is unreachable for S1.
3. **`AIStrategyEngine.ts:770-790`** sorts `freshDemands` by `demandScore` and produces `demandRanking`. Marble@Firenze lands at rank 1 with score 4.7.
4. **`DeterministicTripPlanner`** consumes the demand contexts and produces an active route with `pickup Marble @ Firenze` as the first stop.
5. **Build phase tries to reach Firenze, validator rejects, Phase B stripped, PassTurn → next-turn DiscardHand** (as documented in the behavioral file).

The fix point is step 1/2: the demand contexts must know about saturation before the TripPlanner ever sees them.

## Proposed fix

### Single change: thread saturation into `DemandEngine`

**`src/server/services/ai/context/DemandEngine.ts`** — extend `computeAllDemandContexts` (and `computeDemandContext`) signature with an optional `saturatedCityKeys: Set<string>` parameter. For each demand, after computing `estimatedTrackCostToSupply` and `estimatedTrackCostToDelivery`, perform a feasibility check:

```ts
// Pseudo-code at the appropriate point in computeDemandContext (around line 558)
const supplyKey = supplyCity ? cityNameToKey(supplyCity, gridPoints) : null;
const deliveryKey = cityNameToKey(deliveryCity, gridPoints);

const supplyInfeasible = supplyKey
  && saturatedCityKeys?.has(supplyKey)
  && !network?.nodes.has(supplyKey);

const deliveryInfeasible = saturatedCityKeys?.has(deliveryKey)
  && !network?.nodes.has(deliveryKey);

const isFeasible = !supplyInfeasible && !deliveryInfeasible;
```

Add an `isFeasible: boolean` (and `infeasibleReason?: string` for telemetry) to the `DemandContext` type in `src/shared/types/GameTypes.ts`. The infeasible context still computes scores (for debug visibility) but is **excluded** from the ranking that TripPlanner consumes.

### Plumbing

- **`ContextBuilder.rebuildDemands`** (`ContextBuilder.ts:225`) — compute `const saturatedCityKeys = TurnValidator.computeSaturatedCityKeys(snapshot);` and pass it to `computeAllDemandContexts`.
- **`AIStrategyEngine.ts:770`** — when sorting `freshDemands`, filter `d => d.isFeasible !== false` before ranking (or rely on the upstream filter — pick whichever keeps the debug-overlay ranking honest; including infeasibles in the rendered ranking with an `infeasible` flag is fine, as long as the TripPlanner doesn't pick them).
- **`DeterministicTripPlanner`** (`DeterministicTripPlanner.ts:265, 313`) — when enumerating candidate routes, skip any candidate whose pickup or delivery references a city marked `isFeasible: false`. This is the actual choke point that prevents the bad pick.

### Why this is the elegant fix

- One concept (`saturatedCityKeys`) already exists, is computed correctly, and is consumed correctly by `BuildRouteResolver` and `TurnValidator`. We're plumbing it one step further upstream — into the layer that selects which demand cards even get considered.
- The current JIRA-203 strip + lockup machinery is correct **as a safety net for races** (e.g., an opponent builds mid-turn between TripPlanner pick and Phase B). Keep it. This fix just removes the dominant case (90%+ of structural-strip recoveries) so the safety net is rarely needed.
- No new state, no per-turn replan loop, no gate classification, no recoverability tagging. The previous proposal's three-layer approach was overkill once we identified that Firenze itself is the saturated city, not a milepost on the path.

## Files to touch

- `src/shared/types/GameTypes.ts` — add `isFeasible?: boolean` (and optional `infeasibleReason?: string`) to `DemandContext`.
- `src/server/services/ai/context/DemandEngine.ts` — extend `computeDemandContext` and `computeAllDemandContexts` with `saturatedCityKeys` parameter; compute `isFeasible` per demand.
- `src/server/services/ai/ContextBuilder.ts` — compute `saturatedCityKeys` from snapshot in `rebuildDemands` and forward it.
- `src/server/services/ai/DeterministicTripPlanner.ts` — filter out infeasible demands before enumeration.
- `src/server/services/ai/AIStrategyEngine.ts:770` — optionally surface infeasibility in the rendered `demandRanking` for the debug overlay (so users can see *why* a demand was excluded).
- Tests:
  - `src/server/__tests__/ai/context/DemandEngine.test.ts` — new test: demand whose supply city milepost is in `saturatedCityKeys` and not on bot's network → `isFeasible === false`. Same for delivery city. Same for on-network supply (NOT marked infeasible — bot already has access).
  - `src/server/__tests__/ai/DeterministicTripPlanner.*.test.ts` — new test: TripPlanner skips infeasible candidates and picks the next-best feasible one.
  - New replay-based test (or integration test) that constructs the turn-20 snapshot from game `32964f24` and asserts the bot emits a productive plan, not PassTurn.

## Test plan

- **Unit (DemandEngine)**:
  - Demand context with `supplyCity = 'Firenze'`, snapshot where (48, 44) ∈ `saturatedCityKeys` and not on bot's network → `isFeasible: false, infeasibleReason: 'supplyCitySaturated'`.
  - Same demand but bot already has track to (48, 44) → `isFeasible: true` (bot already grandfathered in; entering doesn't add a new player).
  - Demand context with `deliveryCity = 'Firenze'` (delivery side) → `isFeasible: false`.
  - Demand with neither supply nor delivery saturated → `isFeasible: true`.
  - No `saturatedCityKeys` passed → all demands `isFeasible: true` (backwards compatible).
- **Unit (TripPlanner)**:
  - Hand of 3 demands; one is infeasible. TripPlanner ranks the remaining two, picks the higher-scoring one.
  - All 3 demands infeasible → TripPlanner returns "no feasible route" outcome; downstream emits `DiscardHand` directly (no PassTurn first).
- **Replay**:
  - Build the snapshot at game `32964f24` turn 20 (S1 cash=16, position=(46,45), 9-commodity hand including Marble@Firenze, opponents have track at (48,44)). Assert: `demandRanking` excludes Marble@Firenze; plan output ≠ PassTurn.
  - Same at turn 48.
- **Regression**:
  - Existing `AIStrategyEngine.jira203.test.ts` still passes (lockup-recovery for transient strips remains intact).
  - Existing TripPlanner ranking tests still pass when `saturatedCityKeys` is empty (default behavior).

## Secondary cleanup (related but separable — DO NOT bundle into this ticket's commit)

While verifying root cause, several `computeBuildSegments` call sites were found that omit `saturatedCityKeys`:

- `src/server/services/ai/ActionResolver.ts:311-320` (waypoint-chained fallback)
- `src/server/services/ai/ActionResolver.ts:335-344` (resolver-disabled fallback)
- `src/server/services/ai/ActionResolver.ts:366-375` (parallel-path reroute)
- `src/server/services/ai/ActionResolver.ts:401-411` (region-duplication reroute)
- `src/server/services/ai/MovementPhasePlanner.ts:454-461` (A3 build-origin preview)

These weren't the direct cause of game `32964f24`'s failures (the upstream demand-pick is), but they represent latent leaks of the same concept. Track them in a separate ticket (`JIRA-232` or note in the next sweep). Consider refactoring `computeBuildSegments` to accept an options object instead of 10 positional args.

## Risks

- **Stale-hand syndrome**: if the bot holds 3 saturated-supply cards, it goes to `DiscardHand` immediately. That's the correct behavior — better than burning two turns each time the bot picks one. Acceptable.
- **Race condition**: an opponent could build into a small city between the demand check and the Phase B build. The JIRA-203 strip/lockup branch is the safety net for this; leaving it in place handles the race. The frequency is low (≪ 1% of turns).
- **`citiesOnNetwork` vs. raw key check**: feasibility uses "milepost in network.nodes" rather than name match. Reason: a major city has multiple mileposts; saturation isn't a concept for majors (they're 1-player-per-edge, not capped). Small/medium cities have unique mileposts, so the milepost-level check is correct.
- **City name → key resolution**: needs a name-to-coord lookup. Use the existing `gridPoints` array already passed into `computeAllDemandContexts`. The lookup is O(N) per demand but N is small (≈10 demand commodities × board size lookup).

## Estimated complexity

**Standard, low end.** One concept (saturation) flows through three additional files. ~50 LOC change + tests. Significantly smaller surface than the original proposal (which I scoped before identifying that Firenze itself was the blocker).
