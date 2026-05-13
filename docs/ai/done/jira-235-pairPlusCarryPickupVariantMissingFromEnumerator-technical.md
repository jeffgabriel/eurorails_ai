# JIRA-235 — Technical postmortem: shipped, reverted, analysis-only

Companion to `jira-235-pairPlusCarryPickupVariantMissingFromEnumerator-behavioral.md`.

**Status: code change shipped briefly, then reverted after data verification.** This document captures what was shipped, what the data revealed, why it was reverted, and what the residual defects are.

## What was shipped (and reverted)

A `genPairsWithCarryPickup` generator added to `src/server/services/ai/DeterministicTripPlanner.ts`, wired into `enumerateCandidates`. ~85 LOC.

The generator emitted candidates of shape "pickup A, pickup B, pickup C, deliver A, deliver B" with C left on board for a future trip. Gated to `cap >= 3`. Scored with `payout = a.payout + b.payout + 0.5 × c.payout` (the 0.5 was a hand-picked "carry credit fraction").

**Reverted in the same session** after data verification showed:
- The fix is a no-op for the cited example (cap=2 at planning).
- Even if it weren't a no-op, the variant loses to the regular pair on aggregate score.
- The 0.5 carry-credit constant is unprincipled.

## How the data was gathered

1. **Snapshot extraction from game log.** Grepped `'"playerName":"s1"'` from `logs/game-cccbc7e1-….ndjson`, parsed the t31 record. Got `trainType=fast_freight`, `trainCapacity=2`, demand list, connected network.
2. **City coordinates.** Read `configuration/gridPoints.json` (the master grid file, 2062 entries). Filtered for `Name in {Cardiff, Aberdeen, Newcastle, Munchen, Wien, Warszawa, Bern}`. Mapped `GridX→col, GridY→row`.
3. **Hex distances.** Computed Chebyshev distance between city centers. Confirmed Newcastle sits on the Cardiff→Aberdeen path (8+7=15 hex vs. 15 hex direct).
4. **Aggregate-score math.** Compared the as-chosen pair vs. a hypothetical pair+carry-Oil candidate (assuming cap=3). Used `c.payout − hexDistance × HOP_AVG_COST_M` as a rough c2.net estimate.

Result: pair wins by ~0.05 M/turn on aggregate. The planner's choice was correct.

## Why the original analysis was wrong

The original Defect B writeup in JIRA-234 made three errors compounded:

1. **Misidentified the planning path.** I claimed s3's PostDeliveryReplanner bypasses the deterministic affordability gate. Wrong: Medium-skill bots route through `planTripDeterministic`, which has the gate. The bypass theory applied only to LLM paths (Hard skill), and the cited bots are both Medium.
2. **Did not verify cap at planning time.** Assumed the planner saw cap=3 because of the "Upgrade emitted: superfreight" line. Wrong: the upgrade is a post-hoc decision attached to the chosen candidate after enumeration. Enumeration ran with the pre-upgrade cap (2 for s1 at t31).
3. **Did not compute the actual aggregate math before proposing a fix.** Newcastle's geometric position on the Cardiff→Aberdeen path is intuitively persuasive but isn't sufficient evidence of a scoring bug. The deferred-delivery cost (Munchen→Warszawa = 16 hex of new track) matters too.

All three were avoidable with 15 minutes of data inspection upfront. The lesson: validate the planning path, the cap, AND the score math before designing a new enumerator.

## Residual defects (separate tickets recommended)

### D1: `computeAggregateScore` carry-forward blindness

`computeAggregateScore` (`DeterministicTripPlanner.ts:~872`) selects c2 from `feasibleDemands` rows where `isCarry` is set based on **current** `bot.loads`. It does not consider that the bot's post-c1 state might include additional carried loads, so it cannot favour c2 candidates that would benefit from carry-forward.

Concretely: when the regular pair is the c1, the natural c2 for the bot might be "deliver Oil — but first travel back to Newcastle to pick up." The current aggregate evaluates this as a full pickup+deliver, which is expensive. In a hypothetical carry-forward case, the bot would skip the Newcastle pickup leg, saving ~30 hex.

**Magnitude in this game**: ~0.05 M/turn. Small. Other game states may have larger gaps if a carry-forward demand is the natural-and-only follow-up.

**Implementation sketch (when this is worth doing)**:
- In `computeAggregateScore`, for each c2 candidate that includes a pickup at city X, check if X would be skippable assuming c1 ends with the same load on board.
- This requires synthesizing a "carry variant" of c2 (drop the pickup stop, recompute turns/build cost), then comparing to the standalone c2.
- Probably cleaner: enumerate a `carryFollowup` candidate set parallel to the existing rows, and select c2 from that set when scoring `pairCarry`-style c1 candidates.

### D2: Affordability gate accepting unfundable routes (s3's stuck-at-$7M)

Separate from this ticket. s3 at t15 had a deterministic-top-1 candidate `pair:116-Fish+71-China` with `payout 72M, build 48M, 15 turns, NET 24M` chosen with `startingCash = 27M`. For the affordability gate (`scoreCandidate:812`) to have passed, `result.minCashRelative >= −27`. The bot ended up stuck at $7M with route still pointing at Oslo, which means the actual cash dip during execution was deeper than the simulator predicted.

Likely root cause: `simulateTrip` doesn't model the 20M-per-turn build budget. It computes a `totalBuildCost` and a `minCashRelative`, but if the cost is amortised across more turns than the bot is actually allowed to spend per turn, the projected min cash is optimistic.

**Spin into its own ticket.** A3 (stuck-build-progress detection, already shipped in JIRA-234) is the safety net.

## Files

- `src/server/services/ai/DeterministicTripPlanner.ts` — `genPairsWithCarryPickup` and its `enumerateCandidates` wiring were added then reverted in the same session. Net file change: 0 LOC.
- `docs/jira/jira-235-*.md` — these two documents.

No tests added. No behaviour change shipped.
