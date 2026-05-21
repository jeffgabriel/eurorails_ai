# JIRA-194: Stale `lastMoveTargetCity` Fires Build-Direction Invariant After a Post-Delivery Replan

**Status:** SPEC — awaiting review.
**Related:** JIRA-191 (added `assertBuildDirectionAgreesWithMove`, replaced A3 frontier heuristic with build-origin preview), JIRA-173 (early in-turn delivery execution), JIRA-184 (RouteValidator / RouteOptimizer split), JIRA-190 (TripPlanner prompt shape).

## Why

Game `fb3e5856-6311-4c27-a18e-9a7474b43cfd`, Haiku, turn 9. The bot crashed the turn with:

> `[TurnExecutorPlanner] INVARIANT VIOLATION: build direction disagrees with move direction. Build target "Beograd" is at route stop 0 but move target "Zurich" is at route stop 1. Bot cannot build backwards along the route.`

`TurnExecutor` caught the throw, mapped it to `decisionSource: pipeline-error`, and emitted `PassTurn`. The whole turn — nine movement points, one active-route carrying cash — was wasted.

JIRA-191 was supposed to make this class of error impossible: it replaced A3's old directional-guard frontier heuristic with a deterministic "peek at the build target" move. The invariant was added as a belt-and-braces check that A3's move direction still agrees with Phase B's build target. The invariant fired anyway, in a scenario the JIRA-191 spec did not anticipate: a **post-delivery replan** mid-turn.

## What's wrong with the current logic

`TurnExecutorPlanner.execute()` tracks, in a local variable `lastMoveTargetCity`, the last route-stop city the bot moved toward during its Phase A movement loop (`TurnExecutorPlanner.ts:222, 499`). At the end of the loop, Phase B runs `resolveBuildTarget(activeRoute)` and asserts the build target and `lastMoveTargetCity` are in the right order within `activeRoute.stops` (`TurnExecutorPlanner.ts:768`).

The assumption this assertion is built on: **the `activeRoute` at assert time is the same route the bot moved against earlier this turn.** That is true in simple turns. It breaks the moment a delivery triggers a TripPlanner replan inside the movement loop.

Reconstructed turn:

1. T9 start. Route is `[deliver@Zurich(0), pickup@Warszawa(1), deliver@Torino(2)]`, carrying Wine.
2. Phase A iter 1. Target city = `Zurich` (stop 0). On network. `resolveMove(→Zurich)` runs; `lastMoveTargetCity = "Zurich"`.
3. Bot arrives at Zurich. Early delivery of Wine fires (JIRA-173). TripPlanner replan runs.
4. Replan returns a new route; RouteEnrichmentAdvisor tweaks it. `activeRoute` is reassigned to `[pickup@Beograd(0), deliver@Zurich(1), pickup@Chocolate@Zurich(2)]` (`TurnExecutorPlanner.ts:471`).
5. Phase A iter 2. Target = `Beograd` (new stop 0). Not on network. A3 branch runs, then the loop terminates.
6. Phase B. `resolveBuildTarget(activeRoute)` → `Beograd` (stop 0). `lastMoveTargetCity` is still `"Zurich"` from step 2. In the **new** route, Zurich is stop 1. Assertion: build stop 0 < move stop 1 → throw.

The assertion is correct on its own terms — against the new route, the recorded move direction *is* backwards. But the move happened against the *old* route, where `Zurich` was stop 0 and the bot was going forward. The variable was never invalidated when the route underneath it was replaced.

This is the exact "A3 and Phase B disagreeing later" risk JIRA-191 called out, except the disagreement comes from a **replan**, not from BuildAdvisor overriding Phase B.

## What we want to change

Clear `lastMoveTargetCity = null` whenever `activeRoute` is reassigned inside the execution loop. Specifically, add that reset at every site where the `TurnExecutorPlanner.execute()` loop swaps `activeRoute` for a different-shaped route:

1. The successful post-delivery replan path (`TurnExecutorPlanner.ts:471`, `activeRoute = TurnExecutorPlanner.skipCompletedStops(enrichedRoute, context)`).
2. The "TripPlanner returned null route" fallback (`TurnExecutorPlanner.ts:477-479`), which calls `revalidateRemainingDeliveries` + `skipCompletedStops` — these can drop stops and shift indices.
3. The "post-delivery replan threw" catch (`TurnExecutorPlanner.ts:481-485`).
4. The "no brain available" branch (`TurnExecutorPlanner.ts:486-490`).

All four branches either replace the route or reshuffle its stops, so the stop-index mapping `lastMoveTargetCity` encoded is no longer meaningful after any of them.

The cleanest shape is a single `resetMoveTarget()` helper (or just `lastMoveTargetCity = null`) sitting right next to the `activeRoute = ...` assignment in each branch. No new semantics — just a "this value is now stale, don't reuse it" invalidation.

After the fix, the assertion's invariant remains valid: it only runs against a route the bot has actually moved against in *this* segment of the loop. If no move has happened since the last replan, `lastMoveTargetCity` is null and the assertion early-returns on line 1171 (`if (!buildTargetCity || !moveTargetCity) return`).

## Secondary finding — Ham route silently dropped

Separately from the invariant crash, the LLM's preferred route on T9 was **Ham: Warszawa → Torino** (`chosenIndex: 0` in all three trip-planner retries, payout 29M, supply cost 0M, delivery cost ~13M, Warszawa already on network). The route TripPlanner actually returned was **Oil: Beograd → Zurich** (candidate 1, lower-score, 15M supply build).

