# JIRA-237 — Bot picked two chained singles over a same-supply pair on a 0.03 M/turn aggregate tiebreaker; the tiebreaker is the residual of two compounding model defects (chained c2 simulated against pre-c1 state + simulateTrip turn counts ~2× game-rule reality) (behavioral)

Game `2f42f3b7`, bot s1 t14. Hand contained two demand cards with the same supplyCity (Szczecin) and same loadType (Potatoes); train capacity 2; a same-supply pair was the obvious play. The deterministic planner enumerated the pair, scored it as Runner-up #2, and chose chained singles instead. Pair lost the `aggregateScore` rank key by 0.03 M/turn.

## Source

`logs/game-2f42f3b7-5147-4bc4-aa9b-2a5783e99456.ndjson` — s1 t14 trip planning through t18 post-Paris-delivery replan. Discovered 2026-05-13.

## Hand

| cardIndex | loadType | supplyCity | deliveryCity | payout |
|-----------|----------|-----------|--------------|--------|
| 30 | Potatoes | Szczecin | Paris | 20 |
| 82 | Potatoes | Szczecin | Marseille | 32 |

Train: Freight (cap 2), upgraded to fast_freight (cap 2) the same turn — capacity unchanged.

## Verbatim planner reasoning (s1 t14 `reasoning` field)

```
[deterministic-top-1] single:30:Potatoes-sup:Szczecin chosen.
  Picked: single-fresh — payout 20M, build 15M, 8 turns, NET 5M, score -11.0
  Aggregate: 1.22 M/turn (chained with single:82:Potatoes-sup:Szczecin, empty-leg 3 turns)
  Stops: 1) pickup Potatoes at Szczecin; 2) deliver Potatoes at Paris
  Runner-up #2: pair:82-Potatoes+30-Potatoes:BA-sup:Szczecin-Szczecin,
                aggregate 1.19 M/turn, NET 26M, 12 turns. Lost by 0.03.
  Runner-up #3: single:82:Potatoes-sup:Szczecin,
                aggregate 1.16 M/turn, NET 17M, 9 turns. Lost by 0.06.
  Survivors after spatial prune: 75 of 605 raw.
  Upgrade emitted: fast_freight (cost 20M, cash 49M, build 15M).
```

The pair WAS enumerated. The rank key is `aggregateScore` (M/turn over c1 chained with its best feasible follow-up).

## Current math — what the planner reports

`c1` and `c2` are both scored via `simulateTrip(startPos = bot.position, stops, snapshot)` — standalone, from the bot's pre-c1 position, against the bot's pre-c1 network. From the verbatim reasoning:

```
c1 = single:30 Paris      payout=20  build=15  turns=8   net=5
c2 = single:82 Marseille  payout=32  build=15  turns=9   net=17
pair                      payout=52  build=26  turns=12  net=26

chained-singles aggregate = (c1.net + c2.net) / aggregateTurns      = 22 / 18 = 1.22 M/turn
pair aggregate            = (pair.net + followup.net) / aggTurns                = 1.19 M/turn
```

Singles wins by **0.03 M/turn**.

## Reality check — game-rule milepost arithmetic

Train is fast_freight after the t14 upgrade → **12 mp/turn**.

Approximate mileposts (counted off the board):

```
bot.start → Szczecin       :  ~24 mp
Szczecin → Paris           :  ~20 mp
Paris → Marseille          :  ~20 mp
Paris → Szczecin (free)    :  ~20 mp  (same hex distance, opposite direction)
Total Szczecin → Paris → Marseille : ~40 mp
```

Build budget is 20M/turn and movement-then-build sequence within a turn means build is essentially parallel for small reaches (4–11M each leg). The bottleneck is movement.

**Pair execution** (bot → Szczecin → Paris → Marseille):

```
bot → Szczecin                : 24 mp / 12 = 2 turns
Szczecin → Paris (build+move) : 20 mp / 12 = 2 turns
Paris → Marseille (build+move): 20 mp / 12 = 2 turns
─────────────────────────────────────────────────────
Pair total                                  ≈ 6 turns       (vs planner's 12)
```

**Chained-singles execution** (bot → Szczecin → Paris → return Szczecin → Marseille):

```
c1: bot → Szczecin → Paris    : 44 mp / 12 = ~4 turns       (vs planner's 8)
empty leg: Paris → Szczecin   : 20 mp / 12 = ~2 turns       (free, on c1's track)
c2: Szczecin → Marseille      : ~25 mp / 12 ≈ 2–3 turns     (direct + 11M build parallel)
─────────────────────────────────────────────────────
Chained singles total                       ≈ 9 turns       (vs planner's 18)
```

