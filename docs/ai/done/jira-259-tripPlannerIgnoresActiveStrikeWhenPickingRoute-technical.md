# JIRA-259 — Filter trip-planner candidates whose first stop is at a city blocked by an active pickup/delivery restriction (technical)

Companion to `jira-259-tripPlannerIgnoresActiveStrikeWhenPickingRoute-behavioral.md`.

## Defect locus

The deterministic trip planner candidate enumeration / ranking layer — likely `src/server/services/ai/DeterministicTripPlanner.ts` (the same file that JIRA-248, JIRA-250, JIRA-254 patched). The exact entry point for candidate generation should be verified during implementation; the reasoning string `[deterministic-top-1] pair:110-Cars+102-Copper:delAfirst-sup:null-Beograd chosen` and `Candidates: raw=780 survivors=69 enumerationMs=5239` point to a `planTripDeterministic` / `enumerateCandidates` / `scoreCandidate` pipeline that doesn't currently consult `snapshot.activeEffects`.

Verify during implementation:

```bash
grep -n "activeEffects\|pickupDeliveryRestrictions\|isPickupDeliveryBlocked" src/server/services/ai/DeterministicTripPlanner.ts src/server/services/ai/routeHelpers.ts src/server/services/ai/TripPlanner.ts 2>/dev/null
```

(Spec BE-005 listed `routeHelpers.ts` as a target; the candidate-enumeration layer above route-helpers is the remaining gap.)

## Fix shape

After candidate enumeration but before scoring (or as a post-scoring filter, depending on the pipeline shape), drop any candidate whose `stops[0]` is a `pickup` or `deliver` at a city in the active pickup/delivery restriction set.

Approximate change:

```ts
// After enumerateCandidates(...) returns the raw candidate set:
const pickupDeliveryRestrictions = (snapshot.activeEffects ?? []).flatMap(e => e.restrictions.pickupDelivery);
const restrictedCityKeys = new Set(pickupDeliveryRestrictions.flatMap(r => r.cityMilepointKeys));

const survivors = candidates.filter(c => {
  const stop0 = c.stops[0];
  if (!stop0) return true;
  if (stop0.action !== 'pickup' && stop0.action !== 'deliver') return true;
  const cityKey = getCityMilepointKey(stop0.city);
  if (cityKey === null) return true; // unknown city — don't filter
  return !restrictedCityKeys.has(cityKey);
});
```

The exact integration point depends on whether the planner currently uses a single-pass scoring loop or a multi-pass prune-then-score pipeline. Use the existing prune-survivor pattern (the log says `Survivors after spatial prune: 69 of 780 raw. Discarded by prune: 697 (turns > 12) | 14 (build > 130M)`) and add the restriction-filter as an additional prune stage.

Log the filter as part of the standard `Candidates:` reasoning line so future debugging can see "discarded by active-effect filter: N".

## Acceptance from behavioral

- **AC1** Unit test on the enumeration/filter pipeline: fixture with bot at Antwerpen carrying Cars, demands as in s1 T31, `snapshot.activeEffects` with a Coastal Strike listing Antwerpen. Assert: no surviving candidate has `stops[0] = { action: 'deliver', city: 'Antwerpen' }`. Either a different route is chosen or no route is feasible.
- **AC2** Unit test, same fixture but no Strike. Assert: the `pair:110-Cars+102-Copper:delAfirst-sup:null-Beograd` route is the top-1 (regression guard).
- **AC3** Unit test: bot in a state where the ONLY enumerable routes lead with a blocked stop. Assert: the filter drops them all and the planner returns "no feasible route" (matching the existing no-feasible-route path's contract).
- **AC4** Unit test: bot at Antwerpen, Strike active, an alternate candidate exists that leads with `pickup Copper at Beograd` (a non-restricted city), with the Cars delivery deferred to a later stop. Assert: the alternate is selected; the filter only drops candidates with a restricted stop 0, not later stops.
- **AC5** Integration: replay s1 T31 of game `182bfd36-3d3d-46ef-9c1d-0c87373b983f` and verify the chosen route's `stops[0]` is not at Antwerpen.

## Validation hooks to inspect during fix

- After the fix, the reasoning string for s1 T31 should NOT pick `pair:110-Cars+102-Copper:delAfirst`. It should either pick a different ordering (e.g., `pickup Copper first`) or report "no feasible route".
- Add a `discardedByActiveEffectFilter` counter to the `Candidates:` line so the same log already in place at line 9 of the example excerpt shows the filter's effect.
- The `compositionTrace.candidates` field (if the planner emits it) should not contain any survivor whose stop 0 is at a restricted city, post-fix.

## Not in scope

- LLM-path trip planning (Hard skill). If the LLM also picks blocked routes, file a separate follow-up. Scope here is the deterministic Medium-skill path.
- Down-ranking candidates whose LATER stops are blocked (probabilistic feasibility based on Strike expiry timing). Hard-filter on stop 0 only.
- Equivalent filters for movement and build restrictions — those are already wired in BE-005's planner-level integrations. This ticket plugs the trip-planner candidate-enumeration gap specifically.
- Telemetry / metrics on "how often did the active-effect filter drop candidates". Counter in the reasoning string is sufficient; richer telemetry can be a follow-up if event-card pressure becomes a frequent diagnostic question.

## Relationship to existing JIRAs

- **JIRA-256 / BE-005**: this is a follow-up gap. BE-005 covered `MovementPhasePlanner`, `BuildPhasePlanner`, `routeHelpers.ts` — but the deterministic trip planner's candidate enumeration layer above route-helpers is what BE-005 missed.
- **JIRA-257**: complementary fix at the guardrail layer. Either ticket alone reduces the wasted-turn loop; together they fully prevent the planner from selecting and the guardrail from forcing a blocked delivery.
- **JIRA-248 / JIRA-250 / JIRA-254**: prior tickets in the same DeterministicTripPlanner area. The fix here lives in the same file and the same enumeration/prune pipeline.
