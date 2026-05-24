# JIRA-230 — Trip planner pre-resolves supply per card and uses hex-distance approximations that ignore the bot's actual track (behavioral)

## Source

Surfaced 2026-05-11 during analysis of game `ad976b38-f43e-420d-bd57-775549f5a23e` turns 46-53. The user observed bot S3 picking up Bauxite at Budapest, delivering it to Berlin, then traveling far south to Sarajevo for Labor pickup, then retracing through the Berlin area on its way to deliver Labor at Holland. The human-obvious move was to pair the two — pickup Labor at Beograd (a closer supply city the bot already had track to), pickup Bauxite at Budapest, deliver Bauxite at Berlin, deliver Labor at Holland. The bot did neither: it picked Sarajevo (the further of two on-network supplies) and executed the trips sequentially.

JIRA-229 (two-trip aggregate look-ahead) was already in effect at the time. So this is not a question of "the planner can't see the follow-up cost." It's a question of which candidates the planner was even able to consider.

## Observed behavior (game ad976b38 evidence)

S3's relevant timeline:

| Turn | Bot at | Action | Notes |
|------|--------|--------|-------|
| t6-7 | — | Built track toward **Beograd** (28M total) | Beograd now on S3's network |
| t27 | — | Built track toward **Sarajevo** (12M) | Sarajevo now on S3's network |
| t46 | Budapest | Planner picks single Bauxite Budapest→Berlin | Score 6.0, runner-up #2 Labor single (aggregate 2.08 M/turn, "Lost by 0.00") |
| t47 | Budapest | Picks up Bauxite | |
| t48 | Berlin | Delivers Bauxite. Next replan picks single Labor Sarajevo→Holland | Top-3 runners are all singles; no Bauxite+Labor pair appears |
| t50 | Sarajevo | Picks up Labor (after southern detour from Berlin) | |
| t51+ | Northbound | Travels back through Berlin region to reach Holland | |

The t46 demand hand included both Bauxite (Budapest→Berlin, 14M) and Labor (Sarajevo→Holland, 23M as displayed). The `Labor Sarajevo→Holland` display reflects that supply was already pre-resolved by `DemandEngine.computeBestDemandContext` to a single chosen city; the underlying load is available at Beograd, Sarajevo, and Zagreb per `configuration/load_cities.json`.

Path-cost facts at t46 (bot at Budapest, fast_freight, 45M cash):

| Labor supply | On S3's network? | Approx hex from Budapest | Path Budapest → supply → Holland (hex) |
|--------------|------------------|--------------------------|----------------------------------------|
| Beograd | **Yes** (built t6-7) | ~8 | ~8 + ~37 = ~45 |
| Sarajevo | **Yes** (built t27) | ~11 | ~11 + ~35 = ~46 |
| Zagreb | No | ~6 | ~6 + ~18 = ~24 |

By raw hex math, Zagreb is the shortest total — but it requires fresh track. Of the two on-network options, **Beograd is dramatically closer to the bot's current position along existing track**, yet the planner picked Sarajevo. The reason is mechanical, not strategic (see "Why current algo doesn't see this" below).

## Why current algo doesn't see this

Two compounding defects in `src/server/services/ai/context/DemandEngine.ts:486-665`:

### Defect A — "On network or not" is binary; existing-track distance is invisible

`computeSingleSupplyDemandContext` (lines 522-527) collapses the cost-to-supply dimension to a coin flip:

```ts
estimatedTrackCostToSupply = isSupplyOnNetwork || !supplyCity || isLoadOnTrain
  ? 0
  : estimateTrackCost(supplyCity, snapshot.bot.existingSegments, gridPoints);
```

Both Beograd and Sarajevo are on the bot's network at t46, so both score `0` on cost-to-supply. The fact that traversing existing track from Budapest to Beograd is *materially shorter* than Budapest to Sarajevo (3 hops less) is thrown away. The two candidates appear equally cheap to the supply scorer.

`estimatedTrackCostToDelivery` has the same shape (line 525-527). Same defect on the delivery leg.

### Defect B — `travelTurns` uses raw hex distance, ignoring the bot's network

`travelTurns` (lines 585-622) is computed from `estimateHopDistance` (Chebyshev hex distance) summed across bot→supply and supply→delivery. This ignores:

