# JIRA-267 — `findFinalVictoryRoute` picks the highest-payout carry-deliver instead of the closest one because `estimateSingleDemandTurns` returns a constant 1-turn estimate for any carried-load candidate, AND `DemandContext.isLoadOnTrain` is keyed by loadType (not by card-instance) so a single chip flags every demand card sharing that loadType as "carried"; game 29c0255f Sonnet T85, delivered Fish to Bern (4 turns) instead of Holland (2 turns), winning the game 2 turns later than necessary (behavioral)

In game `29c0255f-1374-4304-a003-8f2dfc4ed257` (Sonnet vs s2), player Sonnet entered end-game with 7 majors connected and cashGap=$22M. The bot held three Fish demand cards (Fish→Bern@$37, Fish→Milano@$27, Fish→Holland@$23), picked up one Fish chip at Aberdeen on T84 per a `findFinalVictoryRoute` projection of `[pickup:Fish@Aberdeen, deliver:Fish@Holland]`, then on T85 — with the chip on board — `findFinalVictoryRoute` re-evaluated, picked **Bern** as the destination instead of Holland, and the activeRoute override fired. The bot traveled 4 turns south to Bern (Switzerland) instead of 2 turns east to Holland, winning at T89 instead of ~T87. Sonnet still won, but the final-leg routing was demonstrably suboptimal and the cause is fully visible in the JIRA-265 endGame trace.

Two compounding defects in the carry-handling path of `findFinalVictoryRoute`:

- **Bug A — distance-blind carry turn estimate.** `estimateSingleDemandTurns` at `victoryRules.ts:246–263` returns `travelTurns(1, speed) = 1` for any `isLoadOnTrain=true` candidate regardless of where the bot is or how far the delivery city is. All single-deliver candidates collapse to "1 turn" in the ranker.
- **Bug B — per-loadType `isLoadOnTrain`.** `DemandContext.isLoadOnTrain` at `DemandEngine.ts:501` is `snapshot.bot.loads.includes(loadType)`. One Fish chip on board flags all three Fish demand cards as carried, even though only one card can actually be fulfilled by that chip. JIRA-233's multiplicity-aware carry detection lives in `DeterministicTripPlanner.detectCarriedLoads` / `normalizeRows` and does not flow into `DemandContext` or `findFinalVictoryRoute`.

Together: T85's candidate enumeration produced three carry-deliver candidates (one for each Fish demand, all with `isLoadOnTrain=true` per Bug B). The ranker assigned each `estimatedTurns=1` (per Bug A). The primary ranking key produced a 3-way tie; the secondary key `cashAtVictory DESC` picked Bern ($265) over Milano ($255) over Holland ($251). The result was a 4-turn travel to Bern instead of 2 turns to Holland.

## Source

`logs/game-29c0255f-1374-4304-a003-8f2dfc4ed257.ndjson` (run with JIRA-265 endGame trace + JIRA-266 latch fix). Discovered 2026-05-26 — user-reported, with debug-overlay corroboration showing the Holland plan present at T82–T84 before the T85 switch.

## Per-turn evidence — Sonnet T83–T86 from endGame trace

```
T83 cash=228 majors=7 endGameLocked=true cashGap=22 majorsGap=0
    victoryRouteProjection.outcome=fire
      stops=[pickup:Fish@Aberdeen, deliver:Fish@Holland]
      turns=7 buildM=0 payoutM=23 cashAtVictory=251
      appliedOverride=false   ← matched the existing activeRoute (Holland)

T84 cash=228 majors=7 (same — pre-pickup; isLoadOnTrain still false on all Fish demands)
    victoryRouteProjection.outcome=fire
      stops=[pickup:Fish@Aberdeen, deliver:Fish@Holland]
      turns=6 buildM=0 payoutM=23 cashAtVictory=251
      appliedOverride=false
    actionTimeline=[move, pickup:Fish, move]    ← Aberdeen pickup happens HERE

T85 cash=228 majors=7 (post-pickup; isLoadOnTrain now TRUE on all three Fish demands)
    victoryRouteProjection.outcome=fire
      stops=[deliver:Fish@Bern]                  ← DESTINATION SWITCHED
      turns=1 buildM=0 payoutM=37 cashAtVictory=265
      appliedOverride=true                       ← route swapped Holland → Bern
```

T84 turn-start `isLoadOnTrain=false` for all Fish demands → carry branch did not fire → `estimateSingleDemandTurns` used path-aware `d.estimatedTurns` (≈ 6–9 turns depending on demand) → Holland won on lowest turns.

T85 turn-start `isLoadOnTrain=true` for all three Fish demands → carry branch fired → all three demands estimated at 1 turn → tiebreak on `cashAtVictory DESC` picked Bern.

## The two ranking comparisons

