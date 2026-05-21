# JIRA-214 — Technical: Post-pickup advisor + reusable RouteDetourEstimator helper

See `docs/jira/jira-214-behavioral.md` for the observed behavior.

## Summary of the change

Two pieces, in a single PR because the consumer (advisor) makes no sense without the producer (helper) and vice versa:

1. **New helper** `src/server/services/ai/RouteDetourEstimator.ts` — pure functions for path-cost and trip-simulation. Reusable by future BuildAdvisor / TripPlanner / Kaliningrad-loop fixes.
2. **Repurposed advisor** `src/server/services/ai/RouteEnrichmentAdvisor.ts` — same class, same schema, new trigger point (post-pickup, per-city in Phase A), new prompt (narrow per-city candidate list with detour data baked in), new `applyDecision` that propagates per-stop detour metadata into the route. The two existing fire sites are deleted.

## Why this scope

The detour-cost helper is the centerpiece: every advisor that asks the LLM "should we adjust this route?" has been failing the same way — speculating in token-space without grounded numbers. JIRA-214 fixes the most acute case (the route-enrichment advisor's bad-call loop) and ships the reusable helper so follow-on work can pick it up cleanly.

Out of scope for this JIRA but unblocked by it:

- **JIRA-X (follow-on)** BuildAdvisor uses `simulateTrip` for turn-cost-aware target selection.
- **JIRA-Y (follow-on)** TripPlanner uses `simulateTrip` for candidate scoring and Kaliningrad-loop unreachability detection — the same simulator returning `feasible: false` is the natural signal `BuildRouteResolver.selectCandidate`'s silent `closest-to-target-fallback` (`src/server/services/ai/BuildRouteResolver.ts:335-344`) is missing today.

## Component 1: `RouteDetourEstimator`

New file `src/server/services/ai/RouteDetourEstimator.ts`. Three exported pure functions and one type.

### `estimateRouteSegment(from, to, snapshot)`

Self-contained, returns:

```ts
interface RouteSegmentEstimate {
  newSegments: TrackSegment[];   // segments that need to be built
  buildCost: number;             // ECU M, sum of new segment terrain+water costs
  pathLength: number;            // total mileposts the bot will traverse: existing-track edges + new segments
  reachable: boolean;            // false when no path exists from `from` to `to` under current track + occupation
}
```

Implementation: a private `findShortestBuildablePath(from, to, snapshot)` Dijkstra inside `RouteDetourEstimator.ts` over the hex grid with the same edge-weight rules `computeBuildSegments` uses today (clear=1M, mountain=2M, alpine=5M, water/ferry surcharges, opponent edges from `ActionResolver.getOccupiedEdges` impassable, bot's `existingSegments` cost 0). It returns the full `Coord[]` path (or empty when unreachable). `estimateRouteSegment` then walks the returned path:

- Edges in `snapshot.bot.existingSegments` → contribute 1 to `pathLength`, 0 to `buildCost`.
- Edges not in that set → contribute 1 to `pathLength`, terrain+water cost to `buildCost`, and append a `TrackSegment` to `newSegments`.

`computeBuildSegments` itself is **not modified** — keeping the change scoped to the new file avoids broadening blast radius into a shared utility used by other callers (`MovementPhasePlanner.ts:402` A3 build-origin preview, `BuildAdvisor`, etc.). The duplicated Dijkstra core (~80 lines) is a deliberate choice: cheap to write, cheap to maintain, and if a future JIRA needs both callers to share it we factor out then. The single-element `targetWaypoints` call shape used by `computeBuildSegments` at `MovementPhasePlanner.ts:402` confirms our Dijkstra's input contract is sound; we copy the same edge-weight semantics to stay consistent.

### `simulateTrip(startPos, stopsInOrder, snapshot)`

Turn-by-turn simulator returning:

```ts
interface TripSimulation {
  turnsToComplete: number;
  totalBuildCost: number;
  feasible: boolean;             // false if any leg is unreachable per estimateRouteSegment
}
```

The simulator first computes the full path as a sequence of `RouteSegmentEstimate` results (one per consecutive pair of stops, plus `startPos → stops[0].city` for the leading leg). Each leg may include both existing-track edges (free movement) and new segments (must be built before traversal).

Then it walks the path turn by turn under the real game per-turn caps:

```
per turn:
  1. Move up to `trainSpeed` mileposts forward along edges that are already in the bot's
     network (existing edges + new segments built in earlier turns of this simulation).
  2. Build up to TURN_BUILD_BUDGET (20M) of new track. Build extends the bot's network
     from its current frontier; new segments become available for movement starting
     **next turn** (game rule: move-then-build ordering within a turn).
  3. Stop the simulation when the bot has traversed all stops in order.
```

Each leg's `RouteSegmentEstimate.reachable === false` immediately marks the simulation `feasible: false`. This is the signal future consumers (BuildAdvisor, Kaliningrad-loop fix) will use to abandon a target instead of silently best-effort-ing.

### `computeCandidateDetourCosts(currentCity, candidates, route, snapshot)`

The driver that returns `CandidateDetourInfo[]` for the LLM prompt:

```ts
interface CandidateDetourInfo {
  loadType: string;
  deliveryCity: string;
  payout: number;
  cardIndex: number;
  bestSlotIndex: number;          // where in route.stops to splice the DELIVER
  marginalBuildM: number;         // (sim with D) − (sim without D) in build cost
  marginalTurns: number;          // (sim with D) − (sim without D) in turn count
  feasible: boolean;
}
```

For each candidate `(loadType, deliveryCity, payout)` and each insertion slot `i ∈ [0, route.stops.length]`:

1. Build `stopsWithoutD = route.stops.slice(currentStopIndex)` (the bot's remaining itinerary).
2. Build `stopsWithD = stopsWithoutD` with a synthetic DELIVER stop for `(loadType, deliveryCity)` inserted at slot `i`.
3. `simWithD = simulateTrip(currentCity, stopsWithD, snapshot)`
4. `simWithoutD = simulateTrip(currentCity, stopsWithoutD, snapshot)` (memoize across slots — identical input)
5. `marginalBuildM[i] = simWithD.totalBuildCost − simWithoutD.totalBuildCost`
6. `marginalTurns[i] = simWithD.turnsToComplete − simWithoutD.turnsToComplete`
7. Skip if `simWithD.feasible === false`.

Pick `bestSlotIndex = argmin over i of (marginalBuildM[i] + marginalTurns[i] × OPPORTUNITY_COST_PER_TURN_M)`. If no slot is feasible, omit the candidate from the returned list.

The simulator handles all the per-turn-cap subtlety the user flagged earlier — `marginalTurns` is the difference between two simulations, both of which apply build/move parallelism and the build-leads-movement ordering correctly.

### Constants and provenance

Two named constants live in `RouteDetourEstimator.ts`. Their values are deliberate, with documented rationale:

```ts
/**
 * Imputed ECU cost of one extra turn, used to compare candidates with
 * different (build, turn) trade-offs in slot selection.
 *
 * Provenance: `CLAUDE.md` strategic principle — "Income velocity matters
 * more than payout size; 7.5M/turn beats 4M/turn over time." The bot's
 * realistic per-turn income range from `scripts/ai/game-analysis.ts`
 * Section 9 across recent games is roughly 2.5–5.6M (loser–winner band).
 * 5M is a conservative midpoint: high enough to penalize +1-turn detours
 * meaningfully, low enough not to over-penalize when payouts are also high.
 */
const OPPORTUNITY_COST_PER_TURN_M = 5;

/**
 * Hard ceiling on extra turns a single insertion may cost. Candidates
 * exceeding this are filtered out before the LLM sees them.
 *
 * Provenance: any 4+ turn detour is no longer a piggyback on the current
 * trip — it's a separate trip, and `PostDeliveryReplanner` will produce
 * a better full-route plan from scratch once the current delivery completes.
 * Keeping this advisor focused on "this trip" semantics is what makes the
 * narrow prompt work.
 */
const MAX_DETOUR_TURNS = 3;
```

A third number — the "0.6 × payout" ratio — appears only in the system prompt as guidance text for the LLM, not as a code-side gate. Filter conditions 4 and 5 are the hard gates; the ratio is a soft signal so the LLM can apply judgment between candidates that all pass the gates. Deliberately not extracted to a code constant because the LLM is the consumer and tuning the wording matters more than tuning the number.

### Memoization

Within a single `computeCandidateDetourCosts` call, the same `simulateTrip(currentCity, stopsWithoutD, snapshot)` is invoked repeatedly. Memoize on the stop list identity (it's the same across all slots for a given candidate, and shared across all candidates). Likewise, `estimateRouteSegment(X, Y, snapshot)` results are reused across different `(D, slot)` combinations; cache them in a `Map<string, RouteSegmentEstimate>` keyed on `${X.row},${X.col}-${Y.row},${Y.col}` for the duration of the call.

Per advisor invocation, expected workload: K=4 candidates × ~3 slots × 2 simulations + caching → roughly 5–10 unique `simulateTrip` calls and 20–40 unique `estimateRouteSegment` calls. Total: < 100ms on a 50×50 grid. Trivial against the 3-second LLM call that follows.

### Latency profile

Worst-case turn: bot visits 4 distinct cities in Phase A, each with viable candidates passing the pre-LLM filter → 4 sequential LLM calls × ~3s = ~12s of Phase A wall-clock latency, on top of the bot's existing per-turn latency.

Expected case: most city visits produce zero candidates (no matching unfulfilled demand at this city, train at full capacity, or detour > 3 turns) and skip the LLM entirely. From `b1dc793c` (recent game), bots average ~2 cities visited per turn with action; most of those visits would see the LLM call short-circuited at the filter. Expected p50 latency added: 0–3s per turn.

Deliberately not preemptively bounded — adding a per-Phase-A-cap would be optimizing for a hypothetical. If real games show that demand-rich corridors push consistent multi-call turns, a follow-up can add a per-turn cap. Until then, accept the worst-case as bounded and acceptable for a hobby project.

## Component 2: `RouteEnrichmentAdvisor` repurposed

### Trigger placement

Hook in `MovementPhasePlanner.ts` (the file that owns Phase A's stop-execution loop). After each pickup/deliver/drop action commits at the bot's current city, peek at the next pending stop:

- Same-city next stop → continue (more planned actions at this city).
- Different-city next stop, OR no next stop, OR Phase A about to terminate → fire the advisor at the bot's current city before any move-to-next-city plan is emitted.

The advisor call is async; it must be awaited inside Phase A so any LLM-suggested insertions are spliced into `route.stops` before the bot's movement loop continues to the next stop.

### Trigger semantics: pickup, deliver, drop

Although this JIRA's headline framing is "post-pickup double-delivery," the trigger fires after **any** per-city action sequence completes, not just pickups. The candidate filter (which checks "this city supplies a load matching an unfulfilled demand card AND a slot is free") naturally handles all three action types identically:

- **Post-PICKUP**: the canonical case. Bot just loaded its planned cargo; advisor finds other matching loads at the same supply city. This is the dominant pattern in the behavioral doc.
- **Post-DELIVER**: bot just delivered, freeing a load slot. If the deliver city also happens to supply a load matching another unfulfilled demand card, that candidate surfaces. Conceptually a "find return load while you're here" pattern; mechanically identical to the pickup case from the advisor's standpoint.
- **Post-DROP**: rare in normal play. If it occurs, same filter applies and the same candidate enumeration runs.

Filter condition 1 (`currentCity` supplies the demand card's `loadType`) is the one that gates this — at a pure delivery city that supplies nothing the bot has demand for, no candidates pass and the LLM is never called. So the broader trigger costs nothing in cases where the deliver/drop semantics don't apply.

The two existing fire sites are deleted:

- `src/server/services/ai/NewRoutePlanner.ts:241` — remove the `RouteEnrichmentAdvisor.enrich` call and its surrounding try/catch.
- `src/server/services/ai/AdvisorCoordinator.ts:63-71` — `adviseEnrichment` is unused after this change; remove the method, and the `import { RouteEnrichmentAdvisor }` line at the top of `AdvisorCoordinator.ts`.
- `src/server/services/ai/PostDeliveryReplanner.ts:153` — remove the `AdvisorCoordinator.adviseEnrichment` call and the surrounding try/catch.

### Pre-call filter

Before invoking the LLM, `RouteEnrichmentAdvisor` enumerates demand cards from `context.demands` and applies these conditions in order. The first failing condition causes the candidate to be dropped without further evaluation:

1. `snapshot.loadAvailability[currentCity]` includes `demand.loadType` AND `demand.supplyCity?.toLowerCase() === currentCity.toLowerCase()` — the city actually supplies this load on this card.
2. The active route does **not** already contain a DELIVER stop for `(demand.loadType, demand.deliveryCity)` — this card isn't already in the plan.
3. `snapshot.bot.loads.length < snapshot.bot.trainCapacity` — the train has a free slot post-pickup.
4. `marginalBuildM ≤ snapshot.bot.money` — the bot can afford the marginal build cost.
5. `marginalTurns ≤ 3` — sanity bound on detour size.

Conditions 4 and 5 require the per-candidate `CandidateDetourInfo` from `computeCandidateDetourCosts`; conditions 1, 2, 3 are pure data checks and are cheaper, so apply them first to short-circuit before invoking the simulator.

If the resulting list is empty after all filters, skip the LLM call entirely and log `[RouteEnrichmentAdvisor] no viable candidates at <city>`. No API spend.

### New `buildPrompt`

Replace the body of `RouteEnrichmentAdvisor.buildPrompt` (`src/server/services/ai/RouteEnrichmentAdvisor.ts:240-278`).

System prompt:

> You are advising a bot mid-trip at a pickup city. The bot has just loaded its planned cargo. The same city offers additional loads matching the bot's demand cards. For each candidate you have the marginal build-cost (ECU M) and marginal turn detour for adding both a free pickup here and the deliver leg to the route.
>
> Decide:
>
> - `keep` — current route is best
> - `insert` — splice additional pickup+deliver pairs into the route
> - `reorder` — rearrange existing stops (rarely useful here)
>
> Heuristic: choose `insert` only when, for at least one candidate, `marginalBuild + (marginalTurns × ~5M/turn) < ~0.6 × payout`.

User prompt structure (illustrative, not literal output):

```
At: Ruhr
Cash: 35M
Train: Freight, capacity 2, slot free: 1
Carrying: [Steel]
Route remaining:
  1: DELIVER Steel at Krakow (20M)

Additional loads available here that match your demand cards:
  Coal → deliver Frankfurt (18M) — detour 8M / 2 turns, insert deliver after stop 1
  Iron → deliver Wien     (25M) — detour 14M / 3 turns, insert deliver after stop 1

Should we extend the route? Respond JSON only.
```

No corridor map, no unrelated demand cards, no full hand dump. Token count of the user prompt drops from ~3,500 chars (current) to ~600-1000 chars depending on candidate count.

### Schema

Existing `RouteEnrichmentSchema` (`src/server/services/ai/schemas.ts:142-212`) is unchanged. The schema's `decision: 'keep' | 'insert' | 'reorder'` and `insertions[]` array already accommodate the new prompt's output shape.

Optional addition: an `expectedDetourCost?: number` field on `RouteEnrichmentInsertion` so the LLM can echo back the detour cost it factored in (used for sanity-check logging only — we trust our own number for downstream gating). This was in the earlier-draft spec; keep it as an optional field for diagnostics.

### `applyDecision`

Modify `RouteEnrichmentAdvisor.applyDecision` (`src/server/services/ai/RouteEnrichmentAdvisor.ts:143-237`):

- For each LLM-proposed insertion, look up the matching `DemandContext` in `context.demands` for `(loadType, deliveryCity)` and the matching `CandidateDetourInfo` for `(loadType, deliveryCity)`.
- Build the new `RouteStop` with `payment` and `demandCardId` from the demand context, and `insertionDetourCostOverride` set to `CandidateDetourInfo.marginalBuildM`.
- Splice a free PICKUP at the current city ahead of the LLM-named slot, and the DELIVER at the LLM-named slot.
- Run `RouteValidator.validate` on the modified route. If validation rejects (or the validator returns `prunedRoute` that strips the new stops), revert to the unmodified route and log the validator's reason per-stop.

### `RouteStop.insertionDetourCostOverride`

Add the optional `insertionDetourCostOverride?: number` field to `RouteStop` in `src/shared/types/GameTypes.ts:454`. `RouteValidator.checkCumulativeBudget` (`src/server/services/ai/RouteValidator.ts:287-342`) prefers this value over `demand.estimatedTrackCostToSupply` / `estimatedTrackCostToDelivery` when present (`!= null`). Existing callers that don't set the field see no behavior change — pure addition.

#### Lifecycle

- **PostDeliveryReplanner**: when `TripPlanner` produces a fresh `StrategicRoute` after a delivery completes, the new `RouteStop` instances are constructed without the override field. `RouteValidator.checkCumulativeBudget` falls back to `demand.estimatedTrackCostToSupply` / `Delivery` for those stops. This is correct: once a load is consumed, the marginal-detour reasoning at insertion time is no longer load-bearing.
- **Persistence across turns**: `StrategicRoute` is held on `BotState` and round-trips through JSON serialization between turns. The optional numeric field serializes naturally; no schema migration needed. The existing `BotState` round-trip test should be extended to cover the new field.
- **Re-evaluation by subsequent advisor calls**: when the same advisor fires again later in the same trip, existing stops keep their override values (set at insertion time, immutable thereafter). New candidates evaluated by the new invocation get fresh override values from the current `computeCandidateDetourCosts` run. We deliberately do **not** recompute overrides on existing stops even if the bot's network has grown since insertion (which would make the original detour cheaper than recorded). The override is a one-shot annotation, not a live estimate; worst case is the validator slightly over-budgets a cumulative check, which keeps the bot cautious. Add freshness later if real games show the validator pruning otherwise-feasible insertions due to stale overrides.

### Logging

```
[RouteEnrichmentAdvisor] candidates at <city>: <load> detour=<N>M/<T>t payout=<P>M; ...
[RouteEnrichmentAdvisor] no viable candidates at <city> — skipping LLM call
[RouteEnrichmentAdvisor] LLM decision: <decision>, +<N> stops
[RouteEnrichmentAdvisor] applied: picked up <load> at <city>, deliver inserted after stop <i>
[RouteEnrichmentAdvisor] detour echo divergence: <load>@<city> LLM=<X>M computed=<Y>M (Δ=<Z>%)   // emitted only when |Δ| > 30%
[RouteEnrichmentAdvisor] validator pruned insertion <load>@<city>: <reason>
[RouteEnrichmentAdvisor] keep — LLM rejected all candidates: <reasoning>
[RouteEnrichmentAdvisor] failed (<reason>), keeping original route
```

### Deliberate omissions (v1)

- **Same-city repeat-fire guard**: if the bot lingers at a city across turns (ferry-blocked, no movement budget, etc.), the advisor may fire again next turn with similar candidate inputs and the LLM may produce a similar response. Not handled in v1 — rare case, not visible in current logs. Add tracking on the `StrategicRoute` (e.g., `advisorFiredAtCities: Set<string>`) if it becomes a real cost.

## Test strategy

Unit tests in `src/server/__tests__/ai/`:

### `RouteDetourEstimator.test.ts` (new)

- `estimateRouteSegment` returns `reachable: false` when target is blocked by opponent track and no alternative path exists.
- `estimateRouteSegment` returns `buildCost: 0, pathLength > 0` when the path lies entirely on existing bot track.
- `estimateRouteSegment` returns positive `buildCost` and correct `pathLength` for a mixed path (some existing edges + some new segments).
- `simulateTrip` returns `turnsToComplete: N + 1` when a `K`-mile new-build leg fits into a single turn's build budget but requires the next turn to traverse (build-leads-movement-by-1-turn case).
- `simulateTrip` returns `turnsToComplete = max(buildTurns, moveTurns)` when both budgets bind in parallel.
- `simulateTrip` returns `feasible: false` when any leg is unreachable.
- `computeCandidateDetourCosts` returns empty list when input candidates is empty.
- `computeCandidateDetourCosts` skips candidates where every slot is infeasible.
- `computeCandidateDetourCosts` selects `bestSlotIndex` minimizing `marginalBuildM + marginalTurns × 5M` across slots.

### `RouteEnrichmentAdvisor.test.ts` (extend existing)

- Trigger fires post-pickup before move to a different city (mocked LLM, mocked grid).
- Trigger does NOT fire when next stop is at the same city.
- Trigger does NOT fire when no candidates pass the pre-LLM filter — assertion: `brain.providerAdapter.chat` not called.
- User prompt contains the "Additional loads available here" heading and rows in `marginalBuildM` ascending order, capped at top candidates.
- User prompt does NOT include a corridor map.
- LLM `insert` decision applied: returned route has the new stops with `payment`, `demandCardId`, `insertionDetourCostOverride` populated, and validator round-trip preserves them when detour is small.
- LLM `insert` decision rejected by validator: returned route reverts to original, log line with validator's reason emitted.
- Same-resource-second-copy case: bot has two `Flowers` demand cards (different deliveryCities), arrives at Holland having picked up chip 1, advisor surfaces the second card's deliver as a candidate.
- Already-in-plan case: route already has DELIVER stop for `(loadType, deliveryCity)`, candidate filter drops the row, no LLM call.
- Snapshot stability across the LLM round-trip: `applyDecision` uses the `CandidateDetourInfo` captured at advisor entry (synchronously, before the LLM call), not re-derived from the snapshot at apply time. Assert that the `insertionDetourCostOverride` value on the inserted stop equals the `marginalBuildM` from the prompt-time candidate info, even if a hypothetical concurrent mutation had altered `snapshot.bot.existingSegments` between the prompt build and the apply step.

### `RouteValidator.test.ts` (extend existing)

- `checkCumulativeBudget` uses `stop.insertionDetourCostOverride` when present, ignoring `demand.estimatedTrackCostToSupply`.
- Absence of override → identical behavior to baseline (regression guard).

### Existing test impacts

- Tests that asserted the old fire sites in `NewRoutePlanner.test.ts` and `PostDeliveryReplanner.test.ts` need to be updated or removed.
- `AdvisorCoordinator.test.ts` — remove tests for `adviseEnrichment`.

## Files touched

| Path | Change |
|------|--------|
| `src/server/services/ai/RouteDetourEstimator.ts` | NEW — helpers |
| `src/server/services/ai/RouteEnrichmentAdvisor.ts` | Replace `buildPrompt` body, modify `applyDecision`, add `currentCity` and `candidates` params to `enrich` |
| `src/server/services/ai/MovementPhasePlanner.ts` | Add post-action-sequence advisor hook in Phase A loop |
| `src/server/services/ai/NewRoutePlanner.ts` | Remove `RouteEnrichmentAdvisor.enrich` call (line 248) |
| `src/server/services/ai/AdvisorCoordinator.ts` | Remove `adviseEnrichment` method |
| `src/server/services/ai/PostDeliveryReplanner.ts` | Remove `AdvisorCoordinator.adviseEnrichment` call (line 153) |
| `src/server/services/ai/RouteValidator.ts` | `checkCumulativeBudget` prefers `stop.insertionDetourCostOverride` when present |
| `src/server/services/ai/schemas.ts` | Optional `expectedDetourCost?: number` field on `RouteEnrichmentInsertion` |
| `src/shared/types/GameTypes.ts` | Optional `insertionDetourCostOverride?: number` field on `RouteStop` |
| `src/server/__tests__/ai/RouteDetourEstimator.test.ts` | NEW |
| `src/server/__tests__/ai/RouteEnrichmentAdvisor.test.ts` | Extend |
| `src/server/__tests__/ai/RouteValidator.test.ts` | Extend |
| `src/server/__tests__/ai/NewRoutePlanner.test.ts` | Update for removed advisor call |
| `src/server/__tests__/ai/PostDeliveryReplanner.test.ts` | Update for removed advisor call |
| `src/server/__tests__/ai/AdvisorCoordinator.test.ts` | Remove `adviseEnrichment` tests |

## Failure modes & fallback

Same graceful-degradation strategy as the existing advisor:

- LLM call timeout → keep current route, log
- LLM JSON parse failure → bounded retry (1 attempt), then keep
- LLM proposes a load not actually available at `currentCity` → drop that entry, apply remaining
- LLM proposes a `deliveryCity` that doesn't match any held demand card → drop that entry
- LLM proposes a `loadType` whose chip isn't in `snapshot.loadAvailability[currentCity]` → drop that entry
- Modified route fails `RouteValidator` → revert to original, log validator's per-stop reason
- `simulateTrip` returns `feasible: false` for the `withoutD` baseline → the original route itself is unreachable; this is a separate concern (Kaliningrad-loop) and not handled here. The advisor logs and skips its LLM call.