TripPlanner's chosenIndex-fallback path (`TripPlanner.ts:187-197`) fires when either:

- The LLM's chosen candidate isn't in `validCandidates` after `scoreCandidates` (fully invalidated by RouteValidator), or
- Its pruned-stops list is empty.

Either path writes a single-line `console.log` with a generic reason. Nothing about *which* stop failed, *which* validator rule fired, or *why*. The game log has no diagnostic — we only see the end state: the wrong route was chosen.

Candidate drop-out is a recurring class of silent regressions. `RouteValidator.validate` already emits per-stop diagnostics to `console.log`, but the console is not the debugging surface we use — we read the game-log viewer at `/logs/:gameId` and the LLM-transcript viewer at `/llm/:gameId`. Neither surface currently receives the selection-override evidence, so "chosenIndex overridden by bestIdx" is invisible in both places we actually look.

**In scope for this ticket** — diagnostic subtask:

> Surface the reason TripPlanner overrides `chosenIndex` **in the persisted logs that feed `/logs/:gameId` and `/llm/:gameId`** — not in stdout. When `selectedIdx !== chosenCandidateIdx` (or `chosenCandidateIdx < 0`), attach:
>
> - A `tripPlannerSelection` block on the trip-planner entry in the LLM transcript ndjson (surfaces at `/llm/:gameId`) containing: `llmChosenIndex`, `actualSelectedLlmIndex`, `fallbackReason` (`'chosen_not_in_validated'` | `'chosen_zero_stops'` | `'honored'`), and an array of per-candidate records — `{ llmIndex, stops: [...LLM raw stops], validatorErrors: [...per-stop error strings], prunedToZero: boolean }`.
> - A concise mirror in the game-log entry's `composition` trace (surfaces at `/logs/:gameId`): extend `composition` with a `tripPlannerSelection: { chosenIndex, selectedIndex, fallbackReason }` field so the override is visible on the turn row without cross-referencing the LLM log.
>
> No `console.log` additions; the two viewer surfaces are the contract. If either viewer (`logRoutes.ts` renderer) needs a small rendering change to display the new fields, include it in the subtask.

**Out of scope for this ticket** — the follow-up investigation:

> Actually diagnosing and fixing why Ham Warszawa→Torino was dropped on this turn. That investigation becomes tractable once the diagnostic subtask above lands and we can read validator errors per candidate from `/llm/:gameId` — until then, we're guessing.

## How we'll know it worked

- A unit test replaying the T9 scenario: bot on a Wine-delivery route, arrives at delivery city, TripPlanner replan returns a route whose stop 0 is a pickup city *earlier* in the geographic direction than the old route's stop 0. Phase B completes without throwing, emits either a legitimate build plan or PassTurn, and `decisionSource` is **not** `pipeline-error`.
- Existing JIRA-191 tests still pass — specifically the tests that verify A3 + Phase B agree on build target when no replan happens this turn.
- On a replay of game `fb3e5856` turn 9, the bot does not crash-pass. What action it picks is a separate question (see "Secondary finding" above); the acceptance bar for this ticket is **"no pipeline-error from this invariant on this turn."**
- Diagnostic subtask: a replay of any turn where `chosenIndex` is overridden shows, in the game-log `composition` trace or an equivalent field, the reason it was dropped (validator error string or "pruned to zero stops").

## Risks to think about before approving

- **False-positive invariant before the fix.** The assertion as written is still correct for turns with no replan. Clearing `lastMoveTargetCity` only in the replan branches preserves existing coverage.
- **New failure mode: the invariant silently stops firing.** If a future change accidentally resets `lastMoveTargetCity` in a branch that *didn't* replan, the invariant becomes weaker. Mitigation: centralize the resets and add a comment at the assertion site pointing to every reset point, so a future reader sees the contract.
- **Order-of-stops changes inside `skipCompletedStops`.** This helper can shift `currentStopIndex` forward after a mid-turn state change. It does not reorder stops, but it does change which stop is "stop 0" for the purposes of `resolveBuildTarget`. The reset in the null-route and no-brain branches covers this.
- **Secondary finding is worth a separate ticket.** If the diagnostics subtask becomes a refactor (new error fields in the LLM log, schema changes on the game log), split it out and land the invariant fix first — it's the crash, the diagnostics are the observability upgrade.

## Out of scope

- Diagnosing *why* Haiku's chosenIndex=0 Ham route was dropped on this turn. Once the diagnostic subtask above lands and we can see validator errors per candidate, open a follow-up ticket to investigate (possible culprits: unscored flag, demandCardId mismatch, load-availability edge case, score-sorting with identical llmIndex, etc. — all guesses until the logging is in place).
- Removing `lastMoveTargetCity` entirely. It's still useful as a cheap directional check on turns with no replan.
- Any changes to BuildAdvisor, RouteEnrichmentAdvisor, or TripPlanner retry behavior.

## Related

- JIRA-191 — A3 build-origin preview; introduced the invariant and explicitly flagged the "A3 and Phase B disagreeing later" risk class.
- JIRA-173 — early in-turn delivery execution, which enables the post-delivery replan path.
- JIRA-165 / JIRA-185 — refresh demand cards and sync context.money before the post-delivery replan; both modify route-adjacent state mid-turn.
- JIRA-184 — RouteValidator now pure; reorder happens in RouteOptimizer. Relevant because chosenIndex may swap position in the sorted candidates list after reorder.
