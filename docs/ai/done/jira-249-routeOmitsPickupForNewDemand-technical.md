# JIRA-249 — Deterministic candidate generator must enforce the pickup-precedes-deliver invariant (technical)

Companion to `jira-249-routeOmitsPickupForNewDemand-behavioral.md`.

## Defect locus (provisional — needs log validation)

Two likely sites; the fix probably needs both.

### Site A — `DeterministicTripPlanner.ts` candidate generation

`src/server/services/ai/DeterministicTripPlanner.ts` — `enumerateCandidates` (or whichever function builds the candidate's `stops` array). When the trip planner is invoked at T15 with a freshly drawn `Wine → Praha (supply Frankfurt)` card, the generator either:

1. Looked at the *stale* `snapshot.bot.loads` that still contained Wine (a snapshot-sync bug), and concluded the load is "already carried" so no pickup needed, OR
2. Generated a candidate with only the deliver stop because the new demand's `supplyCity` field was being misread or the candidate template defaulted to deliver-only.

Path (1) is more likely given the T14 → T15 transition involves a `Wine` load delivery (`Wine → Warszawa` was carried at T14), so `snapshot.bot.loads` may not have been updated to reflect the delivery before the new trip plan ran.

### Site B — `TripPlanner.ts` candidate validation

`src/server/services/ai/TripPlanner.ts` — `scoreCandidates` / `validCandidates`. Whatever validation runs on the candidate set should reject a candidate with a deliver stop for which `(no prior pickup) AND (load not in snapshot.bot.loads)`. Currently it appears to admit such candidates.

The LLM path's action-grammar rules (`TRIP_PLANNING_SYSTEM_SUFFIX` lines 183-186) explicitly call this out — "DELIVER requires a prior PICKUP in the same stop sequence, OR the load must already be in your CURRENT PLAN carried loads." The deterministic path needs the same constraint enforced in code, not in prompt instruction.

## Fix shape

### Step 1 — Validate snapshot sync at trip-planner invocation

Before `DeterministicTripPlanner.planTripDeterministic` (or the LLM path equivalent) runs, assert:
```ts
// snapshot.bot.loads must reflect what is actually carried after all prior
// in-turn actions (including any deliver that just fired during MovementPhase A1).
// If snapshot is stale, every downstream candidate-generation decision is wrong.
```

Audit the call path between `TurnExecutor.handleDeliverLoad` and the next `TripPlanner.planTrip` invocation in the same turn. If the snapshot mirror in `handleDeliverLoad` (around `snapshot.bot.loads = snapshot.bot.loads.filter(l => l !== loadType)`) does not run before the post-delivery replan, we have a stale-loads bug.

### Step 2 — Add a candidate-validator invariant

In `DeterministicTripPlanner.scoreCandidate` (or wherever final route shapes are validated), reject any candidate failing this invariant:

```ts
function isCandidateGrammaticallyValid(
  candidate: CandidateRoute,
  carriedLoads: string[],
): boolean {
  const carriedAtStart = new Set(carriedLoads);
  const pickedUpInRoute = new Set<string>();

  for (const stop of candidate.stops) {
    if (stop.action === 'pickup') {
      pickedUpInRoute.add(stop.loadType);
    } else if (stop.action === 'deliver') {
      if (!carriedAtStart.has(stop.loadType) && !pickedUpInRoute.has(stop.loadType)) {
        return false; // deliver-without-pickup, candidate is malformed
      }
    }
  }
  return true;
}
```

Reject malformed candidates at score time; never let them become the active route.

### Step 3 — Add a defensive runtime guard

`MovementPhasePlanner` should detect "bot at delivery city but lacks the load" and trigger a replan instead of emitting PassTurn. If the planner's grammar check at Step 2 fails to catch a malformed route in some edge case, runtime should not silently waste a turn. Set `terminationReason = 'arrived_for_deliver_but_load_not_carried'` and trigger an immediate `TripPlanner` replan.

## Acceptance from behavioral

- **AC1** Unit test on `DeterministicTripPlanner.planTripDeterministic`: fixture with `bot.loads = []`, demand `Wine → Praha (supply Frankfurt)`. Assert: returned route contains a `pickup(Wine@Frankfurt)` stop preceding the deliver, OR does not reference Wine at all.
- **AC2** Unit test on candidate validator: pass a hand-crafted malformed candidate (deliver without pickup, load not in `carriedLoads`). Assert: validator returns false / candidate is filtered out of the scored set.
- **AC3** Integration test replaying T14→T15 hand turnover: simulate Wine→Warszawa delivery + Wine→Praha card draw + immediate planner re-invocation. Assert: bot's T15 active route is grammatically valid OR replanner detects malformation and re-runs.
- **AC4** Runtime guard test: simulate the malformed-route case (bot at Praha, route stop = deliver Wine, loads empty). Assert: planner emits `terminationReason = 'arrived_for_deliver_but_load_not_carried'` and re-invokes TripPlanner instead of PassTurn.

## Not in scope

- Changing the LLM prompt (the prompt already states this constraint, line 183-186 of `systemPrompts.ts`); the fix is in the deterministic candidate generator + validator.
- Reworking the demand-hand turnover logic.
- Phase 4 event-card draw effects on hand turnover.

## Validation hooks to inspect during fix

- The transition `bot.loads` between T14 (carrying Wine) and T15 (after Warszawa delivery, before Praha card draw). If `snapshot.bot.loads` at the T15 planner invocation still contains Wine, the snapshot mirror is the bug, not the candidate generator.
- The `actionableDemands` filter at `TripPlanner.ts:145-166` — does it correctly recognize `Wine → Praha` as a fresh (not carried) demand when the bot has just delivered Wine→Warszawa in the same turn?
- The candidate's `validation` output — what does `validCandidates[0]` look like at T15? Confirm whether the malformed candidate is at index 0, or whether it's only being chosen after filtering eliminated others.
