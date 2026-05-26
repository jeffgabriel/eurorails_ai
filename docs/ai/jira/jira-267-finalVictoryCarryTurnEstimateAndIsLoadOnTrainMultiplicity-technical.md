# JIRA-267 — Make `estimateSingleDemandTurns`'s carry branch compute travel turns from bot position to delivery city (Fix A); build a multiplicity-aware `effectiveCarry` map inside `findFinalVictoryRoute` so a single carried chip doesn't flag every same-loadType demand as carried (Fix B) (technical)

Companion to `jira-267-finalVictoryCarryTurnEstimateAndIsLoadOnTrainMultiplicity-behavioral.md`.

Two structural fixes localized to `victoryRules.ts`. Both are independent of cargo count, neither is a tuning knob. Together they make the carry-deliver candidate ranking match physical reality.

## Fix A — distance-aware turn estimate for carried loads

**Defect locus.** `src/server/services/ai/victoryRules.ts:246–263` (the `estimateSingleDemandTurns` function, specifically the `if (d.isLoadOnTrain)` branch).

Current code:

```ts
function estimateSingleDemandTurns(
  d: DemandContext,
  speed: number,
): number {
  let turns = d.estimatedTurns ?? 3;
  turns += buildTurns(d.isSupplyOnNetwork ? 0 : d.estimatedTrackCostToSupply);
  turns += buildTurns(d.isDeliveryOnNetwork ? 0 : d.estimatedTrackCostToDelivery);
  if (d.isLoadOnTrain) {
    // estimatedTurns from ContextBuilder counts supply travel; subtract 1 trip leg.
    // Use speed-based estimate for the carry case to avoid double-counting.
    turns = travelTurns(1, speed);                                              // ← always 1
    turns += buildTurns(d.isDeliveryOnNetwork ? 0 : d.estimatedTrackCostToDelivery);
  }
  return Math.max(1, turns);
}
```

The carry branch unconditionally returns `1 + buildTurns(...)`. `travelTurns(1, speed) = ceil(1/speed) = 1` always. The function never consults the bot's position or the delivery city's coordinates.

Fix shape: thread bot position + grid points into the estimator (or compute travel turns at the call site), and use `hexDistance(botPosition, deliveryCoord)` to derive the actual leg cost.

Simplest implementation — compute travel inline at the call site in `findFinalVictoryRoute`, since that's where the snapshot is available:

```ts
// findFinalVictoryRoute, in the candidates enumeration loop
const deliveryCoord = findCityCoord(d.deliveryCity, gridPoints);  // helper exists in MapTopology
const botPos = snapshot.bot.position;
const travelTurnsToDelivery = botPos && deliveryCoord
  ? Math.max(1, Math.ceil(hexDistance(botPos, deliveryCoord) / trainSpeed))
  : 1; // fallback when position/coord unavailable
const carryTurns = travelTurnsToDelivery + buildTurns(
  d.isDeliveryOnNetwork ? 0 : d.estimatedTrackCostToDelivery
);
```

Or — cleaner — change `estimateSingleDemandTurns`'s signature to accept `botPosition` and `gridPoints`, keeping the math centralized:

```ts
function estimateSingleDemandTurns(
  d: DemandContext,
  speed: number,
  botPosition: { row: number; col: number } | null,
  gridPoints: GridPoint[],
): number {
  // pickup+deliver path unchanged
  if (!d.isLoadOnTrain) {
    let turns = d.estimatedTurns ?? 3;
    turns += buildTurns(d.isSupplyOnNetwork ? 0 : d.estimatedTrackCostToSupply);
    turns += buildTurns(d.isDeliveryOnNetwork ? 0 : d.estimatedTrackCostToDelivery);
    return Math.max(1, turns);
  }

  // Carry-deliver path: distance from bot's actual position
  const deliveryCoord = gridPoints.find(g => g.name === d.deliveryCity);
  const travel = botPosition && deliveryCoord
    ? Math.max(1, Math.ceil(hexDistance(botPosition, deliveryCoord) / speed))
    : 1; // conservative fallback
  const build = buildTurns(d.isDeliveryOnNetwork ? 0 : d.estimatedTrackCostToDelivery);
  return travel + build;
}
```

`findFinalVictoryRoute` already has `snapshot` and (transitively) the grid points it would need to pass. `hexDistance` is exported from `MapTopology.ts`; the city-to-coord lookup already exists for other planners and can be reused.