- Existing built track (which the bot traverses without building, and where movement follows actual edges rather than straight hex lines)
- Terrain costs (clear=1M, mountain=2M, alpine=5M, water crossings +2-3M)
- Ferry crossings (a full turn lost to embark, half-rate movement after)
- Opponent track usage (costs 4M/turn but no build cost)

The number returned is geometric distance × time, not actual milepost-count along the best playable path. The Bauxite→Berlin leg from Budapest may pass through built track for most of its length but `estimateHopDistance` reports it as if every hex were equally costly to traverse.

### Combined effect at t46 between Beograd and Sarajevo

With cost-to-supply at 0 for both, the tiebreaker is the hex-summed `travelTurns`. Beograd (48,62) is 8 hops from Budapest (40,59) but 37 hops from Holland (21,37). Sarajevo (51,56) is 11 hops from Budapest but only 35 hops from Holland — slightly further west. Sarajevo's total hex sum is approximately 1 hop *less* than Beograd's because it's pulled west toward Holland. **The planner picked Sarajevo by this 1-hop margin in a metric that ignored the bot's actual track entirely.** A human counting mileposts along the bot's built corridor would have seen Beograd's path as drastically shorter in real movement turns.

### Defect C — Supply choice is frozen before pair/triple enumeration

`computeAllDemandContexts` (line 737) commits one supply per card before `DeterministicTripPlanner.enumerateCandidates` runs. `genSingles`, `genPairs`, `genTriples` (lines 314-534) all take `r.supplyCity` as a fixed string and build stops accordingly:

```ts
const pickA: RouteStop = { action: 'pickup', loadType: a.loadType, city: a.supplyCity! };
```

So when Labor's supply is pre-resolved to Sarajevo, **every** pair candidate involving Labor uses Sarajevo. The pair `Bauxite (Budapest) + Labor (Beograd)` — Budapest → Beograd → Berlin → Holland, a clean southward dip then northward sweep along existing track — is never enumerated. The planner literally cannot pick it because it doesn't exist as a candidate.

The diagnostic script `scripts/ai/analyze-t46-pairs.py` confirms this by enumerating all 12 pair variants (3 Labor supplies × 4 orderings) with the same `cheapPrune` math the planner uses. All 12 survive the spatial prune. Pair-via-Beograd is geometrically shorter than pair-via-Sarajevo on both legs. None of them get to compete because only the Sarajevo variant is generated.

### Defect D — `computeAggregateScore` double-counts the follow-up's travel-to-start

`DeterministicTripPlanner.computeAggregateScore` (line 741) sums:

```ts
const aggregateTurns = Math.max(c1.turns + emptyLegTurns + c2.turns, 1);
```

But `c2.turns` comes from `scoreCandidate` (line 605) calling `simulateTrip(startPos, candidate.stops, ...)` where `startPos = snapshot.bot.position` — the bot's actual current position. So `c2.turns` already includes the travel cost from `bot.position` to c2's first stop, plus c2's own execution. Adding `emptyLegTurns` (c1.end → c2.start) on top counts the arrival-at-c2.start twice: once via `bot.position → c2.start` (inside `c2.turns`) and once via `c1.end → c2.start` (in `emptyLegTurns`). In the chained trajectory, only the second path happens — the first is stale.

Concretely at t46 (bot at Budapest, c1 = single Bauxite ending at Berlin, c2 = single Labor starting at Sarajevo):

