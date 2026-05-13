# JIRA-223 — a1-opportunistic pickup accepts trips the bot cannot afford to complete (behavioral)

## Prior direct-attempt (preserved for comparison)

A direct (non-Compounds) implementation of this ticket was landed and then reverted so the work could be redone through the proper workflow. The branch `direct-attempt/jira-223` (commit `03895db`) preserves that attempt for side-by-side comparison against the team's Compounds-driven outcome.

Recovery commands if the working branch loses context:

```bash
# View the entire direct-attempt implementation diff:
git show direct-attempt/jira-223

# Compare the direct-attempt against the current branch on specific files:
git diff direct-attempt/jira-223^ direct-attempt/jira-223 -- src/server/services/ai/DeterministicTripPlanner.ts
git diff direct-attempt/jira-223^ direct-attempt/jira-223 -- src/server/services/ai/RouteDetourEstimator.ts

# Once the Compounds-driven implementation lands, compare the two diffs:
# (assuming the new implementation lives at HEAD on `compounds/guardrail-updates`)
git diff direct-attempt/jira-223 HEAD -- src/server/services/ai/DeterministicTripPlanner.ts src/server/services/ai/RouteDetourEstimator.ts
```

The revert commit on the working branch is `668c027`. The JIRA-222 commit (`837172a`) sits between the original direct-attempt commit and the revert; it touches different files and is unaffected.

## Source

Surfaced 2026-05-10 while diagnosing game `b1dd75b7-fb22-428a-91f3-552ed0b7ea0c`. The user observation that triggered the investigation was: "Sonnet discards hand t12 in the middle of an active route carrying two fish for delivery!!! this happened during a ferry crossing."

The discard symptom was a separate guardrail bug (fixed in commit `e7ba6f8` — see `GuardrailEnforcer.ts`). This ticket addresses the **upstream** behavior that put the bot in the unrecoverable state in the first place.

## Observed behavior (game b1dd75b7)

Sonnet's per-turn trace, focused on the relevant turns:

| Turn | Position | Cash | Action | Active route | Loads |
|------|----------|------|--------|--------------|-------|
| 8 | (13,47) post-ferry | 7M | MoveTrain | `pFish@Oslo, pFish@Oslo, dFish@Bern, dFish@Zurich` | [] |
| 9 | (8,49) | 7M | MoveTrain + a1-opportunistic PickupLoad | same | [] → [Fish] |
| 10 | Oslo | 0M | BuildTrack | same, csi=2 | [Fish, Fish] |
| 11 | (5,47) | 0M | DiscardHand (forced by guardrail) | cleared | [Fish, Fish] (orphaned) |

At turn 9 the bot was passing through Oslo (or near it) and the **a1-opportunistic** layer auto-picked up Fish because the active route had `pFish@Oslo` queued. By turn 10 the bot had two Fish on board, was at Oslo, and had **0M cash**.

Bern and Zurich are both ~10–14 mileposts south of Oslo with major-city + alpine + river build costs adding up to roughly 30M+. With 0M cash and no income source on the route, the bot literally could not build south to a delivery city. Combined with the guardrail bug, the hand was discarded mid-trip — making the carried Fish irrecoverable too.

## Why the bot accepted this trip

The trip was selected when the bot was solvent (initial-build planner, before any major build spend). At that time the algorithm computed:
- Payout: 2× Fish payout (e.g., 28M total at Bern+Zurich)
- Build cost: ~30M+ for the round trip

**Net was negative**, but the deterministic algorithm (under `OCPT_BY_PHASE.early=2`) tolerates negative-net trips early-game because turns are cheap and network expansion compounds.

What the algorithm did **NOT** model:
- **Cash sequencing.** It checked `payout − buildCost − OCPT × turns` for the score, but did not check that the bot has enough cash *up front* to fund the build to the supply city, the build to the delivery city, the ferry usage fee, etc., before any delivery payment arrives.
- **Dead-end detection.** Once the bot picked up Fish at Oslo and ran out of cash, there was no path to recovery short of waiting for opponent track-use fees. The algorithm never simulated this sequence.

## Why this matters

A bot that accepts a trip it cannot fund is a bot that gets stuck. The guardrail bug previously made stuck-with-loads cases catastrophic (loads orphaned). With the guardrail fix, the bot will at least *retain* its hand and Fish loads while it waits — but it still wastes 3+ turns picking up loads it can never deliver, then sits idle until external income arrives or until the user gives up and ends the game.

The right behavior is to never start the trip in the first place. The deterministic algorithm should reject candidates whose cumulative cash flow goes negative at any point along the simulated path, even if final NET is positive.

## Out of scope for this ticket

- The guardrail bug from game b1dd75b7 — already fixed in `e7ba6f8`.
- The simulator's per-leg "build all then move" sequencing — separate issue, JIRA-220 follow-up.
- Mercy borrow integration. Per CLAUDE.md the bot can borrow up to 20M for 40M debt; the deterministic algorithm currently doesn't model borrow as a recovery mechanism. If we add borrow modeling, the affordability check should include "+20M one-time borrow available" as fallback liquidity. Decide whether to model borrow before tightening the affordability gate too far, or the bot may become overly conservative.

## Acceptance criteria

- **AC1** A bot starting a trip with `cash < min cumulative_build_cost_to_first_payment` for the chosen candidate must NOT have that candidate selected as top-1.
- **AC2** Trips where any leg's cumulative cash position would dip below 0 before the next delivery payout arrives must be rejected at the affordability gate, even when final-net is positive.
- **AC3** A bot that is already broke (or near-broke) and has no in-flight commitments must NOT have a1-opportunistic pick up loads for any demand whose delivery cannot be reached without further build spend exceeding current cash.
- **AC4** Replay of game `b1dd75b7` against the fixed algorithm must NOT produce the `pFish@Oslo, pFish@Oslo, dFish@Bern, dFish@Zurich` route as top-1 from a 7M-cash starting position.
- **AC5** No regression in existing trips that the algorithm currently picks correctly — measure via `scripts/ai/spatial-prune-analysis.ts` against the historical log corpus.