**Effect on game 29c0255f T85.** Bot position near Aberdeen (Scotland), delivery candidates:
- Aberdeen → Holland: ~5 hex (ferry-crossed) → ~2 turns at speed 12 (accounting for ferry half-rate)
- Aberdeen → Bern: ~15 hex → ~4 turns
- Aberdeen → Milano: ~17 hex → ~5 turns

With distance-aware turns: Holland wins on the primary key. No tiebreak needed.

## Fix B — multiplicity-aware `effectiveCarry` map inside `findFinalVictoryRoute`

**Defect locus.** `src/server/services/ai/context/DemandEngine.ts:501` (`isLoadOnTrain = snapshot.bot.loads.includes(loadType)` — a per-loadType-class flag), as consumed by `findFinalVictoryRoute` in `victoryRules.ts:354–366` and the candidate-enumeration loops.

The simplest fix is to NOT change `DemandContext.isLoadOnTrain` globally — that flag has many consumers (DeterministicTripPlanner, route validators, prompt serialization) and each has its own multiplicity-handling story. Instead, compute a local effective-carry set inside `findFinalVictoryRoute` using the same `detectCarriedLoads` / `normalizeRows` machinery that JIRA-233 added to `DeterministicTripPlanner`.

`detectCarriedLoads` is already exported from `DeterministicTripPlanner.ts:258` and takes `(activeRoute, demands, cargoLoads)`. `normalizeRows` is also exported. Reuse:

```ts
import { detectCarriedLoads, normalizeRows } from './DeterministicTripPlanner';

// inside findFinalVictoryRoute, before candidate enumeration:
const carriedMap = detectCarriedLoads(
  memory.activeRoute ?? null,
  context.demands,
  snapshot.bot.loads,
);
const rows = normalizeRows(context.demands, carriedMap);

// Replace each `d.isLoadOnTrain` check with `row.isCarry` from the normalized rows.
// The candidate enumeration now sees only one Fish demand as effectively carried
// (the highest-payout one, per JIRA-233 tiebreak), even when the bot has 1 chip.
```

This avoids changing `DemandEngine` semantics for the broader codebase while making `findFinalVictoryRoute`'s candidate set correct.

**Effect on game 29c0255f T85.** Bot has one Fish chip, three Fish demands. `detectCarriedLoads` returns `{Fish: 1}`. `normalizeRows` marks **only Fish→Bern (highest payout, $37) as isCarry=true**. Fish→Milano and Fish→Holland are NOT carry — they become pickup+deliver candidates against `d.estimatedTurns` (path-aware via ContextBuilder).

