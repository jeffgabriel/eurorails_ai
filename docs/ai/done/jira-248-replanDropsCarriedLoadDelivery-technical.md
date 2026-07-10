# JIRA-248 — Carried-load deliveries must be a hard inclusion in every replan (technical)

Companion to `jira-248-replanDropsCarriedLoadDelivery-behavioral.md`.

## Defect locus (provisional — needs log validation)

The trip planner's candidate generator builds candidate routes from `context.demands`. For a demand card with `supplyCity = null` (= load already on train), the candidate-builder must treat the delivery city as a **required stop** — not an optional one weighed against alternatives.

Likely sites:

- `src/server/services/ai/DeterministicTripPlanner.ts` — `enumerateCandidates` and downstream `scoreCandidate` / `computeAggregateScore`. The aggregation may be choosing a single best candidate without enforcing the constraint "every carried load with a matching demand must appear as a deliver stop." When the alternative-pair score (Tourists pair) is higher than the carried-load-inclusive pair, the carried delivery gets dropped.
- `src/server/services/ai/prompts/ContextSerializer.ts` — if the LLM path is used (Hard skill) the prompt may not make carried loads sufficiently salient, but Sonnet here is Medium so this is the deterministic path.
- `src/server/services/ai/context/DemandEngine.ts` — `scoreDemand` may be rejecting `isLoadOnTrain && supplyCity === null` cards under some filter (`isAffordable` / network reachability), even though their delivery is mechanically achievable.

## Suspect: the affordability gate filters out carried-load demands when cash is low

The JIRA-207B "no actionable demands → short-circuit DiscardHand" filter (`TripPlanner.ts:145-166`) requires `d.isAffordable` for a demand to be considered. For a carried-load demand, `isAffordable` likely measures cost-to-reach-delivery. If the bot is low on cash or far from Bern, the Labor→Bern demand may evaluate `isAffordable = false`, exiting the planner's actionable-demand set.

If that's the cause, the fix is to **bypass the affordability check for `isLoadOnTrain` demands**: a carried load is sunk cost, the delivery requires only `cost-to-reach-delivery` (no pickup detour), and the planner must always consider it.

## Fix shape

Two layers — both should be applied.

### Layer 1 — `DeterministicTripPlanner.enumerateCandidates` (the contract)

When building candidate routes, every `pickup → deliver` pair must respect this invariant: **for every demand `d` in `context.demands` where `d.isLoadOnTrain === true` AND `d.deliveryCity` is reachable**, the candidate's stops must include a `deliver(d.loadType, d.deliveryCity)` stop OR the candidate must record an explicit deferral reason.

Concretely:
1. Partition `context.demands` into `mandatoryDeliveries` (carried loads with matching demand cards) and `optionalPairs` (everything else).
2. The base candidate is `mandatoryDeliveries.map(d => deliverStop(d))`. This is the "deliver-only" candidate.
3. Optional pickup/deliver pairs from `optionalPairs` are added if they improve aggregate score WITHOUT removing mandatory deliveries.
4. If a candidate proposes removing a mandatory delivery, it must record `deferredReason: string` on the route metadata, and the deferred load's cargo cost must be counted against the candidate's score.

### Layer 2 — `TripPlanner.planTrip` JIRA-207B short-circuit (the affordability gate)

In `TripPlanner.ts:145-166`, change `actionableDemands` filter from:
```ts
const actionableDemands = context.demands.filter(d => d.isAffordable && (!d.isLoadOnTrain || !hasRemainingStops));
```
to something like:
```ts
const carriedDeliveryDemands = context.demands.filter(d => d.isLoadOnTrain && d.isDeliveryReachable);
const freshDemands = context.demands.filter(d => !d.isLoadOnTrain && d.isAffordable);
const actionableDemands = [...carriedDeliveryDemands, ...freshDemands];
```

Carried-load deliveries are never "unaffordable" in the same sense fresh demands are, because no pickup spend is required.

## Acceptance from behavioral

- **AC1** Unit test: fixture with one carried Labor + matching demand card + 4 cheap alternatives. `planTrip` returns a route that either includes `deliver(Labor@Bern)` or has a non-empty `deferredReason`.
- **AC2** Unit test: vary `bot.money` from 0 to 100. Assert `deliver(Labor@Bern)` candidate is always evaluated (not filtered by affordability gate).
- **AC3** Integration test: replay Sonnet T28 snapshot for 5 turns; assert the bot either delivers Labor→Bern within 4 turns or drops the load.
- **AC4** Validator test: `pickup(Labor@Beograd)` is rejected by the action grammar validator when bot.loads already contains Labor (the T28 garbage stop).

## Not in scope

- Re-tuning the affordability heuristic itself (separate JIRA if needed).
- Adding a UI surface for the bot to *announce* a deferral reason to the player (logging is enough).
- Phase 4 event-card interactions with carried loads.

## Validation hooks to inspect during fix

- `composition.a1.opportunitiesFound` — should include carried-load deliveries when bot is near a matching delivery city.
- `composition.deliveries` — should NOT be empty across multiple consecutive turns when a carried-load demand exists.
- `demandRanking[*]` — carried-load demands should appear in the ranking with a non-degenerate score (currently they may be filtered out).
