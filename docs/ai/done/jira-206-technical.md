# JIRA-206 — Technical fix plan

Companion to `jira-206-behavioral.md`.

## Root cause

Three concrete bugs combined to produce the unfundable-route commit. They sit at different layers of `src/server/services/ai/TripPlanner.ts`. All three need attention; the third is the most important.

### Bug 1 — Candidate coverage gap (LLM-side, but addressable in the prompt and validator)

The trip-planner's candidate list is built from the LLM's `parsed.candidates` array (`TripPlanner.ts:182-190`). On T15 the LLM emitted only Oil and Steel candidates, omitting Cheese: Holland → Cardiff. The LLM's reasoning text named Cheese → Cardiff explicitly as a better option, so the model was *aware* of the demand but did not include it as a candidate in the structured response.

Possible causes (need investigation):
- The trip-planner prompt does not require the LLM to enumerate every demand card whose supply and delivery are both on-network as a candidate. It may rely on the LLM to filter, which loses high-value on-network options to attention budget.
- The prompt may not pass the bot's `connectedMajorCities` / on-network demand summary in a form that strongly biases toward including them as candidates.
- A response-token cap may be truncating candidates (relates to the symptom in JIRA-205).

The candidate list rejection details (which demands were listed but pruned by `scoreCandidates`) live in `selectionDiagnostic.candidates` (`TripPlanner.ts:226-252`). For T15 that diagnostic is built (because the fallback fired) and would tell us whether Cheese was in the LLM's raw output and got rejected, or whether it was never proposed at all. That diagnostic appears to be persisted via `tripPlanResult.fallbackReason` (line 305) but the full per-candidate breakdown is not in the NDJSON for this game — first thing to do is read `selectionDiagnostic` from the audit data to confirm which sub-cause applies.

### Bug 2 — `chosen_not_in_validated` falls back to highest internal score with no affordability gate

`TripPlanner.ts:213-253`:

```ts
if (chosenCandidateIdx >= 0 && candidates[chosenCandidateIdx].stops.length > 0) {
  selectedIdx = chosenCandidateIdx;
} else {
  selectedIdx = bestIdx;     // candidates[].reduce on score
  // …diagnostic…
}
```

When the LLM's `chosenIndex` doesn't resolve to a validated candidate with feasible stops, the planner picks the highest-internal-scored candidate in the validated set. That decision is made purely on `c.score`. There is no check that the chosen candidate is fundable from the bot's current cash net of any upgrade the same plan is requesting.

This is the path that fired on T15: `chosen_not_in_validated` → `bestIdx = 0` → Oil committed.

The `chosen_not_in_validated` signal carries a strong piece of information: **the LLM did not endorse any of the validated candidates.** Treating that as "use the highest-scored one anyway" throws the signal away. A safer reading: the candidate set is poor and we should refuse to commit to a route this turn rather than commit to one the LLM passed on.

### Bug 3 — No affordability gate on the selected route given the same-turn upgrade

The trip-planner's response also carries `parsed.upgradeOnRoute` (`TripPlanner.ts:264-267`), which is consumed downstream as the same-turn upgrade. So the planner knows, at the moment of selection, both:
- the candidate's `buildCostEstimate` (24M for Oil), and
- whether an upgrade will be triggered this turn (–20M for fast_freight).

But there is no rule like:

```ts
const upgradeCost = normalizedUpgrade ? UPGRADE_COSTS[normalizedUpgrade] : 0;
const fundsAfterUpgrade = snapshot.bot.money - upgradeCost;
const affordable = chosen.buildCostEstimate <= fundsAfterUpgrade;
if (!affordable) { /* reject this candidate */ }
```

For Nano on T15: $32M – $20M upgrade = $12M cash, vs Oil's 24M build estimate. Difference of 12M — the route was guaranteed to bankrupt the bot before completion, and the planner committed anyway. (Even without the upgrade the margin would have been only $8M; with the upgrade, infeasible.)

There is also no check that `buildCostEstimate <= snapshot.bot.money` against the un-upgraded cash, which would have caught the case where the upgrade is independent of the route choice.

## Fix plan

Three changes, ordered by safety/leverage. Recommend doing all three; #3 alone prevents the lockup, #2 makes the system honest about LLM rejection, #1 reduces the rate at which #2/#3 have to fire.

### Fix 1 — Affordability gate (highest leverage)

In `TripPlanner.ts`, after `scoreCandidates` returns and before the `chosenCandidateIdx` / `bestIdx` selection logic, filter out candidates whose `buildCostEstimate` exceeds the post-upgrade cash:

