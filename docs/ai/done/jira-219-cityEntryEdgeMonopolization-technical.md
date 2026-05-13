# JIRA-219 — City entry edge monopolization (technical)

Companion to `jira-219-cityEntryEdgeMonopolization-behavioral.md`. Read that first for the rule context.

## Current implementation

**`src/server/services/ai/TurnValidator.ts`**

- `cityEntryLimit(row, col, terrain)` — lines 150-158. Returns 2 for SmallCity, 3 for MediumCity, or the per-city `maxConnections` override. Returns null otherwise.
- `checkCityEntryLimit(steps, snapshot)` — lines 230-269. For each `BuildTrack` step, walks the segments and rejects if `(distinct other players already at city) + 1 > limit`. **This is the only hard gate.**
- `computeSaturatedCityKeys(snapshot)` — lines 175-227. Pre-filter feed for `ActionResolver`. Marks a city saturated when other-player count alone is already at limit, so the bot is locked out.

**`src/server/services/ai/ActionResolver.ts`**

- Lines 281-295 — uses `computeSaturatedCityKeys` to exclude saturated cities from Dijkstra paths (JIRA-203 lineage).

**`src/server/services/ai/TurnExecutorPlanner.ts`**

- `isCappedCityBlocked` (lines 979-1047) and `resolveCappedCityDelivery` (lines 1061-1200) handle the case where a *delivery* city is at cap (JIRA-187). They reason about player count, not entry edges.

## Root cause

All three checkpoints (`checkCityEntryLimit`, `computeSaturatedCityKeys`, `isCappedCityBlocked`) reason exclusively over *distinct players touching the city*. None of them count the *physical entry edges* (milepost-pairs adjacent to the city center) that remain unoccupied. As long as player count ≤ cap, the bot can take every entry edge.

## Fix plan

### 1. New predicate: `entryEdgesRemaining(cityKey, snapshot)`

Compute the set of milepost-pairs that constitute "entry edges" to the city — i.e. all adjacent neighbors of the city milepost(s) that are not yet covered by any player's track. A reasonable definition for this codebase, given the existing snapshot shape:

- Iterate over the city's adjacent grid points (using `MapTopology` neighbor lookup).
- For each adjacent neighbor, check whether *any* `playerTrack.segments` (across all players) already contains the segment `(city, neighbor)`.
- Return the count of neighbors with no segment built yet.

Edge cases: cities with multiple terrain mileposts (rare for small/medium), ferry-port adjacency, and water-crossing neighbors — handle these the same way the existing `cityEntryLimit` flow handles them.

### 2. New hard gate: `checkCityEntryReservation(steps, snapshot)`

For each proposed `BuildTrack` segment whose `to` is a small/medium city:

1. Compute `playersTouchingAfterBuild` = distinct other players + bot (if bot would touch the city after this segment).
2. Compute `reservedFor` = `cityEntryLimit − playersTouchingAfterBuild`. This is the number of entry edges the rulebook requires us to leave open for future players.
3. Compute `edgesRemainingAfterBuild` = `entryEdgesRemaining(city)` minus the number of segments in this turn's plan that consume entry edges of that city.
4. Reject with gate `CITY_ENTRY_RESERVATION` if `edgesRemainingAfterBuild < reservedFor`.

Wire it into `validate()` next to `checkCityEntryLimit` so both gates run.

### 3. Saturation pre-filter update

Extend `computeSaturatedCityKeys` (or add a sibling `computeReservedCityKeys`) to also mark a city saturated *for path purposes* when the bot building one more entry edge would violate the reservation. This lets `ActionResolver` Dijkstra avoid the city before the validator ever sees it, mirroring the JIRA-203 pattern.

### 4. No changes to `isCappedCityBlocked`

That predicate handles the *delivery* side (can the bot reach the city to deliver?). It already covers the player-count cap; the entry-edge case is upstream — if the bot can't physically enter without violating no-blocking, the validator will reject the build path, and `BuildRouteResolver` will fall through to alternatives. No special-casing needed here unless we see regressions.

## Test plan

Unit tests in `TurnValidator.test.ts`:

1. **Solo bot, low-degree small city, 3 entry edges:** bot builds 1st edge — pass. Builds 2nd edge — pass (1 remains, reservation = 2 − 1 = 1 ✓). Builds 3rd edge — **reject** (0 remain, reservation = 1).
2. **Bot + 1 other player at a 4-edge medium city:** other player has 1 edge, bot proposes 1 edge. Reservation = 3 − 2 = 1, remaining after = 4 − 2 = 2 ✓ — pass.
3. **Per-city `maxConnections` override = 1:** any bot entry attempt when no other player is there should still pass (reservation = 0). When 1 other player is already there, pre-filter marks it saturated.
4. **Multi-segment turn:** plan that builds two entry edges to the same small city in one turn — second segment within the plan must be evaluated against post-first-segment state.

Integration: extend an existing `TurnExecutor` golden test with a fixture where the bot would otherwise build the third edge of a 3-edge small city, and confirm the validator rejects and `ActionResolver` produces an alternative.

## Risks

- **Over-restriction on sparsely-played maps.** Early in the game, no one is competing for entries; reserving slots for hypothetical future opponents could prevent legitimate builds. Mitigation: only reserve based on `cityEntryLimit − playersTouchingAfterBuild`, which is 0 once the cap is reached and shrinks as players actually arrive — it does not reserve for *missing* players.
- **Performance.** `entryEdgesRemaining` requires neighbor iteration per build segment per turn. Given current segment counts per turn (≤ 20M / 1M = 20 segments max), this is negligible.
- **Map-data dependence.** If the grid neighbor lookup misses ferry/water-crossing edges, the count will be off. Use the same neighbor source the existing build cost code uses (`MapTopology`) for consistency.

## Verification before scheduling

Per the behavioral note: confirm at least one small/medium city on the current map has few enough entry edges that this gap is reachable in normal play. If every small/medium city has ≥ 5 entry edges, the gap is theoretical and this can be deprioritized.
