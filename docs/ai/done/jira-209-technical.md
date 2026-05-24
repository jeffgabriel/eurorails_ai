# JIRA-209 — Technical fix plan

Companion to `jira-209-behavioral.md`.

## Root cause

`src/server/services/ai/context/DemandEngine.ts:506`:

```ts
const isColdStart = snapshot.bot.existingSegments.length === 0;
```

This single boolean gates whether the demand ranker uses `estimateColdStartRouteCost` (which iterates major cities as candidate starts and picks the cheapest start+route combination) or falls through to the `estimateTrackCost` spur-from-existing-track path. The condition flips from `true` to `false` the instant the initial-build-planner places its first segment.

In practice the demand ranker is invoked *after* the initial-build-planner commits its first build of the game. By the time `demandRanking` is computed and snapshotted into the per-turn game log, `existingSegments.length` is already `> 0` — `5` in the observed trace (Flash, turn 2, `segmentsBuilt: 5`). The cold-start branch never executes for any demand other than (possibly) the one the initial-build-planner itself chose, and even that one's cold-start estimate is not surfaced in the logged ranking.

The downstream effect is documented in the behavioral report: every non-chosen demand in the hand gets evaluated as "cost to add two independent spurs from the existing committed track" instead of "cost of the cheapest fresh start for this demand," and the resulting `trackCostToSupply` / `trackCostToDelivery` figures are systematically inflated (in the observed trace, ~2x — 69M vs. 34M true minimum).

## What the cold-start branch actually does (and why we want it back)

`DemandEngine.ts:508-517`:

```ts
if (isColdStart && supplyCity && !isLoadOnTrain) {
  const coldStartResult = estimateColdStartRouteCost(supplyCity, deliveryCity, gridPoints);
  if (coldStartResult) {
    estimatedTrackCostToSupply = coldStartResult.supplyCost;
    estimatedTrackCostToDelivery = coldStartResult.deliveryCost;
    optimalStartingCity = coldStartResult.startingCity;
  } else { ... }
}
```

`estimateColdStartRouteCost` (`DemandEngine.ts:380-451`) iterates every major-city group as a candidate starting city, computes for each:

- `supplyCost = path(start, supplyCity)` (Dijkstra over hex grid)
- `hubDelivery = path(start, deliveryCity)` (cost of building a delivery spur from the start)
- `linearDelivery = min path(supply, delivery)` (cost of building delivery as a continuation of the supply spur)
- picks the cheaper of `hubTotal` and `linearTotal`, records which one won (`isHubModel`)

…and returns the (start, supplyCost, deliveryCost, isHubModel) tuple for the best major city. This is exactly the estimate the report wants for any demand that is being evaluated *before* the bot has committed to a starting-city / build-corridor decision.

After the initial-build-planner has committed, the spur-from-track formula is correct for the *committed* corridor. But it is wrong for any demand whose optimal route does not pass through the committed track — which, in a 9-card hand, is most of them.

## Fix

Replace the segments-emptiness check with a check that stays `true` for the entirety of the initial-build phase. The initial-build phase is two turns long (per game rules) and is identifiable from existing snapshot fields:

- `snapshot.bot.position === null` — pawn not yet placed (precise indicator that this is still pre-movement)
- `snapshot.gamePhase` (if exposed) — the AIStrategyEngine and game logger already distinguish between phases
- `snapshot.turnNumber <= 2` — coarsest, most fragile indicator; avoid

### 1. Confirm the predicate against the snapshot type

`src/server/services/ai/context/types.ts` (or wherever `WorldSnapshot` is defined) — read `snapshot.bot` and confirm which fields are available. The behavioral evidence shows `position` is `null` on turn 2; verify whether it stays `null` through the entire initial-build phase or only until the planner places the pawn at the end of the second build turn.

If `position === null` is the right indicator, prefer it. It captures the actual semantic ("the bot has not started moving yet") rather than a turn-count proxy.

If `gamePhase` is plumbed through to `WorldSnapshot`, prefer that — it is the most explicit of the three. Search call sites for `gamePhase: "initial-build"` (or similar) to confirm what the existing convention is.

### 2. Patch `DemandEngine.ts:506`

Replace:

```ts
const isColdStart = snapshot.bot.existingSegments.length === 0;
```

with one of (in preference order):

