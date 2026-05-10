# JIRA-227 — Deterministic planner spatial-prune cliffs use crow-flies geometry, not actual cost (behavioral)

## Source

Surfaced 2026-05-10 while analysing why Sonnet (Medium-skill, deterministic trip planner) made only 1 paired delivery across 79 turns in game `3612bf42-68ef-47d4-8bac-cb86d5dd453b`. The user's working hypothesis was that late-phase OCPT=7 was the culprit. The log evidence pointed elsewhere: pair candidates were absent from the top-3 runners-up entirely in late game, meaning they were being killed before scoring rather than losing on score.

## Observed behavior (game 3612bf42 evidence)

The deterministic trip planner emits a structured "Discarded by prune" line in `composition.reasoning` for every Sonnet replan. Across the four late-phase decisions the bot made (T60, T65, T71, T78), the survivor counts and prune kills were:

| Turn | Cash | Cities connected | Survivors / 90 raw | Killed by `turns > 12` | Killed by `build > 130M` |
|------|-----:|----------------:|-------------------:|-----------------------:|--------------------------:|
| T60  | 111M | 3 | 43 | 17 | 30 |
| T65  | 120M | 3 | 38 | 21 | 31 |
| T71  | 126M | 3 | 43 | 16 | 31 |
| T78  | 161M | 3 | 25 | 33 | 32 |

In every case, all three runners-up listed in the reasoning are **single-card candidates**. No pair candidate appears in top-3 across any of the four late-phase decisions. The bot had 161M cash at T78 — well over the implicit "build > 130M" threshold — yet pair candidates were still being killed at the prune stage.

## Why the prune is more conservative than its name suggests

Both prune thresholds derive from a single per-candidate computation in `cheapPrune` at `src/server/services/ai/DeterministicTripPlanner.ts:539-558`:

```
totalHops = sum of Chebyshev hex distances city-to-city through the stop sequence
estTurns  = ceil(totalHops / speed)
estBuild  = totalHops × 1.3   // HOP_AVG_COST_M
```

This means:

