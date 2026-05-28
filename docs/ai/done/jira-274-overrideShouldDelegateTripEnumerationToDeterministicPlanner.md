# JIRA-274 — End-game victory override should delegate trip enumeration to DeterministicTripPlanner; trip planning for deterministic bots must not live in two places

The principle: the deterministic planner owns all trip planning for deterministic bots. The end-game victory override exists for its unique value — recognizing when a subset of demands can clinch a win and ranking by turns-to-victory rather than throughput — and nothing else. Stop ordering, grammar validation, carry detection, restriction gating, spatial pruning, and multi-trip lookahead all belong to the deterministic planner and the override should reuse them, not re-implement weaker versions.

## Source

Two recently filed tickets are members of this family:

- **JIRA-273** (shipped `36de30d`): the override produced a deliver-only route for un-carried loads. Closed with a defensive validator at the application site, but the root mechanism is that the override has its own carry-tracking that's strictly weaker than the deterministic planner's.
- **JIRA-274 (originally filed)**: in game c73cccf8 T253–T262, the override emitted `[pickup-Bauxite@Marseille, deliver@Torino, pickup-Bauxite@Marseille, deliver@Munchen]`. Bot picked up one, delivered to Torino, backtracked 6+ mileposts to Marseille for the second, then went to Munchen. The deterministic planner had emitted the correct batched `[pickup, pickup, deliver, deliver]` shape one turn earlier (T252). The override silently rewrote it.

The shared shape: the override enumerates candidates with weaker logic than the deterministic planner — fewer orderings per pair, no grammar validation, no restriction gating, no spatial pruning, no multi-trip lookahead. Every gap is either a shipped ticket (JIRA-273) or a latent one waiting for a game to surface it.

## What should happen

A deterministic bot has exactly one trip enumeration engine. The override's responsibility shrinks to:

1. Decide which demand subset(s) are end-game-relevant (the cashGap / payout / connector-cost math — this is its unique value).
2. Ask the deterministic planner to enumerate stop orderings for the chosen demand subset.
3. Re-score the planner's candidates by turns-to-victory (the override's scoring function, distinct from the planner's M/turn throughput score).
4. Pick the winner. Apply as the activeRoute override.

Result: any improvement to the deterministic planner — better ordering enumeration, new restriction-gate, sharper carry detection — automatically improves end-game play. The override doesn't accumulate its own copies of those improvements. The class of bug typified by JIRA-273 and JIRA-274 closes structurally.

The same principle applies to any other code path that constructs multi-stop routes for deterministic bots. If a future end-game gate or post-action handler needs to produce a route, it delegates the stop construction to the deterministic planner rather than building its own enumeration.

## Fallback when the planner can't enumerate the override's chosen subset

If the deterministic planner returns no viable candidate for the demand subset the override picked (e.g., because an active restriction filters every ordering for that subset, or no valid grammar exists with current cargo), the override declines and returns `skip`. The regular planning path runs normally; the bot uses whatever activeRoute it had or gets a fresh deterministic plan. No retry with a smaller subset, no synthesized route — just "the override has no proposal this turn." Same fallback semantics as JIRA-273's `carry_precondition_fail`.

## Out of scope

- `detectVictoryClinch` and similar single-stop-deliver hard gates: not trip planning (no ordering, single stop only). Those stay as they are.
- The defensive validator added by JIRA-273: keep it as belt-and-suspenders against any future code path that produces routes outside the planner.
- Changing the override's scoring metric (turns-to-victory). That's intentionally distinct from the deterministic planner's throughput score — the override's reason for existing.
- Touching the LLM bots' planning path. Scope is deterministic skill specifically.