### T84 turn-start (pre-pickup, isLoadOnTrain=false on all Fish)

| Candidate | `d.estimatedTurns` (path-aware, from ContextBuilder) | payoutM | cashAtVictory | Picked? |
|---|---|---|---|---|
| `[pickup@Aberdeen, deliver@Holland]` | ~6 | 23 | 251 | **YES** (lowest turns) |
| `[pickup@Aberdeen, deliver@Milano]` | ~8 | 27 | 255 | no |
| `[pickup@Aberdeen, deliver@Bern]` | ~9 | 37 | 265 | no |

Path-aware turn estimates correctly favored Holland's geographic proximity. The bot proceeded to Aberdeen and picked Fish.

### T85 turn-start (post-pickup, isLoadOnTrain=true on all Fish)

| Candidate | turns (carry branch, all = 1) | payoutM | cashAtVictory | Picked? |
|---|---|---|---|---|
| `[deliver@Holland]` | **1** (buggy) | 23 | 251 | no (tiebreak loser) |
| `[deliver@Milano]` | **1** (buggy) | 27 | 255 | no |
| `[deliver@Bern]` | **1** (buggy) | 37 | 265 | **YES** (cashAtVictory tiebreak) |

All three carry-deliver candidates produced identical `estimatedTurns=1` regardless of where the bot was or how far each destination was. The ranker fell to the cashAtVictory tiebreak and picked the highest payout — which happens to be the farthest destination geographically.

## What the user verified separately (debug overlay)

The Holland plan was visible in the debug overlay before T85 (corroborates T83/T84 trace). User estimates Holland delivery would have happened ~T87 vs the actual Bern delivery at T89 — a 2-turn loss.

## Cargo-count counterfactual (does picking up 3 Fish at Aberdeen help?)

No. Both bugs are independent of cargo count:

- Bug B's `isLoadOnTrain = snapshot.bot.loads.includes(loadType)` returns true whether the bot has 1 Fish chip or 3 of them — same boolean for the same loadType.
- Bug A's `travelTurns(1, speed) = 1` doesn't depend on cargo count either.

With 3 Fish chips on board the candidate set adds pair-deliver (turns=2) and triple-deliver (turns=3) candidates, but those all lose to single-deliver candidates on the primary ranking key (turns=1). Game ends on the first qualifying delivery anyway — the extra chips would be ballast. The Bern selection persists.

## What the algorithm should do

Per the "math should be right, no tuning knobs" framing:

1. **Carry-deliver turn estimate must reflect distance**, not assume 1 turn. The bot is at a specific position. Each delivery city has coordinates. Travel turns = `ceil(hexDistance(botPos, deliveryCoord) / speed)`, plus build turns when delivery is off-network. Reuse the same `d.estimatedTurns` machinery that already works for non-carry candidates.
2. **`isLoadOnTrain` should be per-card-instance**, matching the actual chip-to-card matching the bot can do. JIRA-233's `detectCarriedLoads` + `normalizeRows` already does this for the DeterministicTripPlanner candidate set; the same multiplicity logic should apply when building `findFinalVictoryRoute`'s candidate set. Either:
   - Make `DemandContext.isLoadOnTrain` multiplicity-aware globally (breaking change for other consumers), OR
   - Build a multiplicity-aware "effective carry" map locally inside `findFinalVictoryRoute` (same shape as `normalizeRows`'s output, reused from DeterministicTripPlanner).

With both fixes:

- One Fish chip carried + 3 Fish demands → only the chip-eligible Fish demand (e.g. highest payout per JIRA-233) is treated as `isCarry=true`. The other two become pickup+deliver candidates with `d.estimatedTurns` path-aware turn counts.
- For the one carry candidate, turn estimate uses actual distance from bot position to delivery city, not a constant.
- Ranking produces Holland (closest, 2 turns) over Bern (4 turns) over Milano (5 turns), independent of payout.

## What the bot did right (already in place)

The bot correctly identified at T84 that it only needed one Fish delivery to win (cashGap=$22M, smallest Fish payout=$23M clears the bar, single-delivery candidates beat multi-delivery on the turns key). The "pick up only one Fish, leave the other demands in hand" decision was sound end-game optimization — and the JIRA-265 endGame trace confirms the bot's reasoning was explicit and correct.

The bug is only in **which** single delivery the planner picked, not in the higher-level decision to do a single delivery.

## Not in scope (single-game observation)

This is one observation in one game. No generalization to broader scoring or ranking changes beyond the two structural defects above. Other downstream consumers of `DemandContext.isLoadOnTrain` (the DeterministicTripPlanner, route grammar validators, etc.) keep their existing semantics — the fix targets only the path that feeds `findFinalVictoryRoute`'s candidate enumeration and turn estimation.