```ts
// Preferred: explicit phase check if available
const isColdStart = snapshot.gamePhase === 'initial-build';

// Fallback: pre-movement check
const isColdStart = snapshot.bot.position === null;

// Last resort: combine segments-emptiness with a pre-movement indicator
const isColdStart =
  snapshot.bot.existingSegments.length === 0 ||
  snapshot.bot.position === null;
```

The third form is the safest behavioral diff — it preserves the old `length === 0` semantics for any caller that depends on them, and only widens cold-start eligibility for the in-phase pre-movement case.

### 3. Confirm `estimateColdStartRouteCost` handles the "some segments exist" case

The cold-start branch was originally written assuming `segments.length === 0`, so `estimateColdStartRouteCost` ignores `existingSegments` entirely (it iterates major cities, not track endpoints). That is the intended behavior — when the demand ranker is asked "what would this demand cost if I were starting fresh," the existing segments should be ignored. The function as written already does this. No change needed.

The one subtle interaction: when this fix lands, on turn 2 the demand ranker will report cold-start figures for *every* demand including the one the initial-build-planner is currently building toward. The figures will be the cold-start optimum, not "cost to extend the current build." That is the correct behavior for a ranking output — the score is meant to answer "is this demand competitive at its best-case cost," not "how much further do I need to build to finish the in-progress route." Downstream consumers that need the latter should call `estimateTrackCost` directly with `snapshot.bot.existingSegments`.

### 4. Update logged `optimalStartingCity` plumbing

`DemandEngine.ts:513`:

```ts
optimalStartingCity = coldStartResult.startingCity;
```

This local is computed but I have not traced whether it is propagated to the logged `demandRanking` row. If it is not, propagate it — the per-turn game log row for a Wood/Sarajevo→Lodz demand should record `optimalStartingCity: "Wien"` so that downstream analysis can see "the best start for this demand was Wien" without re-running the pathfinder. This is a small additive change to the `demandRanking` schema in `AIStrategyEngine.ts:88` and the construction at `:741-742`.

## Tests

Add a unit test in `src/server/__tests__/ai/DemandEngine.test.ts` (create if absent) that:

1. Constructs a `WorldSnapshot` for Flash on turn 2 of `02be02dc`: position `null`, segments [5 fake segments anchored at Milano going west], hand including Wood/Sarajevo/Lodz.
2. Calls the demand engine.
3. Asserts the Wood row has `trackCostToSupply: 20, trackCostToDelivery: 14, optimalStartingCity: "Wien"` (the cold-start optimum), not 31/38.

A second case: same setup but with `position` set to a Milano outpost (post-placement). Assert the Wood row reverts to spur-from-track figures (~28-31M / ~36-41M). This locks in the phase-gated behavior.

## Sequencing

This fix is small, low-risk, and orthogonal to the corridor-vs-spur defect (separately filed, out of scope here). Recommended order:

1. Land step 1 (confirm predicate) and step 2 (patch the gate) together — single-file, single-line behavioral change plus tests.
2. Step 4 (propagate `optimalStartingCity` through logging) as a follow-up if the analysis tooling actually needs it. Skip if not.

No interaction with JIRA-207 / JIRA-208 fixes. No prompt changes. No model changes. The only behavioral diff is "demand ranking on turns 1-2 reports cold-start optimum costs instead of spur-from-track costs," which is the intended fix.

## What this fix does not address

- The corridor-vs-spur defect: `estimateTrackCost` evaluates `supply` and `delivery` as two independent spurs from existing track even when one lies on the path to the other. After this fix lands, the cold-start branch (which uses the corridor-aware `estimateColdStartRouteCost`) handles turns 1-2 correctly. Turns 3+ still use the spur-only `estimateTrackCost` and remain inflated. That is a separate ticket.
- The behavior of `estimateTrackCost` in cold-start *fallback* mode (when `estimateColdStartRouteCost` returns `null`): the `else` branch at `DemandEngine.ts:514-517` falls through to plain `estimateTrackCost(supplyCity, segments, gridPoints)` even though `segments.length === 0` in the cold-start branch. With empty segments, `estimateTrackCost` walks its own cold-start path (the major-city minimum-distance fallback at `:140-153`), which is similar in spirit but does not consider the supply→delivery corridor. Not in scope here.
- Any change to how the initial-build-planner *itself* uses the demand ranker. The planner consumes the ranking but its own selection logic is unchanged by this fix.