With Fix B alone (Fix A still active): the carry-Bern candidate still has the buggy 1-turn estimate (favoring it), but Holland and Milano now generate pickup+deliver candidates with realistic path-aware turn counts. Holland would still likely win on turns (it's geographically closest) — but the math depends on whether the Aberdeen→Holland pickup-then-deliver path beats the carry-Bern's buggy 1-turn estimate. With Fix A applied too, all three get realistic estimates and Holland wins cleanly.

## Why both fixes are needed

Either fix alone might happen to produce the right answer in this specific game, but the defects are independent:

- **Fix A alone**: with all three Fish demands still incorrectly flagged carry (Bug B), the candidate ranking becomes Holland (~2 turns) vs Milano (~5) vs Bern (~4). Holland wins. The answer is right but for fragile reasons — any game where the multi-card-shared-loadType pattern combines with a high-payout-far-city demand could still tilt the ranker.
- **Fix B alone**: only the highest-payout Fish demand (Bern) gets carry status. Holland and Milano become pickup+deliver candidates with their real path costs. Bern as a carry-deliver still gets the buggy 1-turn estimate (Bug A). Whether Holland's full pickup+deliver path beats Bern's 1-turn buggy estimate depends on `d.estimatedTurns` for Fish→Holland from Aberdeen. Could go either way.

Both fixes together: the ranker sees realistic distance-aware costs for every candidate, and the candidate set itself respects chip-to-card multiplicity. Then `findFinalVictoryRoute`'s primary "minimum turns to clinch" objective is operationally correct.

## Acceptance criteria

- **AC1 (Fix A unit) — carry-deliver turn estimate uses distance.** Fixture: `d.isLoadOnTrain=true`, `d.isDeliveryOnNetwork=true`, bot at `(10,10)`, delivery city at `(20,20)`, speed=12. Assert `estimateSingleDemandTurns` returns `ceil(hexDistance((10,10),(20,20))/12) = 1` (close) or `2` (further) — but specifically NOT a constant 1 regardless of the coords. Compare against a far-city fixture (delivery at `(50,50)`) and assert the result is strictly greater.
- **AC2 (Fix A unit) — replay game 29c0255f T85.** Reconstruct Sonnet T85 state: bot near Aberdeen (use actual coords from log), three Fish demands (Holland/Milano/Bern) all `isLoadOnTrain=true`, all delivery cities on-network. Call `findFinalVictoryRoute` and assert the chosen route's destination is Holland (closest), not Bern.
- **AC3 (Fix B unit) — multiplicity-aware effectiveCarry.** Fixture: `snapshot.bot.loads=['Fish']`, three Fish demands (payouts 37, 27, 23). Build the effective carry map. Assert only the $37 demand is marked carry; the other two are NOT.
- **AC4 (Fix B unit) — 3 chips matches 3 demands.** Same demand set, `snapshot.bot.loads=['Fish','Fish','Fish']`. Assert all three demands marked carry (one per chip).
- **AC5 (combined replay) — game 29c0255f T85 with both fixes.** Same setup as AC2 but explicitly verify: at most 1 Fish demand is in the carry-deliver candidate set (Bug B fixed), AND the chosen route delivers to Holland (Bug A fixed). End-to-end: `findFinalVictoryRoute` returns `{outcome: 'fire', route: {stops: [...], stops[0].city: 'Holland'}}`.
- **AC6 (no regression — Sonnet T84 pre-pickup).** Same demand cards but `snapshot.bot.loads=[]` (Fish not yet picked up). Assert the chosen route is `[pickup:Fish@Aberdeen, deliver:Fish@Holland]` — same as today's behavior. (Bug A doesn't fire when isLoadOnTrain=false; Bug B is moot when there's no chip on board.)

## Files touched

- `src/server/services/ai/victoryRules.ts` — Fix A's signature change to `estimateSingleDemandTurns` + call-site updates inside `findFinalVictoryOutcome` (the function exported by JIRA-265); Fix B's effective-carry computation using imported `detectCarriedLoads`/`normalizeRows`.
- `src/server/__tests__/ai/victoryRules.test.ts` — AC1–AC6 tests; existing carry-deliver tests may need fixture updates if they relied on the constant-1 estimate.
- Possibly `src/server/__tests__/ai/jira267Replay.test.ts` (new) for AC2 + AC5 using captured Sonnet T85 state.

## Diagnostic value (post-fix, via JIRA-265 trace)

The `endGame.victoryRouteProjection.stops` field will reflect the corrected destination on the turn the override fires. A `jq` query on a future game NDJSON:

```bash
jq -c 'select(.gameState=="end" and .endGame.victoryRouteProjection.appliedOverride==true) | {turn, player: .playerName, stops: .endGame.victoryRouteProjection.stops, turns: .endGame.victoryRouteProjection.turns}' logs/game-<id>.ndjson
```

After the fix, an override that swaps destinations after a pickup should pick the geographically-closest delivery, not the highest-payout. Manual review of the `stops` field will tell.

## Not in scope

- Changes to `DeterministicTripPlanner.detectCarriedLoads` / `normalizeRows`. Reusing them as imports; not modifying.
- Changes to `DemandContext.isLoadOnTrain` globally. Other consumers retain the per-loadType semantics.
- Multi-stop carry routes (pair-carry / triple-carry candidates inside `findFinalVictoryRoute`). They have the same constant-turn bug in their estimator, but they also lose on the primary ranking key to single-deliveries, so they don't affect outcomes here. Fix the carry branch; the multi-stop paths inherit the fix.
- LLM-side route planning. The fix is in the deterministic victory-route search.
- Backfill of past games. Going-forward only.

## Cross-references

- JIRA-245 — introduced `findFinalVictoryRoute`. This ticket fixes its turn-estimator for the carry case.
- JIRA-233 — added multiplicity-aware carry detection in `DeterministicTripPlanner` (`detectCarriedLoads` + `normalizeRows`). This ticket reuses those exports for `findFinalVictoryRoute`'s candidate set.
- JIRA-261 — `routesMatch` idempotency check. Behaved correctly in this game (suppressed override at T83/T84 when proposed = existing, fired at T85 when proposed diverged). Not implicated.
- JIRA-263 — `detectCarriedLoads` implicit-carry slice fix. Separate path; same theme (carry detection must match reality).
- JIRA-265 — surfaced the per-turn endGame trace that made this defect grep-able. Without that visibility the Bern-vs-Holland switch would have been invisible from the NDJSON.
- JIRA-266 — moved the `endGameLocked` latch to ContextBuilder. Not directly related but operates in the same end-game pipeline.
