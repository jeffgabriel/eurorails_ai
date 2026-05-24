# JIRA-237 — Two compounding model defects in the deterministic planner: (1) `computeAggregateScore` chains c1 and c2 using c2's pre-c1-state simulation; (2) `simulateTrip` returns turn counts ~2× game-rule reality. Together they invert the pair vs chained-singles ranking on a 0.03 M/turn tiebreaker (technical)

Companion to `jira-237-sameSupplyDoubleDemandNotConsolidated-behavioral.md`.

This ticket addresses TWO defects that must both be fixed for the deterministic planner to rank candidates by real game economics. The chained-aggregate model defect alone makes chained singles look BETTER under correction, not worse — the ranking flip in s1 t14 requires the turn-count fix as well.

- **Defect 1** localized at `computeAggregateScore` in `DeterministicTripPlanner.ts:878–966`.
- **Defect 2** localized at `simulateTrip` in `RouteDetourEstimator.ts:222–…` — turn counts inflated ~2× relative to game-rule milepost-divided-by-speed.

## Confirmed via verbatim planner reasoning

The s1 t14 row's `reasoning` field contains the planner's full output (quoted in the behavioral file). Key facts:
- Pair `pair:82-Potatoes+30-Potatoes:BA-sup:Szczecin-Szczecin` is Runner-up #2 at aggregate 1.19 M/turn.
- Chosen single is Runner-up #1 at aggregate 1.22 M/turn.
- Pair lost the rank key by 0.03 M/turn.
- Survivors after spatial prune: 75 of 605 raw — pair survived the prune cap (`turns > 12`).
- `Upgrade emitted: fast_freight (cost 20M, cash 49M, build 15M)` — confirms deterministic-planner upgrade emission is logged on the reasoning field. Incidentally resolves a JIRA-236 open question about which code path emits the upgrade.

## Root cause: c2 is simulated against bot's pre-c1 network, not the post-c1 network

`computeAggregateScore` at `DeterministicTripPlanner.ts:878`:

```ts
const c2ExecutionTurns = Math.max(c2.turns - c2BotToStartTurns, 1);
const aggregateTurns = Math.max(c1.turns + emptyLegTurns + c2ExecutionTurns, 1);
const aggregateNet = c1.net + c2.net;
const aggregate = aggregateNet / aggregateTurns;
```

`c2.net` and `c2.turns` come from `simulateTrip(startPos = bot.position, candidate.stops, snapshot)` at `DeterministicTripPlanner.ts:780`. That simulation:

- Starts the train at `bot.position` (pre-c1 position).
- Treats `snapshot.bot.network` (pre-c1 network) as the set of free-traversal edges.
- Runs Dijkstra to find the cheapest path through the demand-card stops, charging build cost for every hex NOT already on `bot.network`.

In the chained context, c1 has run first. The post-c1 reality is:

- The train is at c1.end, not bot.start.
- The network is `bot.network ∪ c1.builtSegments` — every hex c1 just laid is free to traverse and free to reuse.
- The cash floor is `bot.cash + c1.net`.

c2's REAL chained build cost is whatever new track Dijkstra needs to lay against the post-c1 network. **Existing track — wherever it lies on the post-c1 network, not only at the supply city — is free.**

The aggregation in `computeAggregateScore` corrects only for c1.end → c2.start movement (via `c2BotToStartTurns` strip and `emptyLegTurns` add). It does not correct for:

1. **c2.buildCost overcharges for any track c1 has built that c2 would reuse.** This is not limited to "the supply-city reach." Any segment of c2's path that lies on c1's built network is free in reality but charged in c2.standalone. Effect: c2.net under-stated; chained-singles aggregate under-stated.

2. **c2.turns overcharges for the build turns of that already-laid track.** `c2BotToStartTurns` strips MOVEMENT turns only (`hexDistance / speed`); it does not strip the build turns that c2.standalone spent laying track which c1 has now made unnecessary. Effect: c2ExecutionTurns over-stated; chained-singles aggregateTurns over-stated.

3. **c2's path itself is chosen against the wrong network.** Dijkstra from bot.start with bot's pre-c1 network picks a path that minimizes cost against THAT graph. Dijkstra from c1.end with the post-c1 network may pick a structurally different path because new corridors are free. c2.standalone may not even resemble c2's true cheapest chained-context path.

Effects (1), (2), and (3) all flow from the same structural error: c2 is simulated in the wrong world.

## What the corrected model should compute

For any chained pair (c1, c2), the aggregation should reflect the bot's actual execution: c1 in its scored form, then c2 simulated in c1's post-trip state.

