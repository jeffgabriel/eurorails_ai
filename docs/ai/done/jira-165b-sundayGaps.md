# JIRA-165b: Gap Analysis of Sunday Bug Roundup (Game 308d2270)

Audit of `docs/ai/jira-165-sunday.md` — verifying claims against actual code.

---

## Bug 1: Post-delivery replan stale demands

### Fix is implementable as written
- `ContextBuilder.rebuildDemands()` exists at line 167 — static method, takes snapshot + gridPoints
- `capture()` exists at WorldSnapshotService.ts:23 — async, returns full WorldSnapshot
- No gap in the proposed fix code

### Missing: JIRA-64 refresh already catches stale routes (partially)
- AIStrategyEngine.ts lines 897-921 runs AFTER executor returns
- It refreshes `context.demands` from a fresh snapshot (line 900)
- It invalidates routes referencing cards no longer in hand (lines 903-917)
- So the stale route created at line 311 SHOULD be caught on the same turn
- **Real cost**: 1 turn of stale route execution + any build commitment made during that turn (the 22M track to Sevilla)

### Missing: edge case in JIRA-64 invalidation
- JIRA-64 invalidates routes by checking card IDs against the new hand
- If the newly drawn card happens to share a demand city with the replaced card, the invalidation check might not catch the stale route
- The doc doesn't analyze this edge case

---

## Bug 2: Route ordering ignores deliverable carried loads

### Existing carried-load prioritization not mentioned
- `RouteValidator.reorderStopsByProximity()` at line 417 already promotes deliveries for carried loads
- But only if no nearby pickup is within 4 hops (lines 415-438)
- This happens at route creation time only — not mid-execution
- The doc doesn't mention this existing logic

### RouteEnrichmentAdvisor (JIRA-156) only works at planning time
- RouteEnrichmentAdvisor can reorder stops but only at route creation/replan
- No mid-execution reordering capability exists anywhere
- The doc's proposed fix would be a new capability, not an extension of existing logic

### Priority is undersold
- Doc says "everything else is a design improvement (route reordering)" in the "what to fix first" section
- Bug 2 caused Haiku to go broke and oscillate for 33 turns — that's not a design improvement, it's a capital allocation bug
- Should be HIGH priority alongside Bug 1

---

## Bug 3: Ferry oscillation

### Stuck detection bypassed by active route
- GuardrailEnforcer lines 63-73: `noProgressTurns` stuck detection exists
- Critical gate: only fires when `!hasActiveRoute` (line 66)
- In the ferry oscillation scenario, the bot HAS an active route (pointing to off-network Aberdeen)
- So stuck detection is bypassed entirely — this is the root cause the doc doesn't identify
- The fix should either: remove the `hasActiveRoute` gate, or add a separate oscillation detector that fires regardless of route status

### No ferry-specific logic exists
- Doc correctly identifies this gap
- Proposed "last 4 positions" check would need to be added to GuardrailEnforcer or AIStrategyEngine, not movement code

---

## Bug 4: No train upgrades

### Already fixed by JIRA-161
- Gate 2 removed (verified at AIStrategyEngine.ts line 643)
- Suppression visibility added (line 274)
- The doc's claim that "upgrade consideration is gated behind the build phase" was accurate before the fix but is now resolved
- This bug can be closed

---

## Bug 5: No hand discard despite stale cards

### No gaps identified
- Correctly identified as a prompt guidance issue
- Depends on JIRA-164 broke-bot-gate changes

---

## ContextBuilder gaps

### canBuild is more nuanced than claimed
- Actual condition: `(20 - turnBuildCost) > 0 && snapshot.bot.money > 0` (ContextBuilder.ts:103)
- Also checks remaining build budget, not just money
- The `> 0` vs `>= 1` comment is valid but trivial — equivalent for integers

### "Null supplyCity after JIRA-164" is wrong
- JIRA-164 has NOT changed `supplyCity` to null
- Instead, it filters sentinel values (`'OnTrain'`, `'(already carried)'`) at TripPlanner level (line 266)
- `supplyCity` in ContextBuilder still uses `'NoSupply'` as sentinel (line 492)
- The doc's claim about needing to verify null handling is based on a change that doesn't exist

### formatDemandVictoryNote minor edge case
- Line 1387: `u.cityName === d.supplyCity` could produce false matches if both null/undefined
- Unlikely since `'NoSupply'` is the actual sentinel, not null

---

## Structural gap: Bug interaction

### Bug 1 + Bug 2 compound into the same end state
- Flash's stale-demand route (Bug 1) caused 22M of wasted track → ended at $0
- Haiku's wrong route ordering (Bug 2) caused 43M spent on build → ended at $0
- Both bugs produce broke bots that can't recover
- The fixes should be considered together, not treated as independent issues