1. **`PRUNE_MAX_BUILD_M=130` does not mean "this route would cost > 130M in new track."** It means `totalHops × 1.3 > 130` → `totalHops > 100`. Every single hex hop is treated as if it requires new track at 1.3M/hop average, even when the hop is along the bot's existing network (zero real build cost) or along an opponent's track (zero build cost — that's a usage fee, not a build cost). For a route mostly on the bot's existing network, the real new-track spend might be 20M while `estBuild` reports 130M. The cap is effectively a length cap dressed up as a money cap.

2. **`PRUNE_MAX_TURNS=12` does not mean "this trip takes 13+ actual turns."** It means `Math.ceil(totalHops / speed) > 12` — the optimistic minimum movement turns assuming the bot teleports along straight Chebyshev lines at full speed every turn. Real turns are higher because movement follows track (which detours around water, mountains, alpine, opponent ownership), ferries cost a full turn, and build-spread-across-turns is bounded by the 20M-per-turn cap. A candidate scoring `estTurns = 12` typically plays out as 16-20 actual turns. The cap is permissive on the real number but cliff-strict on the geometric proxy.

3. **Both filters consume the same `totalHops` value.** The two thresholds collide near `totalHops ≈ 100-108` (build cap kicks in at 100, turn cap at 108 for freight speed 9, 144 for fast freight speed 12). They aren't independently rejecting "too expensive" and "too long" — they're rejecting "geometrically too far" twice. The "30 killed by build" and "17 killed by turns" reported at T60 are largely overlapping sets in the underlying geometry.

## Why this hits pairs disproportionately

Single-card candidates have at most 2 stops (pickup → deliver). Pair candidates have 3-4 stops depending on variant, and the additional stops add more hex-distance hops to `totalHops` even when the geographic route is efficient. A pair across two distant card pools (e.g., Wroclaw + Valencia at T78) inherits the geometric span of both supply→delivery legs, plus the inter-leg connector. When the bot's network is small (3 cities, central Europe), most pair candidates need to traverse the network to reach peripheral supplies — and the `totalHops` measurement treats every hex as billable new track regardless of whether the bot already owns the corridor.

The result is that **late-game pair candidates are filtered out before scoring runs**, regardless of how cheap the actual new-track spend would be or how affordable the trip is given current cash.

## Expected behavior

Two related but separable improvements would unblock pair candidates without weakening the prune's protection against genuinely runaway trips:

1. **Cost-aware build estimate**: subtract hops that lie on the bot's existing track (zero build cost) or any player's track (could be zero build cost if the bot pays usage fees instead) from `totalHops` before multiplying by `HOP_AVG_COST_M`. The remaining "off-network" hops are the candidates for actual new track. Apply the build cap to this corrected estimate.

2. **Cash-aware build threshold (or phase-aware)**: the 130M cap is a static limit. With the bot at 161M cash, building 130M of track is technically affordable, but the cap holds even at higher cash levels. A simple variation: `pruneMaxBuildM = min(PRUNE_MAX_BUILD_M, snapshot.bot.money − reserve)`, where reserve guards against post-trip insolvency. Or phase-aware values matching `OCPT_BY_PHASE` (early: tight, late: looser since the bot has accumulated cash and runway shortens).

These are two separate options — could ship either alone.

The expected outcome on the `3612bf42` T78 hand: pair candidates spanning the bot's actual network (e.g., a card pair with one supply and one delivery already on Ruhr-Berlin-Wien track) survive the prune. They may still lose on score to single candidates, but at least they're considered.

## Scope of this ticket

Tight to the observed pattern in game `3612bf42`:

- `cheapPrune` produces a build estimate that ignores existing track ownership.
- `cheapPrune` produces a turn estimate based on Chebyshev distance, not simulator output.
- The static 130M build cap binds at 161M cash without considering affordability.

**Not in scope** (per `feedback_dont_extrapolate_single_observations.md`):

- Whether the OCPT scoring weights are well-calibrated. Late-phase OCPT=7 is documented as deliberate; this ticket does not propose changing it.
- Whether the spatial prune should run at all for small candidate pools. With 90 raw candidates, prune is doing useful work — just on the wrong measurement.
- Whether the SAME issue affects triple candidates. Triples have even more stops and likely have the same problem at higher severity, but I have not enumerated a triple in the log evidence. Address as a follow-up if a triple-specific scenario surfaces.

## Out of scope

- Replacing `cheapPrune` with `simulateTrip` for every candidate (cost regression — `simulateTrip` is the next stage and runs only on prune survivors precisely because it is more expensive).
- Tuning `PRUNE_MAX_TURNS` upward without addressing the fact that the metric itself is optimistic.

## Evidence

- `logs/game-3612bf42-68ef-47d4-8bac-cb86d5dd453b.ndjson` — Sonnet turns. Each `composition.reasoning` field on a `[deterministic-top-1]` decision contains the survivor/killed line. T60, T65, T71, T78 entries are the late-phase examples.
- `src/server/services/ai/DeterministicTripPlanner.ts:118-120` — `PRUNE_MAX_TURNS=12`, `PRUNE_MAX_BUILD_M=130`, `HOP_AVG_COST_M=1.3`.
- `src/server/services/ai/DeterministicTripPlanner.ts:539-558` — `cheapPrune` implementation showing the Chebyshev-based estimate.
- `src/server/services/ai/DeterministicTripPlanner.ts:887-911` — the prune loop that produces `prunedByTurns` / `prunedByBuild` counts and surfaces them in the reasoning string.

## Acceptance

A regression scenario reproducing the T78 hand (9 demand cards, bot at central Europe with 161M cash, 3 cities connected) and applying the corrected `cheapPrune`:

- At least one pair candidate that includes a stop on the bot's existing network must survive the prune (currently zero pair candidates survive).
- A pair candidate whose new-track hops sum to ≤ pre-fix prune limit (e.g., a 50-hop fresh-fresh pair where 30 hops are on the bot's track and 20 require new track) must be evaluated for scoring rather than pruned by the build threshold.
- Existing single-candidate behavior must remain unchanged: every survivor under the old logic still survives under the new logic. The fix only relaxes pruning for previously-rejected candidates whose actual new-track cost is below the cap.