```ts
const upgradeCost = computeUpgradeCost(parsed.upgradeOnRoute, snapshot.bot.trainType);
const fundsAvailable = snapshot.bot.money - upgradeCost;
const affordable = candidates.filter(c => c.buildCostEstimate <= fundsAvailable);
```

If `affordable.length === 0`, return the same shape as the existing "all candidates failed validation" path (line 192-197) — produce a no-route result and let the next-turn flow handle it. This is the clean "we have no fundable route this turn" exit; the engine already supports no-route turns.

If `affordable.length > 0`, run the existing chosenIndex/bestIdx logic on the filtered set instead of the full candidates array. Update `selectionDiagnostic` to include the affordability filter so the diagnostic still explains what happened.

Acceptance for this part: **for the JIRA-206 reference state (Nano T15: $32M cash, 20M upgrade, 24M and 29M candidate build estimates), the trip-planner returns no-route rather than committing to Oil.**

### Fix 2 — Stop silently overriding `chosen_not_in_validated`

When `chosenCandidateIdx < 0`, don't fall back to `bestIdx`. Treat it the same as "no acceptable candidate" — return no-route. The LLM's `chosenIndex` not resolving to a validated candidate is a strong signal that the model wasn't satisfied with any of them; the current behaviour throws that signal away and picks one the model just declined.

`chosen_zero_stops` is a different case (the LLM's pick *was* in the candidate set but got pruned to 0 feasible stops by the validator) — for that, the existing `bestIdx` fallback is more defensible. Keep it for `chosen_zero_stops` only.

This is a small, surgical change: one branch in `TripPlanner.ts:217-253`.

### Fix 3 — Make Cheese-class on-network demands appear as candidates more reliably

This is the harder, fuzzier change. Two layers can help:

- **Prompt change**: the trip-planner system prompt should mandate that any demand card whose supply (or carried load) and delivery are both on-network MUST appear as a candidate, regardless of payout. The LLM had the information; the prompt did not require it to surface them.
- **Post-LLM augmentation**: optionally, after parsing the LLM response, scan the bot's hand for demands satisfying `(isLoadOnTrain || isSupplyOnNetwork) && isDeliveryOnNetwork` and synthesise candidates for any that the LLM omitted. Score them with the same `scoreCandidates` machinery. This guarantees coverage even when the LLM is sloppy.

Augmentation is more reliable; prompt-only is less invasive. Recommend prompt change first, with augmentation as a follow-up if the prompt change alone doesn't drop the rate of missed-candidate cases.

## Acceptance criteria

- The JIRA-206 reference scenario (Nano T15: $32M, freight, post-Cheese-delivery, 9 cards including Cheese: Holland → Cardiff, LLM omits Cheese, picks Oil with 24M build, requests fast_freight upgrade) results in `tripPlanResult` with no committed route — not an Oil route — because the affordability filter rejects it.
- An on-network demand whose supply and delivery are both on-network appears in the candidate set on a turn where the LLM is run with that demand in hand.
- A `chosen_not_in_validated` outcome no longer commits to `bestIdx`; it returns no-route. The existing `chosen_zero_stops` fallback stays.
- The bot's eventual no-route turn yields gracefully (e.g. the next turn re-plans, or the route-abandonment / hand-discard pipeline runs) — covered by existing infrastructure; this fix doesn't need to add new no-route handling.
- Existing trip-planner unit tests for the LLM-honored path and the prior `chosen_zero_stops` fallback pass without modification.
- A new test exercises the JIRA-206 affordability case: candidate buildCostEstimate > (money − upgradeCost) → candidate filtered → no-route result.

## Out of scope

- Changes to `BuildRouteResolver` or `executeBuildPhase`. The build path is correct; the bug is upstream in route selection.
- The downstream lockup behaviour (separately tracked in JIRA-204).
- The Flash gemini-3-flash-preview thinking-token issue (separately tracked in JIRA-205).
- Changing the `upgradeOnRoute` mechanism or the in-turn upgrade injection point. The upgrade itself was a defensible decision; the bug is that the planner ignored it during affordability assessment.
- The candidate scoring formula. `score` may need rebalancing in the long run, but this fix addresses correctness (don't commit to unfundable routes) rather than ranking quality.
- Generalising "affordability" to include opponent-track usage fees, ferry build costs not yet incurred, or movement budget. The 24M-vs-12M case here is unambiguous; tighter affordability models can come later.