- `c2.turns` includes Budapest → Sarajevo (~3 turns) + Labor execution
- `emptyLegTurns` adds Berlin → Sarajevo (~2 turns)
- Aggregate counts both Sarajevo arrivals; should count only Berlin → Sarajevo
- Reported aggregate for chained singles = 2.08 M/turn (per t46 reasoning runner-up #2); the truthful aggregate is ~2.7 M/turn

This bias is systemic: any chain where `c2.start != bot.position` overstates `aggregateTurns` by the duration of `bot.position → c2.start`. Pairs are disproportionately affected because pair candidates frequently have `c2` start at a city geographically distinct from the bot's current location. Singles whose pickup is at `bot.position` (the easy case — pick up where you already are) are unbiased.

This bug exists independently of Defects A/B/C. Fixing the supply enumeration without fixing this would still leave the algorithm systematically biased against pairs in any scenario where the next-best follow-up doesn't start where the bot currently sits.

## Expected behavior

The architecture must give the route scorer the information a human counts on the map:

1. **Cost-to-supply and cost-to-delivery must reflect actual graph distance through the bot's existing track**, not a binary "on network" flag. A supply 5 hops along built track should score better than a supply 30 hops along built track, even though both are "on network."

2. **Turn estimates must use real path-finding through the bot's network**, not raw hex distance. A 10-hex straight line that crosses an alpine range or requires a ferry takes more turns than the same hex count along built coastal track. The simulator already has this capability (`findShortestBuildablePath` in `RouteDetourEstimator`) — supply selection should use it too.

3. **Supply choice must happen during route enumeration, not before.** For loads with multiple supply cities (Labor, Iron, Coal, Wine, Beer, Fish, Steel, Cars, Machinery, Tobacco, and others per `configuration/load_cities.json`), each route candidate must be enumerated against all valid supply combinations. The route scorer picks the best supply *for this route shape*, not the best supply *for this card in isolation*.

4. **`computeAggregateScore` must not double-count the follow-up's travel-to-start.** When chaining c1 → c2, the bot arrives at c2's first stop via c1.end → c2.start (the empty leg). The c2 trip's own execution turns must be computed *from c2.start* (or equivalently, c2.turns minus the bot.position → c2.start segment), not from `bot.position`. The aggregate formula must reflect the actual chained trajectory, not the standalone simulation reference frame.

The combination of (1) and (2) is what the user described as "counting mileposts" — accurate, graph-aware cost estimation rather than hex approximations. (3) is what lets the algorithm find the same pair geometry a human sees: "I'm at Budapest, my track goes south to Beograd, my next delivery is Berlin (north), my one after that is Holland (NW). Let me sweep Beograd → back through Budapest → Berlin → Holland in one trip." (4) is the corollary that lets the aggregate ranker compare candidates fairly: chains where the follow-up starts far from the bot's current position must not be punished for a leg the bot won't actually traverse in chained execution.

## Pressure-test predictions

Applied to the t46 hand in game `ad976b38`:

| Behavior | Current planner | Expected after fix |
|----------|----------------|-------------------|
| Labor supply chosen as single | Sarajevo | Beograd (closer along built track) |
| Pair Bauxite + Labor enumerated | Only via Sarajevo (and pruned/loses) | All 3 supply variants enumerated |
| Pair via Beograd survives | N/A (not generated) | Yes — short detour, mostly existing track |
| Aggregate-ranked winner at t46 | Single Bauxite | Pair Bauxite + Labor-via-Beograd |
| Turns to complete both deliveries | 7+ (sequential singles, t46-t53+) | ~4-5 (single pair execution) |

Applied as a sanity check to the broader game: every multi-supply load decision the bot makes today picks the supply that scores highest in single-trip isolation. After the fix, supply choice becomes route-dependent. In hands where two cards' supplies share a corridor with one of the deliveries, the joint pair geometry becomes competitive.

## Scope of this ticket

Tight to the structural defects observed:

1. Replace the binary "on network" cost calculation in `DemandEngine.computeSingleSupplyDemandContext` with graph-aware path costs (existing track = free for build; remaining segments = new track at terrain cost).
2. Replace `estimateHopDistance`-based `travelTurns` in supply selection with the same path-finding used by `simulateTrip` (`findShortestBuildablePath`), so turn estimates reflect actual movement along available edges.
3. Defer supply choice for multi-supply loads into route enumeration. `genSingles`, `genPairs`, `genTriples` must iterate supply combinations and emit one candidate per (route shape × supply choice) tuple.
4. Update spatial prune (`cheapPrune`) to use the same graph-aware cost path. Without this, the supply-aware enumeration would still be filtered by the old hex-approximation prune.
5. Fix `computeAggregateScore` to compute c2's chained turns from c1.end (or equivalently subtract the stale `bot.position → c2.start` segment from `c2.turns` before summing).
6. Acceptance test: a regression scenario reproducing S3's t46 hand from game `ad976b38` — planner MUST pick pair Bauxite (Budapest) + Labor (Beograd).

## Out of scope

- Changes to JIRA-229's aggregate ranking. The two-trip look-ahead is correct; this ticket gives it better candidates to rank.
- Changes to JIRA-227's prune cost-awareness for existing track. JIRA-227 already addressed one half of the existing-track cost issue (build estimate); this ticket extends the same logic to supply selection and to the path-finding side of the prune.
- New supply heuristics beyond "use the bot's actual track graph." No hand-tuned bonuses or penalties.
- Performance optimization beyond what the path-finding cache already provides. If supply enumeration plus graph-aware costing makes a replan exceed an acceptable budget, that's a follow-up.

## Acceptance

Behavioral regression test in `src/server/__tests__/ai/DeterministicTripPlanner.test.ts`:

**Scenario 1 — supply choice for single follows existing track**

Setup: bot at Budapest, fast_freight, network includes existing edges from Budapest → Beograd (built) and from Budapest → Sarajevo (built, but longer). One demand: Labor → Holland.

Assertion: planner's chosen candidate uses **Beograd** as Labor's supply (not Sarajevo), because the existing-track path Budapest→Beograd is shorter in movement turns than Budapest→Sarajevo.

**Scenario 2 — pair enumerated across supply variants**

Setup: same as Scenario 1 plus a second demand: Bauxite (Budapest) → Berlin (with existing track Budapest→Berlin).

Assertion: enumerated candidate set includes **at least three** pair variants — `Bauxite + Labor-via-Beograd`, `Bauxite + Labor-via-Sarajevo`, `Bauxite + Labor-via-Zagreb` — each with appropriate route stops.

**Scenario 3 — pair-via-Beograd wins under aggregate**

Setup: same as Scenario 2.

Assertion: chosen top-1 is the pair `Bauxite + Labor-via-Beograd` (any variant where Beograd is the Labor pickup city), not a single. Reasoning string mentions Beograd as Labor's chosen supply.

**Scenario 4 — turn estimate uses real path, not hex**

Setup: bot at Budapest. One demand: Hops (Cardiff) → Frankfurt. The Cardiff→Frankfurt path requires a ferry (English Channel) — a fact invisible to hex distance but accounted for by `simulateTrip`.

Assertion: pre-scoring `estimatedTurns` for this candidate includes the ferry cost (≥ +2 turns vs the same hex distance without ferry). Test must compare two candidates with the same hex length where one requires a ferry and one doesn't; the ferried one MUST have higher `estimatedTurns`.

**Scenario 5 — aggregate score does not double-count follow-up's travel-to-start**

Setup: bot at city A. c1 = single starting and ending at A (zero net travel; toy fixture). c2 = single starting at city B (distinct from A). simulator returns `c1.turns = T1`, `c2.turns = T2` where `T2` decomposes into `Tstart` (travel A → B) + `Texec` (c2's actual execution).

Assertion: `aggregateTurns` returned by `computeAggregateScore` MUST equal `T1 + (A → B empty leg) + Texec`, NOT `T1 + (A → B) + T2`. Test must construct a scenario where `Tstart > 0` and verify the aggregate is *less* than `c1.turns + emptyLegTurns + c2.turns` by exactly `Tstart`.

## Evidence

- `logs/game-ad976b38-f43e-420d-bd57-775549f5a23e.ndjson` — S3 events t6-50; build history shows Beograd built at t6-7 and Sarajevo built at t27; t46 hand shows Bauxite + Labor in hand simultaneously; t46 reasoning runners-up are all singles, no Bauxite+Labor pair.
- `scripts/ai/analyze-t46-pairs.py` — enumerates all 12 Bauxite+Labor pair variants using cheap_prune math; confirms all survive the spatial prune; ranks pair-via-Beograd-AB as geometrically shortest among feasible options.
- `configuration/load_cities.json:122-126` — Labor produced at Beograd, Sarajevo, Zagreb (three supply cities).
- `src/server/services/ai/context/DemandEngine.ts:522-527` — binary on-network track-cost computation.
- `src/server/services/ai/context/DemandEngine.ts:585-622` — `estimateHopDistance`-based travel-turn computation, ignores bot's network.
- `src/server/services/ai/context/DemandEngine.ts:725-732` — supply pre-resolution loop (one supply per card, before route enumeration).
- `src/server/services/ai/DeterministicTripPlanner.ts:367-368, 423-432` — `genPairs`/`genTriples` consume `r.supplyCity` as a frozen string.
- `src/server/services/ai/RouteDetourEstimator.ts:findShortestBuildablePath` — existing graph-aware path-finder; the right primitive to call from supply selection and from the prune.
- `src/server/services/ai/DeterministicTripPlanner.ts:741` — `aggregateTurns = c1.turns + emptyLegTurns + c2.turns` formula that double-counts c2's travel-to-start.
- `src/server/services/ai/DeterministicTripPlanner.ts:605` — `scoreCandidate` calls `simulateTrip(startPos, ...)` with `startPos = snapshot.bot.position`, embedding the stale `bot.position → c2.start` leg into `c2.turns`.
