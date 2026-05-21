# JIRA-185: Post-Delivery Replan Receives a Stale Snapshot (Pre-Delivery `cash` and `carriedLoads`)

**Blocks:** JIRA-184 (reproducing the Haiku turn-5 invariant violation end-to-end requires this bug to be present; the architectural fix in 184 cannot be regression-tested without it)

## Problem

When a delivery completes mid-turn and triggers a post-delivery replan, the snapshot passed to `TripPlanner.planTrip` reflects **pre-delivery** state — `carriedLoads` and `cash` are frozen at the moment before the delivery, even though position and demand-card hand are refreshed correctly.

This causes TripPlanner to plan a fresh pickup for a load the bot is actually carrying, and to see less cash than it really has. Downstream enrichment/validation/execution then acts on a route that has no basis in reality.

## Evidence — Haiku game `25d8059e-ea12-4d22-9e7d-b35a9844a7df`, turn 5

### Ground truth from game log

| Marker | Value | Source |
|---|---|---|
| End of turn 4 | `cash: 19`, `carriedLoads: ['Beer', 'Beer']`, `positionEnd: (28,54)`, `activeRoute.currentStopIndex: 2` (next stop: D-Szczecin) | `logs/game-25d8059e-...ndjson` line 7 |
| Start of turn 6 (first recorded post-turn-5 state) | `cash: 28`, `carriedLoads: ['Beer']` | same file, turn 6 entry |
| Cash delta | **+9M** (exactly the Beer→Szczecin payout from turn 2's demand card) | turn 2 demandCards → `Beer: Praha → Szczecin (ECU 9M)` |
| Loads delta | **−1 Beer** (one delivered, one still carried for Bruxelles) | consistent with the 9M payout |

Conclusion: during turn 5, the bot delivered Beer to Szczecin for 9M, leaving 1 Beer + 28M cash. The delivery happened; the turn 5 game-log entry is just sparse because the turn aborted as `PassTurn` after the invariant error (JIRA-184).

### What the LLM actually saw on turn 5

`logs/llm-25d8059e-...ndjson`, `trip-planner/planTrip` call at `2026-04-20T16:49:57.610Z`, `CURRENT STATE` section of the system prompt:

```
- Position: at Szczecin
- Cash: 19M ECU                ← STALE (pre-delivery)
- Train: freight (speed 9, capacity 2)
- Carried loads: none          ← STALE (pre-delivery)
- Turn: 5
- Deliveries completed: 0      ← STALE (delivery just happened)
```

Compared to ground truth at the moment the replan fires:

| Field | Prompt says | Reality | Correct? |
|---|---|---|---|
| Position | "at Szczecin" | Szczecin | ✓ fresh |
| Cash | 19M | 28M (19 + 9M Szczecin payout) | ✗ stale |
| Carried loads | none | `['Beer']` (one remaining for Bruxelles) | ✗ stale |
| Deliveries completed | 0 | 1 (Szczecin just delivered) | ✗ stale |
| Demand cards in hand | Beer→Szczecin absent; replacement card present | consistent with one delivery | ✓ fresh |

Position and the demand-card hand are refreshed correctly. `cash`, `carriedLoads`, and `deliveries completed` are not. The snapshot is stitched together from different sources, not a single consistent point in time.

## Why this matters — downstream blast radius

Because the prompt lies about carried loads and cash, the LLM makes a perfectly reasonable plan given bad input:

1. TripPlanner, seeing `Carried loads: none` + a Beer demand card from Praha to Bruxelles, correctly plans a new pickup: `[PICKUP Beer@Praha, DELIVER Beer@Bruxelles]`. The system prompt's own TRIP RULES explicitly say "CARRIED LOADS ARE IMPLICIT: ... do NOT emit a PICKUP stop for them" — but the LLM can only obey that rule if carried loads are actually in the prompt.
2. Enrichment receives `[P-Praha, D-Bruxelles]` and adds Holland and Wroclaw insertions.
3. `RouteValidator.validate` reorders the enriched route by proximity from (28,54), producing an order where Wroclaw precedes Praha.
4. The build/move direction invariant fires — see JIRA-184 for the full chain.
5. Turn ends as `PassTurn` with a pipeline error.

Even after JIRA-184's architectural fix lands (split `validate` into pure feasibility vs. separate optimizer), the bot will still be making pointless return trips to pickup cities, because the underlying prompt lie drives it to re-plan pickups it's already completed. The user-visible failure changes shape but does not go away.

## Root Cause — hypothesis

Something in the prompt-builder for `TripPlanner.planTrip` reads `cash`, `carriedLoads`, and `deliveriesCompleted` from a stale source. Candidates to investigate, in order of likelihood:

1. **Snapshot not refreshed after delivery.** The delivery mutates server-side state, but the `WorldSnapshot` passed to the post-delivery replan is an object captured at pre-delivery time and reused.
2. **Snapshot refreshed, but prompt-builder reads from a cached `GameContext` or `BotMemory`.** Position is read from the fresh snapshot; cash/loads are read from a cached struct that wasn't re-populated.
3. **Async ordering bug.** The replan kicks off before the delivery's state mutations have been committed/propagated. Unlikely given the game is turn-based and synchronous, but worth ruling out.

The fact that position and the demand-card hand ARE fresh tells us it isn't a global "whole snapshot is stale" bug — it's specifically the cash/loads/deliveries fields. That narrows the search to whichever code path populates those specific prompt fields.

## Files to investigate (not necessarily modify — investigation first)

| File | Why |
|---|---|
| `src/server/services/ai/TripPlanner.ts` | Owns `planTrip` and its prompt construction. Find where `Carried loads`, `Cash`, `Deliveries completed` strings are rendered and trace their source. |
| `src/server/services/ai/WorldSnapshotService.ts` | If the snapshot is reused across phases, this is where a fresh one must be produced post-delivery. |
| `src/server/services/ai/ContextBuilder.ts` | If the prompt pulls from a `GameContext` intermediary, verify all three fields are re-populated after a delivery event. |
| `src/server/services/ai/TurnExecutor.ts` (or wherever deliveries are executed and replans triggered) | Find the post-delivery replan trigger and confirm what snapshot/context it hands to TripPlanner. |
| Any `BotMemory` class holding `carriedLoads` / `cash` | Stale cache is a leading hypothesis. |

## Acceptance Criteria

- After a successful delivery triggers a post-delivery replan, the snapshot/prompt passed to `TripPlanner.planTrip` reflects:
  - `cash` = cash AFTER the delivery payout (delivered-card payout added).
  - `carriedLoads` = loads MINUS the just-delivered load.
  - `deliveriesCompleted` = count INCLUDING the just-completed delivery.
- A reproduction/regression test replays the Haiku turn-5 scenario (or a minimal equivalent): bot carrying 2 Beer, cash 19M, at Szczecin, activeRoute idx=2 on D-Szczecin. On the post-delivery replan, assert the TripPlanner input shows `cash=28`, `carriedLoads=['Beer']`, `deliveriesCompleted>=1`.
- With the fix in place, the LLM's TripPlanner response should start with `DELIVER Beer@Bruxelles` (obeying the "carried loads are implicit" rule), not a fresh `PICKUP Beer@Praha`.

## Relationship to JIRA-184

JIRA-184 proposes splitting `RouteValidator.validate` into a pure predicate plus a separate `RouteOptimizer.orderStopsByProximity`. That is a legitimate architectural fix — the conflation is a real code smell, and the silent reorder materially contributed to this specific failure by turning "wasteful route" into "invariant-violating route." But JIRA-184 alone does not fix the bot's decision-making.

Land-order recommendation:
1. **JIRA-185 first.** Fix the stale snapshot. With a correct prompt, the bot plans sensibly even with today's conflated `validate` method.
2. **JIRA-184 second.** Architectural cleanup. The regression test in JIRA-184 will be able to stand up a scenario where reorder *would* produce a backwards route — but only if JIRA-185 isn't also triggering, otherwise the test scenarios collide.

## Out of Scope

- Any changes to the LLM prompt template itself. The template is fine; the data feeding it is wrong.
- Any changes to `assertBuildDirectionAgreesWithMove` (out of scope per JIRA-184 too — the invariant is correct).
- The separate question of whether the enrichment advisor should receive carried-load context. The enrichment prompt does not currently display `carriedLoads`, but that's a design question, not a bug.
