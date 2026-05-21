# JIRA-213 — Technical: contextScore re-scaling ignores estimatedTurns, and estimatedTurns itself is inflated

See `docs/jira/jira-213-behavioral.md` for the observed behavior.

This defect has **three compounding causes** in `InitialBuildPlanner.expandDemandOptions`:

1. **Cause A** — the contextScore-based efficiency formula ignores the per-option `estimatedTurns` it computes (cost-only re-scaling).
2. **Cause B** — the `estimatedTurns` formula itself overestimates by adding a `buildTurns` term that's already absorbed by the forced 2-turn initial build phase, and by adding a spurious `+1` padding to `travelTurns`.
3. **Cause C** — the `REMOTE_DELIVERY_CITIES` filter is applied to delivery cities only, even though "don't overextend track during initial build" is symmetric: a remote *supply* city demands the same overextension. Arhus is in the list but is still selectable as a supply, which is what created the candidate that beat Holland in this game.

Cause A makes the planner ignore the turn signal. Cause B distorts that signal. Cause C lets a remote supply enter the candidate set in the first place. The ranking went wrong at all three points; fixing only some of them leaves the others as latent failure modes (e.g. fixing A and B alone still admits remote supplies, just with the right-shaped turn penalty applied).

## Code paths reviewed

The end-to-end ranking pipeline that produced the Arhus-over-Holland decision:

1. `DemandEngine` (`src/server/services/ai/context/DemandEngine.ts`) computes one score per demand card. `scoreDemand` (line 262-286) is turn-aware:
   ```ts
   const incomeVelocity = payout / estimatedTurns;          // line 270
   const costBurden = totalTrackCost * COST_WEIGHT;          // 0.1 weight
   const rawScore = incomeVelocity - costBurden;             // line 272
   ```
   The `estimatedTurns` and `totalTrackCost` it uses are computed for **one supply path** per demand (the one DemandEngine selected — for Cheese → Berlin in this game it picked Holland: cost 19, turns 4). The per-card score is keyed on `loadType:deliveryCity`.

2. `InitialBuildRunner.runOpening` (`src/server/services/ai/InitialBuildRunner.ts:76-80`) flattens those scores into a `Map<scoreKey, number>` and hands it to the planner:
   ```ts
   const demandScores = new Map<string, number>();
   for (const d of context.demandRankings) {
     demandScores.set(`${d.loadType}:${d.deliveryCity}`, d.demandScore);
   }
   const buildPlan = InitialBuildPlanner.planInitialBuild(snapshot, gridPoints, demandScores);
   ```

3. `InitialBuildPlanner.expandDemandOptions` (`src/server/services/ai/InitialBuildPlanner.ts:160-298`) then enumerates **every supply city × every starting city** for each demand. For each candidate it has its own freshly-computed `costs.totalBuildCost` (line 200) and `estimatedTurns` (line 228). But when injecting the per-card `contextScore` it scales by **build cost alone**:
   ```ts
   // InitialBuildPlanner.ts:231-247
   const scoreKey = `${demand.loadType}:${demand.city}`;
   const contextScore = demandScores?.get(scoreKey);
   if (contextScore !== undefined) {
     const localCostFactor = Math.max(0, 1 - costs.totalBuildCost / MAX_BUILD_BUDGET);
     if (contextScore >= 0) {
       efficiency = contextScore * (1 + localCostFactor);
     } else {
       efficiency = contextScore / (1 + localCostFactor);
     }
   } else {
     efficiency = (demand.payment - costs.totalBuildCost) / estimatedTurns;
   }
   ```
   `localCostFactor` is a function of `totalBuildCost` only. `estimatedTurns` is computed (line 228) and stored on the option (line 282), but it never enters the score for the contextScore branch.

## Why this produces the observed ranking