The planner's reported turn counts are **roughly 2× game-rule reality**. Possible causes (separate defect, not the focus of this ticket): pre-upgrade Freight speed (9) used instead of fast_freight (12) for c2 standalone; serialized build/move instead of parallel; ferry/terrain costs that don't apply.

## Real economics — what the ranking should be

Using game-rule turn counts and the planner's own NET numbers (NET is build-cost-driven and easier to verify than turns):

```
Pair                            : 26 / 6  = 4.33 M/turn        (standalone)
Chained singles (corrected NET) : 26 / 9  = 2.89 M/turn        (build double-count removed,
                                                                 see below)
```

**Pair beats chained singles by ~1.44 M/turn**, not loses by 0.03.

NET correction for chained singles: c2.net = 17 (standalone) double-counts the 4M bot→Szczecin reach that c1 already built. Corrected c2.net = 21. Total chained singles NET = 5 + 21 = 26 = same as pair. They do the same physical work; the difference is only in turn count.

## Game-rule reality

You pay only for NEW track. Any track on YOUR network — whether built before c1 OR built by c1 — is free to traverse and reuse.

After c1 executes:

```
bot.position  = c1.endCity                           (Paris)
bot.cash      = bot.cash + c1.net
bot.network   = bot.network  ∪  c1.builtSegments     (← key)
```

Current model simulates c2 against `bot.network` (pre-c1) starting from `bot.position` (pre-c1). Real c2 executes against `bot.network ∪ c1.builtSegments` starting from `c1.endCity`.

## Build decomposition (back-derived from candidate data)

```
pair         build = 26M  = (bot→Szczecin) + (Szczecin→Paris) + (Szczecin→Marseille)
single:30    build = 15M  = (bot→Szczecin) + (Szczecin→Paris)
single:82    build = 15M  = (bot→Szczecin) + (Szczecin→Marseille)

→ bot→Szczecin reach      = (15 + 15) − 26 = 4M
→ Szczecin→Paris leg      = 11M
→ Szczecin→Marseille leg  = 11M
```

Sanity: 4 + 11 + 11 = 26 ✓.

## Two compounding defects in scope of this ticket

### Defect 1 — chained-aggregate model

`computeAggregateScore` at `DeterministicTripPlanner.ts:878` scores c2 via `simulateTrip(startPos = bot.position, stops, snapshot)` — bot's PRE-c1 position and PRE-c1 network. In reality c2 executes from c1.endCity against `bot.network ∪ c1.builtSegments`. For s1 t14:

```
c2 standalone build = 15M  = bot→Szczecin (4M) + Szczecin→Marseille (11M)
c2 chained   build = 11M  = Szczecin→Marseille only
                            (bot→Szczecin is on c1.builtSegments → free)

c2 standalone net  = 32 − 15 = 17     ← what the aggregate uses
c2 chained   net  = 32 − 11 = 21     ← what reality looks like
```

Standalone c2.net (17) is **under-stated** by 4M relative to chained c2.net (21). Correcting JUST this defect:

```
chained-singles aggregate (current)    : (5 + 17) / 18 = 1.22 M/turn
chained-singles aggregate (NET-fix)    : (5 + 21) / 18 = 1.44 M/turn     ↑
```

This correction makes chained singles look **better**, not worse. The pair's follow-up (cardIndex 38 cards) gets the same treatment — its build also drops by whatever segments overlap with pair.builtSegments — and the pair's aggregate also rises. The pair MAY rise more (pair.builtSegments = 26M vs c1.builtSegments = 15M), but the structural fix alone does not robustly flip the ranking. There is no clean "the structural fix alone makes the pair win" argument.

### Defect 2 — `simulateTrip` turn counts are ~2× game-rule reality

Independently and compounding: every turn count the planner reports for s1 t14 is roughly double what a game-rule milepost calculation gives at fast_freight speed 12:

| Trip | Planner | Game-rule |
|------|---------|-----------|
| bot→Szczecin (24 mp) | ~2 turns implied | 2 turns ≈ ✓ |
| single:30 Paris (8 turns) | 8 | ~4 |
| single:82 Marseille (9 turns) | 9 | ~5 |
| pair (12 turns) | 12 | ~6 |

The inflation does not cancel between candidates: it flattens velocity differences across the board. A real ~4 M/turn gap (pair standalone 4.33 vs chained-singles standalone 2.89) becomes a ~1 M/turn gap (2.17 vs 1.45) inside the planner. Combined with the structural under-statement of c2.net, the residual gap collapses to 0.03 M/turn and the tiebreaker goes to the chained singles by noise.

Both defects must be fixed for the ranking to track real economics.

