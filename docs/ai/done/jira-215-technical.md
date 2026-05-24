# JIRA-215 — Technical: Extend pickup-time advisor to scan next-leg corridor for off-current-city pickup candidates

See `docs/jira/jira-215-behavioral.md` for the observed behavior and motivation.

## Summary of the change

Extend the JIRA-214 advisor so its candidate filter is corridor-aware. Today the filter requires `demand.supplyCity == currentCity` (free pickup at bot's location only). The change:

1. Broaden filter condition 1 to admit candidates whose supply city lies on the Dijkstra path from `currentCity` to the next route stop.
2. Extend `RouteDetourEstimator.computeCandidateDetourCosts` to accept an explicit `supplyCity` per candidate and to enumerate `(pickupSlot, deliverSlot)` insertion pairs (today's per-deliver-slot enumeration is a degenerate case where pickup is free at currentCity).
3. Extend `RouteEnrichmentAdvisor.applyDecision` to splice both a PICKUP at `supplyCity` and a DELIVER at `deliveryCity` for off-current-city candidates (today the PICKUP is always at currentCity and free).
4. Extend the user prompt's candidate-row format to include `supplyCity` so the LLM sees the full insertion shape.

Existing schema (`RouteEnrichmentSchema` / `RouteEnrichmentInsertion`) already supports PICKUP insertions at any city — `action: 'pickup' | 'deliver'` and `city: string` cover both same-city and corridor cases. No schema change needed.

This is a pure extension of JIRA-214 — no fire-site changes, no behavioral regression for same-city cases, no new files.

## Why this scope

JIRA-214 shipped the correct structure for advisor invocations (post-action-at-each-city, with truthful detour data via `RouteDetourEstimator`). The remaining gap, surfaced by the c2a4df33 / Flash / Warszawa scenario, is purely in the candidate enumeration and insertion-shape. The simulator and validator wiring carry over unchanged. Estimated work: a small extension to one helper function and one applyDecision branch, plus updated tests.

Out of scope for this JIRA but acknowledged as related:

- **Pre-route advisor** at `NewRoutePlanner` / `PostDeliveryReplanner` time (Option 1 in the design discussion; rejected for now). If real games show that per-leg scope still misses high-value opportunities, revisit as a follow-on.
- **Multi-leg corridor scan** (scanning the path beyond the next stop). The bot fires at every per-city action, so multi-leg coverage emerges naturally from sequential fires. Single-leg scope is preserved.

## Component 1: `RouteDetourEstimator` — extended

### Updated `CandidateDetourInfo`

```ts
interface CandidateDetourInfo {
  loadType: string;
  supplyCity: string;             // NEW — previously implicit (== currentCity); now explicit
  deliveryCity: string;
  payout: number;
  cardIndex: number;
  bestPickupSlotIndex: number;    // NEW — slot where PICKUP is spliced; -1 when supplyCity == currentCity (free pickup at bot's position, not a route slot)
  bestDeliverSlotIndex: number;   // RENAMED from bestSlotIndex
  marginalBuildM: number;
  marginalTurns: number;
  feasible: boolean;
}
```

The renamed `bestSlotIndex → bestDeliverSlotIndex` is a search-and-replace touch; same semantics.

### Updated `computeCandidateDetourCosts`

```ts
computeCandidateDetourCosts(
  currentCity: string,
  candidates: Array<{ loadType: string; supplyCity: string; deliveryCity: string; payout: number; cardIndex: number }>,
  route: StrategicRoute,
  snapshot: WorldSnapshot,
): CandidateDetourInfo[]
```

For each candidate, two cases:

**Case A: `supplyCity == currentCity`** (today's behavior, preserved)
- Pickup is free at currentCity. `bestPickupSlotIndex = -1`.
- Enumerate `i ∈ [0, route.stops.length]` for the DELIVER slot only.
- `simWithD = simulateTrip(currentCity, stopsWithoutD with DELIVER inserted at i, snapshot)`.
- `marginalBuildM[i] = simWithD.totalBuildCost − simWithoutD.totalBuildCost`.
- `marginalTurns[i] = simWithD.turnsToComplete − simWithoutD.turnsToComplete`.
- Best slot = argmin over `i` (same as today).

**Case B: `supplyCity != currentCity`** (new — corridor case)
- Pickup is NOT free; bot must detour to `supplyCity`. Both PICKUP and DELIVER are spliced.
- Enumerate `(pickupSlot, deliverSlot)` pairs where `pickupSlot ≤ deliverSlot` and both ∈ `[0, route.stops.length]`.
- `simWithPair = simulateTrip(currentCity, stopsWithoutD with PICKUP@supplyCity inserted at pickupSlot AND DELIVER@deliveryCity inserted at deliverSlot, snapshot)`.
- `marginalBuildM[pair] = simWithPair.totalBuildCost − simWithoutD.totalBuildCost`.
- `marginalTurns[pair] = simWithPair.turnsToComplete − simWithoutD.turnsToComplete`.
- Best pair = argmin over pairs of `marginalBuildM + marginalTurns × OPPORTUNITY_COST_PER_TURN_M`.

For both cases, `simulateTrip(currentCity, stopsWithoutD, snapshot)` is computed once and memoized — same memoization story as JIRA-214.

For an N-stop remaining route, Case B enumerates `(N+1)(N+2)/2` pairs per candidate. With N=2 (typical mid-route), that's 6 pairs. With ~5 candidates after corridor-scan filtering, total ~30 sim calls per fire. Bounded; well under 100ms with memoization.

### New helper `findCorridorCities(currentCity, nextStopCity, snapshot, widthHexes = CORRIDOR_WIDTH_HEXES): string[]`

Returns the set of city names whose grid cell is within `widthHexes` hex-distance of any cell on the Dijkstra path from `currentCity` to `nextStopCity`. Reuses `findShortestBuildablePath` (the private Dijkstra in `RouteDetourEstimator.ts`) for the path; then iterates over all grid cells with city names and includes those within hex-distance `widthHexes` of any path cell.

The new exported constant:

```ts
/**
 * Hex-distance radius used to gate corridor candidates in
 * RouteEnrichmentAdvisor's pre-LLM filter.
 *
 * Provenance:
 * - K=4 caps the off-path detour at ~8 round-trip hexes (bot goes K out
 *   to the supply city, K back toward the planned destination).
 * - At typical train speed (9-12 mileposts/turn), 8 hexes is ~1 turn of
 *   extra movement.
 * - Worst-case build cost: 4 alpine hexes out + 4 alpine back = 8 × 5M =
 *   40M of new track = 2 turns of build budget.
 * - Combined: ~3 turns of marginal trip extension at the geometric maximum.
 *   This makes a separate MAX_DETOUR_TURNS gate redundant; K=4 is the gate.
 * - K=3 would miss the c2a4df33 / Warszawa → Stuttgart through Lodz case
 *   in some map geometries; K=5 admits noticeably more candidates without
 *   meaningful gameplay benefit. K=4 is the smallest value that catches
 *   the canonical case while keeping the candidate set small.
 */
export const CORRIDOR_WIDTH_HEXES = 4;
```

If `nextStopCity` is unreachable, `findCorridorCities` returns `[]` (advisor falls back to same-city-only behavior for this fire).

## Component 2: `RouteEnrichmentAdvisor` — filter + applyDecision extensions

### Extended pre-LLM filter (in `MovementPhasePlanner.ts` Phase A trigger)

**Today's condition 1**: `loadAvailability[currentCity]` includes `loadType` AND `demand.supplyCity?.toLowerCase() === currentCity.toLowerCase()`.

**New condition 1**: ONE of the following:
- (A) Same-city: `loadAvailability[currentCity]` includes `loadType` AND `demand.supplyCity?.toLowerCase() === currentCity.toLowerCase()` — preserves today's behavior.
- (B) Corridor: `demand.supplyCity` is in `findCorridorCities(currentCity, nextStopCity, snapshot)` (= within K=4 hex-distance of the Dijkstra path) AND `loadAvailability[demand.supplyCity]` includes `loadType` (load is actually there).

`nextStopCity` is the bot's next pending route stop's city (the one the bot is about to head toward). If the bot's route has no remaining stops, only Case A candidates are considered (no corridor exists).

**Filter conditions 2 and 3 from JIRA-214 R8 are preserved**:
- Condition 2: route does NOT already contain a DELIVER stop for `(demand.loadType, demand.deliveryCity)`.
- Condition 3: train has a free slot post-pickup.

**Filter conditions 4 and 5 from JIRA-214 R8 are removed**:
- ~~Condition 4 (`marginalBuildM ≤ snapshot.bot.money`)~~ — removed. Reason: the snapshot-time cash check is too aggressive — it falsely rejects insertions that are affordable when delivery payouts mid-trip are accounted for. `RouteValidator.checkCumulativeBudget` (JIRA-214 R5) is the authoritative cash-flow gate; it walks all stops in order with payouts as cash inflows and prunes any stop whose track cost exceeds running cash. If the validator prunes the inserted pair, the advisor reverts to the original route per the existing graceful-degradation pattern.
- ~~Condition 5 (`marginalTurns ≤ MAX_DETOUR_TURNS`)~~ — removed. Reason: K=4 hex-distance pre-filter geometrically caps marginalTurns at ~3 (~1 turn movement + ~2 turns worst-case all-alpine build). A separate cap on `marginalTurns` is redundant. The constant `MAX_DETOUR_TURNS` is removed from `RouteDetourEstimator.ts` as part of this JIRA.

The corridor path computation happens once per fire (single Dijkstra call + a coord-set scan) regardless of how many candidates pass condition 1.

### Extended `applyDecision`

For each LLM-proposed insertion the advisor now examines `insertion.action`:

- **`action: 'deliver'`** (today's main case): splice DELIVER at `afterStopIndex` with `payment`, `demandCardId`, `insertionDetourCostOverride` populated as today. If the corresponding pickup is implicit-free at currentCity (Case A), the bot's already there — no PICKUP plan emitted by the advisor (the per-turn executor handles the load chip pickup). If the corresponding pickup was spliced as an explicit PICKUP stop (Case B), it's already in the route from the matching `action: 'pickup'` insertion below.

- **`action: 'pickup'`** (new — for corridor candidates): splice PICKUP at `afterStopIndex` with no `payment` / `demandCardId` (PICKUPs don't reference a card directly) and with `insertionDetourCostOverride` populated from the matching `CandidateDetourInfo` so the validator's cumulative-budget gate uses the correct marginal cost.

The LLM is expected to emit pickup+deliver pairs together when the insertion is a corridor candidate. The advisor verifies pairing: every PICKUP insertion for `loadType=L` must be accompanied by a DELIVER insertion for the same `loadType` at a slot ≥ the PICKUP's slot. Unpaired insertions are dropped with a log line (per existing graceful-degradation pattern).

### Extended user prompt

The candidate row format changes to expose `supplyCity`:

```
Additional load opportunities on or near your next leg ({currentCity} → {nextStopCity}):
  Potatoes (pick up at Lodz, deliver at Ruhr, payout 30M) — detour 8M / 2 turns, insert pickup after stop 0, deliver after stop 1
  Coal (pick up here at Warszawa, deliver at Frankfurt, payout 18M) — detour 5M / 1 turn, insert deliver after stop 1
```

The "pick up here at {currentCity}" wording for Case A makes the free-pickup-at-bot's-position semantics explicit. For Case B the supply city is named.

System prompt's heuristic phrasing ("choose `insert` only when, for at least one candidate, `marginalBuild + (marginalTurns × ~5M/turn) < ~0.6 × payout`") stays unchanged — the math is identical for both cases.

## Files touched

| Path | Change |
|------|--------|
| `src/server/services/ai/RouteDetourEstimator.ts` | Add `supplyCity` to `CandidateDetourInfo`; rename `bestSlotIndex` → `bestDeliverSlotIndex`; add `bestPickupSlotIndex`; extend `computeCandidateDetourCosts` to handle Case B; add `findCorridorCities` helper; export new constant `CORRIDOR_WIDTH_HEXES = 4`; **remove** `MAX_DETOUR_TURNS` constant |
| `src/server/services/ai/RouteEnrichmentAdvisor.ts` | Update `buildPrompt` candidate-row format; extend `applyDecision` to handle paired PICKUP+DELIVER insertions for off-current-city candidates |
| `src/server/services/ai/MovementPhasePlanner.ts` | Extend the pre-LLM filter (condition 1) to admit corridor candidates via `findCorridorCities`; **remove** filter conditions 4 (build ≤ cash) and 5 (marginalTurns ≤ MAX_DETOUR_TURNS) |
| `src/server/__tests__/ai/RouteDetourEstimator.test.ts` | New scenarios for Case B `(pickupSlot, deliverSlot)` enumeration; `findCorridorCities` tests |
| `src/server/__tests__/ai/RouteEnrichmentAdvisor.test.ts` | New scenarios for corridor candidates; verify `applyDecision` correctly splices pairs; verify prompt row format includes `supplyCity` |
| `src/server/__tests__/ai/MovementPhasePlanner.test.ts` | New scenario: at Warszawa post-Ham-pickup with route `PICKUP Ham@Warszawa → DELIVER Ham@Stuttgart` and Potatoes→Ruhr in hand and Lodz supplying Potatoes on the corridor → advisor surfaces Potatoes as a candidate (regression guard for the JIRA-215 game evidence) |

No deletions; no schema changes; no new files.

## Requirements

- **R1**: `RouteDetourEstimator.computeCandidateDetourCosts` signature MUST accept candidates with explicit `supplyCity`. When `supplyCity === currentCity`, behavior MUST be identical to JIRA-214 (Case A: PICKUP is free at bot's location; only DELIVER slot enumerated). When `supplyCity !== currentCity` (Case B: corridor), the function MUST enumerate `(pickupSlot, deliverSlot)` pairs with `pickupSlot ≤ deliverSlot` and select the pair minimizing `marginalBuildM + marginalTurns × OPPORTUNITY_COST_PER_TURN_M`.

- **R2**: `CandidateDetourInfo` MUST gain `supplyCity: string` and `bestPickupSlotIndex: number` fields, and rename `bestSlotIndex` to `bestDeliverSlotIndex`. For Case A, `bestPickupSlotIndex = -1` (sentinel meaning "free at bot's current position, no slot in route"). For Case B, `bestPickupSlotIndex` is a valid slot index in `[0, route.stops.length]`.

- **R3**: A new helper `findCorridorCities(currentCity: string, nextStopCity: string, snapshot: WorldSnapshot, widthHexes: number = CORRIDOR_WIDTH_HEXES): string[]` MUST be added to `RouteDetourEstimator.ts`. It MUST return the names of cities whose grid cell is within `widthHexes` hex-distance of any cell on the Dijkstra path from `currentCity` to `nextStopCity`. The Dijkstra MUST use the same edge-weight rules as `estimateRouteSegment` (bot's existing edges cost 0, opponent edges impassable, fresh terrain at terrain cost). When the path is unreachable, MUST return `[]`. A new constant `CORRIDOR_WIDTH_HEXES = 4` MUST be exported from `RouteDetourEstimator.ts` with a documented provenance comment: K=4 caps off-path detour at ~8 round-trip hexes (~1 turn of extra movement at typical train speed) and ~40M of new track in the worst-case all-alpine case (~2 turns of extra build) — naturally bounding total marginal turns at ~3 without a separate cap, while admitting near-miss cases that strict on-path (K=0) would drop.

- **R4**: The pre-LLM filter in `MovementPhasePlanner` Phase A trigger MUST broaden condition 1 to admit candidates whose `demand.supplyCity` is either (A) `currentCity` AND `loadAvailability[currentCity]` includes the load, OR (B) a city in `findCorridorCities(currentCity, nextStopCity, snapshot)` AND `loadAvailability[supplyCity]` includes the load. `nextStopCity` is the bot's next pending route stop's city. When the route has no remaining stops, only Case A candidates are admitted. Filter conditions 4 (`marginalBuildM ≤ snapshot.bot.money`) and 5 (`marginalTurns ≤ MAX_DETOUR_TURNS`) from JIRA-214 R8 MUST be removed — `K=4` implicitly bounds `marginalTurns` at ~3 via geometry, and `RouteValidator.checkCumulativeBudget` (JIRA-214 R5) is the authoritative cash-flow gate because it accounts for delivery payouts as cash inflows across the full trip rather than a snapshot-time check that would falsely reject feasible insertions financed by mid-trip deliveries. The constant `MAX_DETOUR_TURNS` MUST be removed from `RouteDetourEstimator.ts` (no remaining consumers).

- **R5**: `RouteEnrichmentAdvisor.applyDecision` MUST handle LLM-proposed insertions with `action: 'pickup'` and `action: 'deliver'` together. For each PICKUP insertion, it MUST verify that a paired DELIVER insertion for the same `loadType` exists at a slot ≥ the PICKUP's slot. Unpaired PICKUP insertions MUST be dropped with a log line and not spliced into the route. Both PICKUP and DELIVER stops MUST have `insertionDetourCostOverride` populated from the matching `CandidateDetourInfo.marginalBuildM`. DELIVER stops MUST additionally carry `payment` and `demandCardId` from `context.demands` (today's behavior preserved).

- **R6**: The user prompt's candidate-row format MUST include `supplyCity`. For Case A candidates, the row text reads "pick up here at {currentCity}". For Case B, the row text reads "pick up at {supplyCity}". The header reads "Additional load opportunities on or near your next leg ({currentCity} → {nextStopCity})" instead of today's "Additional loads available here that match your demand cards" when at least one Case B candidate exists; otherwise today's header is preserved.

- **R7**: All JIRA-214 acceptance criteria MUST continue to pass unchanged. Specifically, AC7-AC18 from JIRA-214 are regression guards for Case A behavior. Case A is the degenerate `supplyCity === currentCity` instance of the new logic; behavior is identical.

## Acceptance Criteria

- **AC1** (R1, Case A regression): existing JIRA-214 unit tests for `computeCandidateDetourCosts` pass unchanged when called with candidates where `supplyCity === currentCity`. Specifically: empty input → empty output; candidate with every slot infeasible omitted; `bestDeliverSlotIndex` minimizes the same scoring formula as today.

- **AC2** (R1, Case B): unit test feeds a candidate where `supplyCity !== currentCity`. The function MUST return a `CandidateDetourInfo` with `bestPickupSlotIndex >= 0`, `bestDeliverSlotIndex >= bestPickupSlotIndex`, and `marginalBuildM` / `marginalTurns` reflecting both legs of the detour.

- **AC3** (R2): TypeScript compiler accepts the new `CandidateDetourInfo` shape. Consumers (advisor's `buildPrompt` and `applyDecision`) reference both `bestPickupSlotIndex` and `bestDeliverSlotIndex` correctly.

- **AC4** (R3): `findCorridorCities` unit tests cover: (a) currentCity directly adjacent to nextStopCity, K=4 → result includes both endpoints; (b) currentCity → nextStopCity routed through known intermediate cities (e.g., Warszawa → Stuttgart through Lodz given typical map geometry), K=4 → result includes the intermediates AND cities up to 4 hexes off the path; (c) a city 5 hexes off the path is NOT included at K=4; (d) unreachable target (opponent track blocks all paths) → result is `[]`; (e) `CORRIDOR_WIDTH_HEXES` constant value equals 4 and is documented at its declaration site.

- **AC4b** (R4 cleanup): grep confirms `MAX_DETOUR_TURNS` is removed from the codebase (declaration in `RouteDetourEstimator.ts` and any callsites). `OPPORTUNITY_COST_PER_TURN_M` remains as it is still used for slot scoring inside `computeCandidateDetourCosts`.

- **AC5** (R4): the pre-LLM filter in `MovementPhasePlanner` admits a corridor candidate when supply is on the path. Mocked test: bot at Warszawa, route `PICKUP Ham@Warszawa → DELIVER Ham@Stuttgart`, Potatoes → Ruhr demand in hand, Lodz on the path Warszawa → Stuttgart, Lodz has Potatoes available — assert the advisor's `chat` mock is called and the candidate list passed to `buildPrompt` includes Potatoes with `supplyCity: 'Lodz'`.

- **AC6** (R4 negative): the pre-LLM filter still rejects a candidate when supply is NOT on the path. Mocked test: same setup but a Cars → London demand whose supply city Birmingham is nowhere near the Warszawa → Stuttgart corridor — assert Cars is dropped at filter condition 1 and does not appear in the LLM prompt.

- **AC7** (R5, paired insertion): mocked-LLM test feeds an `insert` decision with both `action: 'pickup'` (Potatoes @ Lodz) and `action: 'deliver'` (Potatoes @ Ruhr) at appropriate slots. Resulting route has both stops spliced; both have `insertionDetourCostOverride` populated; the DELIVER stop additionally has `payment` and `demandCardId`.

- **AC8** (R5, unpaired insertion): mocked-LLM test feeds an `insert` decision with a PICKUP insertion but NO matching DELIVER insertion for the same load type. Assert the PICKUP is dropped (not spliced), a log line is emitted, and the route is otherwise reverted to its pre-decision state.

- **AC9** (R6): mocked-LLM test asserts the user prompt's candidate header reads "Additional load opportunities on or near your next leg" when at least one corridor candidate is present, and reads today's "Additional loads available here that match your demand cards" when only same-city candidates are present. Per-row text correctly distinguishes "pick up here at {currentCity}" (Case A) from "pick up at {supplyCity}" (Case B).

- **AC10** (R7, regression guard): the full JIRA-214 test suite for `RouteEnrichmentAdvisor.test.ts`, `RouteDetourEstimator.test.ts`, and `RouteValidator.test.ts` passes unchanged. Specifically AC7-AC18 from JIRA-214 are unaffected.

- **AC11** (game-evidence regression guard): mocked-LLM test reproducing the JIRA-215 behavioral game scenario — bot at Warszawa post-Ham-pickup with `PICKUP Ham@Warszawa → DELIVER Ham@Stuttgart` route, Potatoes → Ruhr in hand, Lodz within 4 hexes of the Warszawa → Stuttgart Dijkstra path, Lodz has Potatoes available, train slot free. Assert the advisor surfaces Potatoes as a candidate (LLM call is made, prompt includes the Potatoes row with `supplyCity: 'Lodz'`). Note: no cash-bound or turn-cap pre-filter — the validator is the cash gate, K=4 is the geometric gate.

- **AC12** (cash-flow handled by validator): mocked-LLM test where the LLM accepts a corridor candidate whose `marginalBuildM` exceeds `snapshot.bot.money` at advisor-fire time, but the route's cumulative cash flow (including planned delivery payouts) covers the cost. Assert: the candidate passes filter conditions 1-3 (no cash pre-check), is presented to the LLM, the LLM's `insert` decision is applied via `applyDecision`, and `RouteValidator.validate` accepts the route because `checkCumulativeBudget` accounts for delivery payouts. Assert no insertion is reverted.

- **AC13** (validator catches genuinely unaffordable insertion): mocked-LLM test where the LLM accepts a candidate whose insertion makes the cumulative running cash go negative at some stop (cumulative track cost exceeds cumulative cash + delivery payouts). Assert: `applyDecision` splices the stops, `RouteValidator.validate` returns a result that prunes the inserted stops, the advisor reverts to the original route, and a log line is emitted naming the validator's reason (per JIRA-214 R7 graceful-degradation behavior).

## Test strategy

Unit-only, same as JIRA-214. No new test files; extensions to three existing files in `src/server/__tests__/ai/`.

- **`RouteDetourEstimator.test.ts`**: new tests for Case B in `computeCandidateDetourCosts` (AC1, AC2); new tests for `findCorridorCities` (AC4).
- **`RouteEnrichmentAdvisor.test.ts`**: new tests for paired PICKUP+DELIVER insertion handling in `applyDecision` (AC7, AC8); new tests for prompt format with corridor candidates (AC9); regression assertions for AC10.
- **`MovementPhasePlanner.test.ts`**: new tests for the broadened filter (AC5, AC6); the game-evidence regression guard (AC11).

Existing fixtures from JIRA-214 are the starting point — extend with map fixtures that include named intermediate cities (Lodz between Warszawa and Stuttgart; Birmingham far from any of them) so the corridor-scan tests have a meaningful geography.

## Failure modes & fallback

- `findCorridorCities` returns `[]` (path unreachable): only Case A candidates considered. No regression vs JIRA-214 behavior.
- LLM emits an unpaired PICKUP (no matching DELIVER for the same load): per R5, the PICKUP is dropped with a log line. Other insertions in the same response are still applied.
- LLM emits a PICKUP at a city not in the candidate list (hallucinated): per JIRA-214's existing graceful-degradation, the insertion is dropped with a log line. No new failure path.
- Case B candidate's pickup detour ends up making the trip infeasible (sim returns `feasible: false` for all `(pickupSlot, deliverSlot)` pairs): candidate is omitted from the returned list per JIRA-214 R3.
- Validator prunes the spliced PICKUP+DELIVER pair: full pair reverted (today's logic already reverts to pre-decision state on validator rejection; no new code).

## Lifecycle

`insertionDetourCostOverride` lifecycle from JIRA-214 R12 applies unchanged to Case B's PICKUP stops: set at insertion time, persists across turn serialization, never recomputed by subsequent advisor invocations on the same stop.