| Quantity | Current model | Corrected model |
|----------|---------------|-----------------|
| c2 startPos | bot.position (pre-c1) | c1.endCity |
| c2 network | bot.network (pre-c1) | bot.network ∪ c1.builtSegments |
| c2 starting cash | bot.cash | bot.cash + c1.net |
| c2 buildCost | every new hex from bot.start to c2 stops | every new hex from c1.end to c2 stops, against c1-expanded network |
| c2 path | Dijkstra over pre-c1 network | Dijkstra over post-c1 network |
| c2 turnsToComplete | bot→c2.start movement + standalone build/travel | c1.end→c2.start movement + chained build/travel |
| aggregateNet | c1.net + c2_standalone.net | c1.net + c2_chained.net |
| aggregateTurns | c1.turns + emptyLeg + (c2_standalone.turns − c2BotToStartTurns) | c1.turns + c2_chained.turnsToComplete |

For s1 t14 the corrected aggregate will reflect real game economics. Whether the pair beats the chained singles after correction depends on the actual map geometry given s1's pre-c1 network state — but the ranking will then be determined by real cost, not by an arithmetic asymmetry in standalone scoring.

## Investigation already performed

1. Reviewed `DeterministicTripPlanner.ts:878–966` (`computeAggregateScore`) — confirmed the gap is structural: c2's standalone simulation is used unchanged for the chained aggregate. The JIRA-230 R2 hexDistance-symmetry adjustment is movement-only.
2. Reviewed `simulateTrip` signature at `RouteDetourEstimator.ts:222`: `(startPos: GridCoord, stopsInOrder: RouteStop[], snapshot: SnapshotInput, options?)`. A chained-context call passes `startPos = c1.end` and a `snapshot` whose `bot.position`, `bot.money`, and `bot.network` reflect post-c1 state. This is the natural shape — `simulateTrip` already takes the network from `snapshot` (it's used to detect existing edges during Dijkstra).
3. Confirmed pair enumeration at `DeterministicTripPlanner.ts:470–533` — `pair:82-Potatoes+30-Potatoes:BA-sup:Szczecin-Szczecin` appears in the planner's reasoning as Runner-up #2 with NET 26M, 12 turns. Enumeration is not the defect.

## Fix shape — Full chained re-simulation

The structural error requires a structural correction. In `computeAggregateScore`, for each candidate follow-up c2 being evaluated against c1, invoke `simulateTrip` with the post-c1 state:

```ts
// Build the post-c1 snapshot once per c1 (outside the c2 loop).
const c1EndCoords = nearestCityCoord(c1.stops[c1.stops.length - 1].city, …);
const postC1Network = unionSegments(snapshot.bot.network, c1.builtSegments);
const postC1Snapshot: SnapshotInput = {
  ...snapshot,
  bot: {
    ...snapshot.bot,
    position: c1EndCoords,
    money: snapshot.bot.money + c1.net,
    network: postC1Network,
    // trainType remains as upgraded by c1 if applicable; pendingUpgradeCost = 0 for c2.
  },
};

for (const c2 of allFeasible) {
  if (overlap(c1, c2)) continue;

  const c2Chained = simulateTrip(c1EndCoords, c2.stops, postC1Snapshot);

  const aggregateTurns = Math.max(c1.turns + c2Chained.turnsToComplete, 1);
  const aggregateNet = c1.net + computeNetFromSimulation(c2, c2Chained);
  const aggregate = aggregateNet / aggregateTurns;
  …
}
```

No separate `emptyLegTurns` or `c2BotToStartTurns` adjustment is needed — `c2Chained.turnsToComplete` already includes the c1.end → c2.start segment as its initial movement, against the post-c1 network.

The pair's own aggregate gets the same treatment: when c1 = pair, its follow-up c2 is also re-simulated in the post-pair state. Same rule applied uniformly.

### Required supporting work

- **`ScoredCandidate.builtSegments`** — `scoreCandidate` (at `DeterministicTripPlanner.ts:760`) must surface the list of segments c1 builds (as `pathToNewSegments` returns them from `simulateTrip`'s internal Dijkstra). Add a field `builtSegments: ReadonlyArray<{ row, col }>` (or similar) to `ScoredCandidate` and `TripSimulation`.
- **`unionSegments` helper** — combine `snapshot.bot.network` with `c1.builtSegments` into the synthetic post-c1 network. The shape of `snapshot.bot.network` needs to be confirmed; if it's a `Set<edgeKey>`, the helper is a set-union.
- **Train type post-c1** — if c1 emitted an upgrade (`upgradeOnRoute`), the post-c1 snapshot's `bot.trainType` should reflect the upgraded type. Affects c2's speed and capacity in its simulation.

### Cost and feasibility

`computeAggregateScore` is O(N²) where N = feasible candidates (typical 30–100 per the function's docstring). The current implementation runs N comparisons per c1 — N² total simulateTrip-equivalent work would result if we re-simulate for every pair. But the inner loop only needs ONE post-c1 snapshot per c1; build it once, reuse it across all c2 candidates for that c1. That brings the work to N (snapshot builds) + N² (simulateTrip calls). The reasoning log for s1 t14 shows `enumerationMs=5003` already, so there is some headroom; profile and optimize if needed.

If profiling shows the N² simulateTrip cost is prohibitive, optimization paths exist:
- Cache c2's chained simulation result keyed by `(c2.id, post-c1-network-hash)` — many c1 candidates produce overlapping post-c1 networks.
- Prune the c2 search to top-K candidates by standalone score before running chained re-simulations.

These are optimizations, not changes to the model's correctness.

## Why not a "supply-city only" approximation

A cheap targeted fix that only corrects for the shared supply city (subtract bot.start→supply build cost and build turns from c2) would close the specific s1 t14 defect, but is wrong in general. It assumes the only network sharing between c1 and c2 is the supply city — false whenever c1's build expands the bot's network in a direction that c2's path passes through. For any chained trip where c2's path overlaps c1's built corridor beyond the supply city, the supply-city-only correction still undercharges c2 in reality (and overcharges in the model).

The structural fix above costs more but is the only model that produces correct aggregates across general chained trip pairs.

## Defect 2 — `simulateTrip` turn counts ~2× game-rule reality

### Evidence

For s1 t14 the planner reports:

| Trip | Planner turns | Game-rule estimate (fast_freight, 12 mp/turn) |
|------|--------------|---------------------------------------------|
| single:30 Paris (bot → Szczecin → Paris, ~44 mp) | 8 | ~4 |
| single:82 Marseille (bot → Szczecin → Marseille, ~50 mp) | 9 | ~4–5 |
| pair (bot → Szczecin → Paris → Marseille, ~64 mp) | 12 | ~6 |

Each candidate's reported `turnsToComplete` is roughly 2× a milepost-divided-by-speed calculation. The inflation is consistent across candidates, which means relative-velocity comparisons are partially preserved — but absolute velocities are halved, so the threshold for small modeling asymmetries (like Defect 1's residual) to flip rankings is much lower.

### Candidate causes to investigate inside `simulateTrip`

1. **Pre-upgrade speed used when post-upgrade is correct.** The c1 candidate emits an upgrade (`Upgrade emitted: fast_freight (cost 20M, cash 49M, build 15M)`). If `simulateTrip` reads `snapshot.bot.trainType` once at the start and never re-reads after the upgrade emission, it uses Freight speed (9) for the whole trip even when fast_freight (12) is the realistic speed post-emission. For c2 standalone the snapshot's trainType is definitely pre-upgrade Freight — same effect.
2. **Serialized build-then-move within a turn.** Game rule: "FIRST, operate their train" → move first, then build. The simulator may model build and move as serial across separate turns (build turn N, move turn N+1) instead of within the same turn. Each turn the bot can move on existing track AND lay up to 20M of new track; movement on existing portions of the path doesn't wait for new track.
3. **Over-charging ferry / water-crossing / terrain turn cost.** If the simulator adds turn-cost for each ferry crossing, mountain, or major-city traversal (instead of charging ECU cost only), turn counts inflate without movement-budget basis.
4. **Pickup / deliver counted as a movement step.** Game rule says pickup/delivery does NOT reduce movement allowance ("Picking up or unloading a load does not reduce movement"). If the simulator decrements movement on pickup/deliver, each stop costs an extra fraction-of-turn that aggregates.

### Investigation plan

1. Build a minimal fixture: bot at a known city with empty network, fast_freight (speed 12), one demand card with supply and delivery cities at known hex distances. Run `simulateTrip` and check `turnsToComplete` against the milepost calculation.
2. Pick one of s1 t14's actual candidates (e.g. single:30 Paris). Reconstruct the snapshot from the game log (`positionStart`, network from prior `actionTimeline` entries, hand, train). Run `simulateTrip` and inspect:
   - `trainSpeed` value used internally (`RouteDetourEstimator.ts:231–232`).
   - Whether `pendingUpgradeCost` propagation triggers a post-emission speed change.
   - Per-leg turn breakdown — where does the inflation accrue?
3. Compare against `computeBuildSegments` and the route-executor's actual in-game turn consumption (per `actionTimeline` data — bot reaches Paris in 5 actual turns from t14 to t16, vs. the planner's predicted 8). The discrepancy between predicted and actual real-game turn count is the smoking gun.

### Fix shape — `simulateTrip` turn counting

Pending investigation. Likely a small set of corrections inside `simulateTrip` (line `RouteDetourEstimator.ts:222`+):

- Honor post-upgrade speed when `pendingUpgradeCost > 0` (treat the upgrade as applied from turn 0 onward).
- Parallelize build and movement within a turn: each turn allows up to 20M build AND up to speed mp movement on built track (including newly-built-this-turn segments at the cost of the move-then-build ordering).
- Treat pickup/deliver as cost-free per game rules.

The fix should drive predicted `turnsToComplete` to within ±1 turn of the milepost/speed calculation for unobstructed routes.

### Interaction with Defect 1

The two defects are independent in mechanism but compound in effect. Defect 1's NET correction alone raises chained-singles aggregate (1.22 → 1.44 within inflated turns); the pair's correction may or may not exceed that. Defect 2's turn fix alone halves all turn counts, expanding velocity gaps roughly 2× — which makes the pair's standalone advantage (4.33 vs 2.89 M/turn real) decisive regardless of follow-up specifics. **Both fixes ship together** because either alone leaves the planner's ranking outcomes unreliable.

## Secondary defect — opportunistic pickup miss at supply city

Independent of the planner fix, `a1-opportunistic` at `ActiveRouteContinuer` should pick up additional in-hand demand-card loads at the planned supply city when capacity allows. composition.a1.citiesScanned = 0 at t16 means the scanner did not run at the planned-pickup city (it likely runs only at non-planned cities). Fix: extend the scanner to also evaluate same-city extra loads at the planned pickup, gated on `freeSlots > 0` and `loadAvailableAtCity(loadType, city)`.

This is a separate, smaller fix that would have salvaged s1 at t16 even without the planner correction. File location to confirm: `ActiveRouteContinuer.ts` (the file emits the actor label at `AIStrategyEngine.ts:872`).

## Test coverage

**Defect 1 — chained-aggregate model**
- `DeterministicTripPlanner.test.ts` — reconstruct s1 t14 snapshot (position, cash 29, train Freight cap 2 before upgrade, network reflecting s1's actual pre-t14 track from the game log, the full 9-card hand). Run `planTripDeterministic`. Assertion: with BOTH defects fixed, top-1 is the pair candidate OR a candidate whose REAL chained execution beats the pair's REAL chained execution.
- Unit test for the corrected `computeAggregateScore` in isolation: synthesize c1 with a known `builtSegments` set, synthesize c2 whose Dijkstra-optimal path against `bot.network ∪ c1.builtSegments` is materially cheaper than against `bot.network` alone. Assert that the aggregate uses the chained (cheaper) c2 cost.
- Unit test: c1 and c2 share supplyCity. Assert that c2's chained simulation is invoked from c1.end with the post-c1 network, and that the resulting c2.buildCost is strictly less than c2.standalone.buildCost.

**Defect 2 — simulateTrip turn counting**
- `RouteDetourEstimator.test.ts` — empty-network fixture, bot at known coord, fast_freight (speed 12), one demand at distance 12 mp and one at 24 mp. Assert `turnsToComplete` matches milepost / speed ±1.
- `RouteDetourEstimator.test.ts` — fixture with `pendingUpgradeCost > 0` (Freight → fast_freight). Assert simulated turns use post-upgrade speed (12), not pre-upgrade (9).
- `RouteDetourEstimator.test.ts` — fixture where build cost (4M) and movement budget (12 mp) easily fit in one turn. Assert the leg consumes 1 turn, not 2 (build parallel to movement, not serial).
- Regression: feed s1 t14's single:30 stops through `simulateTrip`. Assert `turnsToComplete` ≤ 5 (vs current 8).

**Secondary**
- `ActiveRouteContinuer.test.ts` — bot at Szczecin, planned pickup Potatoes for Paris route, hand also contains Potatoes for Marseille, capacity 2. Assert `PickupLoad` emitted for the second Potatoes.

## Out of scope

- Triples or longer shared-supply chains. Same correction applies but ticket scope is the two-card case only.
- LLM-path same-supply consolidation — separate path.
- Phase-tilt or category-tilt tuning. The defect is in the chained-cost model, not in the scoring weights.
- Generalization beyond the s1 t14 observation. If the bug shows up in another game with materially different shape, file a separate ticket per the standing single-observation rule.