## Corrected math — both defects fixed

Using game-rule turns AND post-c1 c2 simulation:

```
Pair, standalone               : NET 26 over  6 turns   = 4.33 M/turn
Chained singles, both fixed    : NET 26 over  9 turns   = 2.89 M/turn
                                      (c1 4 + empty-leg 2 + c2 chained 3)
```

Pair wins by **~1.4 M/turn**. The follow-up drag in `aggregateScore` is a 2-trip-lookahead detail; whatever follow-up gets paired with each candidate, the pair's 4.33 anchor dominates the chained-singles' 2.89 anchor by a wide margin. The ranking is robust to follow-up choice.

## Side-by-side

| | Real economics (standalone) | Planner reported (with follow-up) |
|---|---|---|
| Pair         | 26 / 6 = **4.33 M/turn** | 1.19 |
| Chained singles | 26 / 9 = **2.89 M/turn** | 1.22 |
| Gap | **+1.44 M/turn (pair wins)** | −0.03 (singles win) |

Planner has the ranking inverted because of both defects. Neither defect alone necessarily flips the result — together they explain the 0.03 wrong-direction tiebreaker.

## Turn-by-turn execution (the predicted "chained single" played out exactly as forecast)

| Turn | cash | activeRoute | currentStopIndex | carriedLoads | action |
|------|------|-------------|------------------|--------------|--------|
| t14 | 29 | pickup Szczecin → deliver Paris | 0 | none | UpgradeTrain |
| t15 | 25 | (same) | 0 | none | BuildTrack |
| t16 | 14 | (same) | 1 | [Potatoes] ×1 | BuildTrack |
| t17 | 14 | (same) | 1 | [Potatoes] | MoveTrain |
| t18 | 34 | **pickup Szczecin → deliver Marseille** | 0 | none | MoveTrain |

At t16 `composition.a1.opportunitiesFound = 0` — opportunistic pickup scanner did not load the second matching demand-card Potato while standing at Szczecin with spare capacity. Secondary defect (see Open Questions).

## Open questions

1. ~~Was the pair enumerated?~~ **Answered: yes**, Runner-up #2.
2. **Should c1's builtSegments be exposed on `ScoredCandidate` so `computeAggregateScore` can construct the post-c1 snapshot for c2?** The simulator already computes them internally via `pathToNewSegments`; surfacing them is additive.
3. **Source of the turn-count inflation in `simulateTrip`.** Pair returns 12 vs ~6 by milepost arithmetic; single:30 returns 8 vs ~4. Candidates to investigate inside `simulateTrip`: pre-upgrade Freight speed (9) used when fast_freight (12) is correct (especially for c2 standalone, which is simulated from a snapshot whose `bot.trainType` may not reflect c1's upgrade); serialized build-then-move within a turn instead of parallelized per game rules; over-charging ferry / water-crossing turns; counting pickup/deliver as a movement step. Trace one trip end-to-end against the milepost reality and identify the discrepancy.
4. **Why did `a1-opportunistic` at t16 not pick up the second in-hand matching Potato?** composition.a1.citiesScanned = 0. The scanner appears to skip the planned-pickup city. Secondary defect.

## Acceptance

- **Defect 1 — chained-aggregate model.** Unit test reconstructing s1 t14 snapshot runs `planTripDeterministic` under the corrected aggregate model. Assertion is structural: `c2_chained.buildCost < c2_standalone.buildCost` when c1 builds segments c2 would reuse, and `aggregateScore` is computed from `c2_chained`, not `c2_standalone`.
- **Defect 2 — turn-count accuracy in `simulateTrip`.** Unit test feeding a known fixture (e.g. Szczecin → Paris → Marseille with the bot starting at a known position, fast_freight, an empty network) asserts the returned `turnsToComplete` matches the milepost-divided-by-speed calculation within ±1 turn. Trip totals for s1 t14's candidates (pair = 12, single:30 = 8, single:82 = 9) should drop to roughly half once the inflation source is identified and removed.
- **Combined.** With both fixes, replaying s1 t14's snapshot through `planTripDeterministic` selects the pair as top-1 (or, if not the pair specifically, a candidate whose REAL chained execution dominates the chained-singles alternative under accurate cost and turn modeling).
- **Independent.** `a1-opportunistic` scans for and emits additional `PickupLoad` actions at planned-pickup cities when capacity allows and matching in-hand demands exist.

## Not in scope

- Triples or longer chains — current ticket scope is the two-card case only.
- LLM-path trip planning — s1 is on Medium-skill deterministic path.
- Phase tilts, category tilts, scoring weights — defect is in the chained-cost model, not the weights.
