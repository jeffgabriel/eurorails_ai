# JIRA-229 — Trip planner ranks candidates by lite two-trip look-ahead aggregate income velocity (behavioral)

## Source

Surfaced 2026-05-11 during analysis of game `36eab81a-ca98-47b9-9707-9c980b0d9ef6` — a 120-turn 3-bot game where the winner upgraded to superfreight (capacity 3) but ran the train at effective capacity 1 for the entire game.

## Observed behavior

Winner statistics from the game:

| Metric | Value |
|--------|------:|
| Move turns | 90 |
| Avg loads per move | 0.62 (21% of capacity-3 train) |
| Empty-train moves | 34 (38%) |
| Load cycles peaking at 1 | **22 of 22** |
| Load cycles peaking at 2 | 0 |
| Load cycles peaking at 3 | 0 |
| Trip-planner picks | 24 of 24 single, 0 pair, 0 triple |

The winner spent 40M upgrading to superfreight and never carried more than one load. Aggregate game-wide income velocity: ~2.5 M/turn. Each delivery cycle is pickup → deliver → empty travel → repeat, with the empty leg consuming 1-3 turns per cycle.

## Why pairs/triples lose despite being faster per-delivery

The current scoring formula `score = NET − OCPT × turns` compares candidates as if each were the bot's last trip. A representative example from T78 of this game:

| Candidate | NET | Turns | M/turn | Score (OCPT=4) |
|-----------|----:|------:|-------:|---------------:|
| Single Ham (chosen) | 27M | 7 | 3.86 | −1 |
| Pair Cheese+Ham:AB (runner-up) | 30M | 13 | 2.31 | −22 |

The single beats the pair by 21 score points. But the bot **also holds the Cheese card** and will eventually need to deliver it. Doing Ham then Cheese sequentially:

- Trip 1 (single Ham): 7 turns, 27M
- Empty travel Glasgow → Bern: ~1 turn
- Trip 2 (single Cheese): ~6 turns, ~3M
- **Total: 14 turns, 30M aggregate → 2.14 M/turn**

vs the pair: 13 turns, 30M → **2.31 M/turn**. The pair is 8% faster end-to-end when both deliveries are accounted for. The score formula doesn't see this because it treats each trip as if it were the final one.

This pattern repeats across the whole game — every single trip scored independently looks competitive, but each one leaves an empty-leg "tail" that the score formula attributes to the next trip rather than the current one. Net effect: pair and triple candidates with strong follow-up geometry systematically lose to lower-aggregate-velocity singles.

## Expected behavior

For each candidate, the planner must rank by the **aggregate income velocity of "this candidate plus its best feasible follow-up,"** not the per-trip income velocity of the candidate in isolation.

A candidate's follow-up is the highest-aggregate-velocity other candidate that:
- Does not share any `cardIndex` with the candidate (no double-consumption of demand cards)
- Starts from a city reachable from the candidate's end position

Empty-leg cost between the candidate's end position and the follow-up's start position is included in the aggregate turn count. The aggregate velocity is:

```
aggregate = (c1.net + c2.net) / (c1.turns + emptyLeg(c1.end, c2.start) + c2.turns)
```

**Important semantic**: When at least one feasible follow-up exists, the candidate's `aggregateScore` is the chained aggregate — NOT the max of standalone and chained. The bot WILL do a follow-up trip in the natural course of play, so chained is the realistic trajectory. Standalone is the fallback only when no disjoint follow-up exists (e.g., one card remaining in hand at endgame).

This is critical because a single trip's standalone per-trip velocity is artificially inflated by ignoring the empty leg and follow-up trip the bot must do anyway. A single Ham at 3.86 M/turn looks great standalone, but its chained trajectory (Ham + future Cheese delivery) is only 2.14 M/turn — and the comparable pair (Cheese+Ham together) is 2.31 M/turn standalone or 2.50 M/turn chained. Ranking by chained makes the pair win, matching the true relative throughput.

The planner picks the candidate with the highest aggregate score.

## Pressure-test predictions

Pressure-testing this algorithm against the winner's 24 picks in game `36eab81a`:

| Outcome | Count |
|---------|------:|
| Picks unchanged | 15 (63%) |
| Picks flipped to pair/triple (capacity utilization) | 5 |
| Picks flipped to better single (geographic positioning) | 4 |
| Flips in wrong direction | **0** |

Of the 5 pair/triple flips, all match the user's framing of "fill the train both ways":
- T5: pair Bauxite+Ham:B-then-A (instead of single Bauxite alone)
- T64: pair Ham+Cheese:BA (instead of single Ham)
- T91: pair Cheese+Steel:AB (instead of single Steel, at capacity 3)
- T97: pair Cheese+Tourists:AB (instead of single Tourists, at capacity 3)
- T120: pair Hops+Bauxite:A-then-B (instead of single Hops — JIRA-228 backhaul variant winning under aggregate ranking)

Of the 4 better-single flips, 2 fix negative-NET picks (T44, T102) — picks where the current algorithm chose money-losing trips.

15 picks unchanged confirms the algorithm doesn't over-correct: when a single is genuinely the best play (no pair has better aggregate follow-up), it stays.

## Scope of this ticket

- Modify the deterministic trip planner's ranking step to use aggregate two-trip score instead of per-trip score.
- Surface the chosen candidate's aggregate score and chained follow-up in the reasoning string.
- Existing `scoreCandidate` keeps its responsibility: compute per-trip net/turns. Only the **ranking** between feasible candidates changes.

## Out of scope

- Full N-trip simulation (Idea 5 in original analysis) — defer until 2-trip look-ahead proves insufficient.
- Opportunistic mid-route pickups (Idea 4) — separate concern, touches the executor not the planner.
- Capacity-utilization bonus knob (Idea 3) — explicitly rejected: this ticket optimizes for income velocity directly without tuning constants.
- Changes to OCPT values — OCPT no longer drives ranking. Keep current values as a soft minimum-velocity floor only if tests show it's needed.

## Acceptance

A regression scenario reproducing the T120 hand from game `36eab81a`:

- Bot has 9 demand cards including Hops (Cardiff→Leipzig, 25M payout) and Bauxite (Sarajevo→Wroclaw, 18M payout).
- Cards 66 (Hops) and 108 (Bauxite) form pair `:A-then-B` with NET 28M, 11 turns.
- Single Hops alone is NET 14M, 6 turns.
- Aggregate velocities: single Hops chained with single Bauxite would aggregate to ~2.33 M/turn; pair Hops+Bauxite:A-then-B chained with any other single aggregates to ~2.55 M/turn.
- New algorithm MUST pick the pair, not the single.

A regression scenario for the "no follow-up" fallback:

- Bot has 1 demand card (after several deliveries reduced the hand).
- Only one feasible candidate exists.
- New algorithm MUST pick that candidate using standalone per-trip velocity (no crash, no infinite loop).

Reasoning string MUST include the aggregate score and chained follow-up identifier (or "(standalone)" when no follow-up).

## Evidence

- `logs/game-36eab81a-ca98-47b9-9707-9c980b0d9ef6.ndjson` — 24 winner picks, every cycle peaking at 1 load despite capacity-3 train.
- `src/server/services/ai/DeterministicTripPlanner.ts:572-650` — current `scoreCandidate` returns `score = net - OCPT * turns`.
- `src/server/services/ai/DeterministicTripPlanner.ts:660+` — `pickTop1` currently sorts by `.score` descending.
