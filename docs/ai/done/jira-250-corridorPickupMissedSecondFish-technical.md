# JIRA-250 — Candidate generator must enumerate "same supply, same load, multiple demands" corridor pickups (technical)

Companion to `jira-250-corridorPickupMissedSecondFish-behavioral.md`.

## Defect locus (provisional — needs log validation)

The deterministic candidate generator at `src/server/services/ai/DeterministicTripPlanner.ts` enumerates routes via pair/triple combinations of demand cards. When two demand cards have:

- Same `loadType`
- Same `supplyCity`
- Different `deliveryCity`

…the generator should emit a candidate of shape `[pickup(L@supply), pickup(L@supply), deliver(L@city1), deliver(L@city2)]` where the deliver order is chosen by network distance from the supply. The user's observed T46 behavior suggests this enumeration is either:

1. Not happening at all (the generator doesn't produce two-pickup-same-city candidates), OR
2. Happening but being filtered out by an affordability or simulation gate.

## Suspect: the carried-load demand matching collapses both demands into one

When the bot picked up Fish at T45, `bot.loads = ['Fish']`. The demand-context builder (`DemandEngine.scoreDemand` or equivalent) marks any Fish demand as `isLoadOnTrain = true` and sets `supplyCity = null` ("matched to carry"). At T46 both `Fish→Zurich` and `Fish→Milano` demands have `supplyCity = null`.

The candidate generator then treats both as "carried-delivery candidates" — *each* demand looks like a free delivery using the one Fish on board. But the bot has only ONE Fish chip. The generator may be computing the candidate `[deliver(Fish@Zurich), deliver(Fish@Milano)]` and scoring it as if both deliveries succeed (double payout, single load). Whichever scoring step is supposed to detect "you can only deliver one Fish" is missing.

When the scorer or executor rejects the double-delivery candidate (because the bot would arrive at Milano with no Fish remaining after delivering at Zurich), the planner falls back to a single-delivery candidate. It picks `Fish→Milano` (perhaps because it has the higher payout or is the new card) and discards the Fish→Zurich consideration entirely — instead of stepping back and recognizing "I should pick up a second Fish at Oslo to satisfy both demands."

## Fix shape

Three layers; layer 2 is the meat of the fix.

### Layer 1 — Demand-context builder: distinguish "carried satisfies" from "fresh"

In `src/server/services/ai/context/DemandEngine.ts` (or wherever `DemandContext.supplyCity` is set), if `loadType` is in `bot.loads`, the matched demand gets `supplyCity = null`. BUT if there are **more demand cards matching the same loadType than carried load chips**, only the first N (where N = carried count) should have `supplyCity = null`; the rest must retain their original `supplyCity` so the planner knows they require a fresh pickup.

Currently:
- `bot.loads = ['Fish']`, demands match `Fish→Zurich` + `Fish→Milano` → BOTH get `supplyCity = null`. **Wrong.**

Correct:
- Same scenario → ONE demand (e.g. the one with the closer deliveryCity) gets `supplyCity = null`; the OTHER retains `supplyCity = 'Oslo'`.

This makes the second demand visible to the candidate generator as a fresh pickup opportunity.

### Layer 2 — Candidate generator: emit "same supply, same load, ≥2 demands" candidates

In `DeterministicTripPlanner.enumerateCandidates`, add a generation rule:

```ts
// Group demands by (loadType, supplyCity); for each group with size ≥ 2 AND
// supplyCity !== null AND capacity allows multiple pickups, emit a candidate
// route with N pickups + N deliveries in network-distance order from supply.
for (const [(load, supply), demands] of groupBy(demands, d => [d.loadType, d.supplyCity])) {
  if (demands.length < 2 || supply === null) continue;
  if (carriedCount(load) + demands.length > capacity) continue;
  if (!loadChipAvailable(load, supply, demands.length)) continue;

  const deliveryOrder = orderByNetworkDistance(supply, demands.map(d => d.deliveryCity));
  const candidate = {
    stops: [
      ...Array(demands.length).fill(null).map(() => ({ action: 'pickup', loadType: load, city: supply })),
      ...deliveryOrder.map(city => ({ action: 'deliver', loadType: load, city, ... })),
    ],
  };
  yield candidate;
}
```

This matches the prompt-side `WORKED EXAMPLE — Cardiff×2 Hops` constraint (separate pickup stops, one per load unit), which currently lives only in `TRIP_PLANNING_SYSTEM_SUFFIX` for the LLM path.

### Layer 3 — Scorer: penalize "carry already matched" double-counting

Cross-check: when a candidate has two `deliver(L@x)` and `deliver(L@y)` stops without two preceding pickups (or two carried loads), reject the candidate as malformed. This is essentially the same invariant as JIRA-249's grammar check (`deliver` requires `pickup` OR `carriedLoads`), extended to handle the multiplicity case: each `deliver(L)` consumes one `L` from `carriedLoads ∪ pickupsSoFar`.

## Acceptance from behavioral

- **AC1** Unit test on `DeterministicTripPlanner.enumerateCandidates`: fixture matching T45 (bot at Oslo, loads=['Fish'], demands include both Fish→Zurich and Fish→Milano, capacity=2). Assert: candidate set includes a route shaped `[pickup(Fish@Oslo), deliver(Fish@Zurich), deliver(Fish@Milano)]` (note: starts with 1 pickup because bot already carries 1).
- **AC2** Unit test on demand-context builder: fixture with `bot.loads = ['Fish']` + 2 Fish demands. Assert: exactly ONE demand has `supplyCity = null`; the other retains its original supply city.
- **AC3** Unit test on candidate-grammar validator: a candidate with `[deliver(Fish@A), deliver(Fish@B)]` and `carriedLoads = ['Fish']` (only ONE Fish on train) is rejected as malformed.
- **AC4** Integration test replaying T45 snapshot: planner returns the corridor route, bot completes Oslo → Zurich → Milano without a second Oslo trip.
- **AC5** Reuse JIRA-250-AC2/AC3/AC4 from the behavioral spec (off-corridor, capacity limit, chip exhaustion variants).

## Not in scope

- N-way corridor optimization (3+ deliveries sharing partial paths).
- LLM-path corridor handling (the prompt already specifies the rule; this fix is for the deterministic path).
- Re-tuning candidate count cap if the new candidates blow up the enumeration size — separate JIRA if perf regresses.

## Validation hooks to inspect during fix

- `composition.a1.opportunitiesFound` at T45 — does Phase A1 (opportunistic pickup) notice the second Fish demand and the slot availability? If yes, A1 should have fired the second pickup before the planner re-ran. If A1 didn't notice, that's a co-occurring bug.
- `demandRanking[*]` at T46 — both Fish demands should appear; check their `supplyCity` values and `score`s.
- The trip planner's selected `route.reasoning` — does the LLM/deterministic logic mention the dropped Zurich delivery, or is the omission silent?

## Relationship to JIRA-248 and JIRA-249

- JIRA-248: replan drops carried-load delivery entirely. JIRA-250 is a related case where the carried load matches one demand but the second matching demand (requiring a fresh pickup at the same supply) is dropped.
- JIRA-249: malformed route emits deliver without prior pickup. JIRA-250's Layer 3 (grammar invariant for multiplicity) is the same family of check.
- All three should be fixed in coordination — they're symptoms of the same candidate-generator weakness around carried-load + matching-demand semantics.