For Cheese → Berlin in game `c6a99a57`, both Arhus and Holland share the same `contextScore` (call it `S` ≈ +0.6, derived from DemandEngine's evaluation of the Holland path). The two options diverge only on `localCostFactor`:

| option | totalBuildCost | localCostFactor | efficiency = S × (1 + localCostFactor) |
|--------|----------------|-----------------|----------------------------------------|
| Arhus | 16 | 1 − 16/40 = 0.60 | S × 1.60 ≈ **0.96** |
| Holland | 19 | 1 − 19/40 = 0.525 | S × 1.525 ≈ **0.91** |

Both numbers match the log exactly. The cheaper-build option always wins this branch when the per-card baseline is positive — even when its own `estimatedTurns` is higher.

The fallback formula on line 249 (`(payment − cost) / estimatedTurns`) *would* have produced the right ranking:
- Arhus: (10 − 16) / 5 = **−1.20**
- Holland: (10 − 19) / 4 = **−2.25**

(It would have ranked Arhus first, but that's actually because both are negative — the right formula needs to reward fewer turns at all values, not just punish more cost.)

## Root cause A — efficiency ignores estimatedTurns

`InitialBuildPlanner.expandDemandOptions` treats the per-card `demandScore` as an absolute baseline that can only be re-scaled by build cost. The per-supply-candidate `estimatedTurns` — which captures the full picture of "how many turns until the delivery happens" including the round-trip travel that distinguishes Arhus from Holland — is computed but discarded for the score that drives ranking.

The DemandEngine score baked in *its own* `estimatedTurns` for *its own* chosen supply path, but that turn count cannot represent every alternative supply, so the planner has to re-derive turns per candidate and integrate them. It does the first half (computing) but not the second (integrating).

## Root cause B — estimatedTurns formula overcounts in the initial-build context

The formula at `InitialBuildPlanner.ts:206-228` is:
```ts
const speed = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9;
const buildTurns = Math.ceil(costs.totalBuildCost / 20);
const travelDistance = (hexToSupply ?? 0) + (hexSupplyToDelivery ?? 0);
const travelTurns = Math.ceil(travelDistance / speed) + 1;
const estimatedTurns = Math.max(buildTurns + travelTurns, 1);
```

For game `c6a99a57`, plugging in the actual coordinates from `configuration/gridPoints.json`:

| option | hex distance (planner) | speed | buildTurns | travelTurns (formula) | estimatedTurns (formula) | true movement turns |
|--------|-----------------------|-------|------------|----------------------|--------------------------|---------------------|
| Holland | 13 (one-way) | 9 | ⌈19/20⌉ = 1 | ⌈13/9⌉+1 = 3 | **4** | ⌈13/9⌉ = **2** |
| Arhus | 22 (round-trip) | 9 | ⌈16/20⌉ = 1 | ⌈22/9⌉+1 = 4 | **5** | ⌈22/9⌉ = **3** |

Two distinct overcounts:

**B1. `buildTurns` is double-counted during initial build.** The initial-build phase is *2 forced turns* with a 40M total budget (20M/turn × 2). Routes whose `totalBuildCost ≤ 40` consume zero turns *beyond* the forced phase — the build fits inside turns the bot was going to spend building anyway. Adding `Math.ceil(cost/20)` to `estimatedTurns` charges the bot for build time it gets for free during the opening. This term is only meaningful when the build extends past the initial-build budget (cost > 40), which is filtered out earlier (`MAX_BUILD_BUDGET = 40`, line 41), meaning *every option entering this code path* has `buildTurns ∈ {1, 2}` of pure overcount.

**B2. `+1` padding on `travelTurns` is unjustified.** Picking up and unloading don't reduce movement (rules: "Picking up or unloading a load does not reduce movement"). Reversing direction at a major city milepost is also free. There is no game-mechanical justification for the `+1`. Possibly intended as a buffer for path-vs-hex divergence (real track is slightly longer than hex distance), but if so it should be a multiplicative factor, not an additive constant — and ideally it should use estimated path length, not raw hex distance.

The combined effect: every option's `estimatedTurns` is inflated by `buildTurns + 1`, which is roughly +2 across the board. This compresses the ranking ratio. Holland's *real* turn count of 2 vs Arhus's 3 is a 50% premium; the formula's 4 vs 5 is only 25%. When fed into a turn-aware scoring formula (Cause A's fix), the compressed ratio reduces the corrective force.

## Root cause C — remote-city filter is asymmetric (delivery-only)

The set at `InitialBuildPlanner.ts:35-38`:
```ts
const REMOTE_DELIVERY_CITIES = new Set([
  'Nantes', 'Bordeaux', 'Bilbao', 'Porto', 'Lisboa', 'Madrid',
  'Roma', 'Napoli', 'Kobenhavn', 'Arhus', 'Goteborg', 'Oslo', 'Stockholm',
]);
```

Used at line 180 in the inner loop:
```ts
// Skip remote delivery cities — they require overextended track during initial build
if (REMOTE_DELIVERY_CITIES.has(demand.city)) continue;
```

The filter is checked against `demand.city` (the delivery target) only. The supply candidate (`supplyCity`, the variable iterated immediately above) is unfiltered. The rationale recorded in the comment — "they require overextended track during initial build" — applies just as much when the bot must extend track *to reach a remote supply* as when it must extend track *to reach a remote delivery*. Both directions consume the same kind of build budget and travel turns.

For game `c6a99a57`, the cheese sources for Berlin are Arhus (remote, 13 mileposts north of Berlin), Holland (continental hub), Kobenhavn (remote), and Bern (continental). The filter rejects only the rare delivery-into-Arhus case, but freely admits the much more common supply-from-Arhus case. That's how Arhus reached the candidate set as a viable supply.

## Fix plan

### Step 0 — Apply the remote-city filter symmetrically (Cause C)

Rename `REMOTE_DELIVERY_CITIES` to `REMOTE_INITIAL_BUILD_CITIES` (or similar; the new name is the locus of the policy, not its application direction), and check it against both `supplyCity` and `demand.city` inside `expandDemandOptions`:

```ts
// InitialBuildPlanner.ts:35-38 — proposed (rename, same membership)
const REMOTE_INITIAL_BUILD_CITIES = new Set([
  'Nantes', 'Bordeaux', 'Bilbao', 'Porto', 'Lisboa', 'Madrid',
  'Roma', 'Napoli', 'Kobenhavn', 'Arhus', 'Goteborg', 'Oslo', 'Stockholm',
]);

// InitialBuildPlanner.ts:174-181 — proposed (filter both ends)
for (const supplyCity of sourceCities) {
  // Check load availability at supply city
  const available = snapshot.loadAvailability[supplyCity];
  if (!available || !available.includes(demand.loadType)) continue;

  // Skip remote cities at either end — they require overextended track during initial build
  if (REMOTE_INITIAL_BUILD_CITIES.has(supplyCity)) continue;
  if (REMOTE_INITIAL_BUILD_CITIES.has(demand.city)) continue;
  // ...
}
```

Note the position: the supply check should be the *first* test inside the supplyCity loop (or merged with the load-availability check), so that a remote supply skips the entire grid-points / build-cost computation that follows. The delivery check can remain where it is (it's invariant across the supplyCity loop, but moving it outside the loop is a minor optimisation, not necessary for correctness).

The `emergencyFallback` path (line 713-791) already does *not* apply this filter — see comment at line 32-34 ("emergencyFallback() does NOT apply this filter — they remain available as last resort"). That intent should be preserved: when no continental supply is feasible, falling back to a remote supply is still better than no plan. Leave `emergencyFallback` unchanged.

After Step 0, for game `c6a99a57`'s Cheese → Berlin demand, the candidate set becomes: Holland (continental), Bern (continental). Arhus and Kobenhavn are filtered out as remote supplies. Holland wins on the existing scoring without needing Step 1 or Step 2 — but Steps 1 and 2 are still required to fix the underlying ranking bug for any *other* turn where two non-remote candidates compete and the cheaper-build / longer-trip one wins incorrectly.

### Step 1 — Fix `estimatedTurns` so it reflects real game-clock cost in the initial-build context

In `InitialBuildPlanner.ts:206-228`, replace the `buildTurns + travelTurns` aggregation with a turn count that:
- Drops `buildTurns` for any route whose `totalBuildCost` fits within the initial-build budget (which is every route reaching this code path, given the `MAX_BUILD_BUDGET = 40` filter at line 204).
- Drops the `+1` padding from `travelTurns`.

```ts
// InitialBuildPlanner.ts — proposed (replaces lines 206-228)
const speed = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType]?.speed ?? 9;

// Travel distance via hex (milepost proxy). Same as today.
const startPoints = gridPoints.filter(gp => gp.city?.name === group.cityName);
const supplyGridPoints = gridPoints.filter(gp => gp.city?.name === supplyCity);
const deliveryGridPoints = gridPoints.filter(gp => gp.city?.name === demand.city);
let hexToSupply = Infinity;
for (const sp of startPoints) {
  for (const sup of supplyGridPoints) {
    const d = hexDistance(sp.row, sp.col, sup.row, sup.col);
    if (d < hexToSupply) hexToSupply = d;
  }
}
let hexSupplyToDelivery = Infinity;
for (const sup of supplyGridPoints) {
  for (const dp of deliveryGridPoints) {
    const d = hexDistance(sup.row, sup.col, dp.row, dp.col);
    if (d < hexSupplyToDelivery) hexSupplyToDelivery = d;
  }
}
const travelDistance = (hexToSupply === Infinity ? 0 : hexToSupply)
  + (hexSupplyToDelivery === Infinity ? 0 : hexSupplyToDelivery);

// Movement turns to deliver, no padding. Pickup/deliver/reverse-at-city are free.
const travelTurns = Math.max(1, Math.ceil(travelDistance / speed));

// Build turns *beyond* the forced 2-turn initial build phase.
// MAX_BUILD_BUDGET filter above guarantees totalBuildCost ≤ 40, so this is 0
// today — but kept explicit for safety and future-proofing if MAX_BUILD_BUDGET changes.
const INITIAL_BUILD_BUDGET = 40;
const buildOverflowCost = Math.max(0, costs.totalBuildCost - INITIAL_BUILD_BUDGET);
const buildTurns = Math.ceil(buildOverflowCost / 20);

const estimatedTurns = Math.max(buildTurns + travelTurns, 1);
```

Numerical check on game `c6a99a57`:
- Holland: travelTurns = ⌈13/9⌉ = 2, buildTurns = 0, **estimatedTurns = 2** ✓
- Arhus: travelTurns = ⌈22/9⌉ = 3, buildTurns = 0, **estimatedTurns = 3** ✓

### Step 2 — Make the contextScore branch turn-aware

Replace the cost-only `localCostFactor` with a factor that incorporates per-option `estimatedTurns`. The simplest expression preserving the existing sign-handling (positive vs negative scores must scale in opposite directions to keep ranks intuitive):

```ts
// InitialBuildPlanner.ts:231-247 — proposed
const scoreKey = `${demand.loadType}:${demand.city}`;
const contextScore = demandScores?.get(scoreKey);
let efficiency: number;
if (contextScore !== undefined) {
  const localCostFactor = Math.max(0, 1 - costs.totalBuildCost / MAX_BUILD_BUDGET);
  // Turn factor: 1.0 at minimum-feasible turns (~2), decays as turns grow.
  // With Step 1's corrected estimatedTurns, "2" represents an immediate one-leg delivery.
  const TURN_REFERENCE = 2;
  const localTurnFactor = TURN_REFERENCE / Math.max(estimatedTurns, TURN_REFERENCE);
  const localFactor = (localCostFactor + localTurnFactor) / 2;
  if (contextScore >= 0) {
    efficiency = contextScore * (1 + localFactor);
  } else {
    efficiency = contextScore / (1 + localFactor);
  }
} else {
  efficiency = (demand.payment - costs.totalBuildCost) / estimatedTurns;
}
```

Numerical check on game `c6a99a57`, with `S ≈ 0.6` and the corrected `estimatedTurns` from Step 1:
- Arhus: localCostFactor = 0.60, localTurnFactor = 2/3 ≈ 0.67, localFactor ≈ 0.633 → 0.6 × 1.633 ≈ **0.98**
- Holland: localCostFactor = 0.525, localTurnFactor = 2/2 = 1.00, localFactor = 0.7625 → 0.6 × 1.7625 ≈ **1.06**

Holland now ranks above Arhus by ~8% efficiency margin. The exact constants (`TURN_REFERENCE`, the 50/50 weighting in `localFactor`) should be tuned, but with Step 1's fix in place the turn signal carries enough magnitude to flip the ranking.

### Step 3 — Add regression tests mirroring the game-c6a99a57 setup

In `src/server/__tests__/ai/InitialBuildPlanner.test.ts` (or wherever `expandDemandOptions` tests live), add three tests:

- **Test (a) — Cause C, remote-supply filter.** Demand: Cheese → Berlin. Seeded supplies include Arhus (a remote-set member) and Holland. Assert that the produced options list contains no entry with `supplyCity === 'Arhus'`. Assert it contains a `supplyCity === 'Holland'` entry.
- **Test (b) — Cause B, `estimatedTurns` shape.** Two single-leg options with seeded hex distances 13 (Holland → Berlin, freight speed 9) and 22 round-trip (Berlin → Arhus → Berlin). Assert `estimatedTurns` is **2** for Holland and **3** for Arhus. (Test must use a non-remote supply pair; substitute non-remote stand-ins if the test fixtures use the real city geometry.)
- **Test (c) — Cause A, ranking outcome.** With both candidates non-remote and `demandScores` map `{"<load>:<delivery>": ~0.6}` (positive baseline), assert that the lower-`estimatedTurns` candidate ranks above the lower-`totalBuildCost` candidate when the two diverge.

All three tests should fail under the current code and pass under the proposed fixes for Causes A, B, and C respectively.

### Step 4 — Audit for callers of `estimatedTurns` that may depend on the old inflated values

`estimatedTurns` is also surfaced in:
- `initialBuildOptions` NDJSON diagnostics (`InitialBuildPlanner.ts:76`) — purely informational, no behavior depends on it.
- `InitialBuildPlan.estimatedTurns` (`InitialBuildPlanner.ts:133, 150`) — returned to the caller for the chosen plan. Used in logging and possibly downstream comparisons.

Search for downstream consumers (`grep "InitialBuildPlan\|\.estimatedTurns" src/server`) to confirm no logic gates on the absolute magnitude of this number; if any do, they need to be reviewed against the post-fix scale.

### Step 5 — Verify no regression in existing rankings

Re-run the existing `InitialBuildPlanner` test suite. Tests that depend on the *numeric* `estimatedTurns` or `efficiency` values will need their expectations updated; tests that assert *relative ranking* should continue to hold for cases where cost and turns are correlated.

## Affected code

- `src/server/services/ai/InitialBuildPlanner.ts:35-38` — rename `REMOTE_DELIVERY_CITIES` → `REMOTE_INITIAL_BUILD_CITIES` (Cause C)
- `src/server/services/ai/InitialBuildPlanner.ts:174-181` — add the remote-supply filter alongside the existing remote-delivery filter (Cause C)
- `src/server/services/ai/InitialBuildPlanner.ts:32-34` — update the doc-comment about which paths apply the filter (still mentions delivery only)
- `src/server/services/ai/InitialBuildPlanner.ts:206-228` — `estimatedTurns` formula (Cause B fix)
- `src/server/services/ai/InitialBuildPlanner.ts:231-247` — efficiency formula in the contextScore branch (Cause A fix)
- `src/server/__tests__/ai/InitialBuildPlanner.test.ts` — add the three regression tests described above; update any tests asserting exact `estimatedTurns` or `efficiency` numerics, and any tests that rely on a remote city being selectable as a supply during initial build

## Out of scope (per behavioral)

- DemandEngine's own scoreDemand formula. It is turn-aware and correct for its chosen supply path; the issue is that its single per-card score must be re-scaled per-supply-candidate by the planner.
- The per-pair "best starting city" selection at line 286 (`if (!bestForPair || estimatedTurns < bestForPair.estimatedTurns ...)`). That logic is already turn-aware. After Step 1, the turn comparison uses the corrected (un-padded) values — same relative ranking, sharper magnitudes.
- The `(demand.payment − costs.totalBuildCost) / estimatedTurns` fallback formula on line 249. It is reached only when no contextScore is provided, which is not the case in this game. After Step 1 it would yield slightly different absolute numbers but the same orderings.
- Tuning the exact constants (`TURN_REFERENCE`, the 50/50 weighting in `localFactor`). These should be calibrated against more games once the structural fix is in.
- Applying the symmetric remote-city filter outside `expandDemandOptions` (e.g. to `emergencyFallback` at line 713-791). `emergencyFallback` is a last-resort path designed to relax filters; preserving its current looser behaviour is intentional.
- Reviewing the membership of `REMOTE_INITIAL_BUILD_CITIES`. The thirteen cities in the existing list are taken as given.
- The pairing (`scorePairing`, `scoreSharedPickupPairing`) and emergency-fallback paths' own `estimatedTurns` formulas. They have similar shape and likely the same overcount, but those branches did not fire for this turn — out of scope until observed in a separate game.
