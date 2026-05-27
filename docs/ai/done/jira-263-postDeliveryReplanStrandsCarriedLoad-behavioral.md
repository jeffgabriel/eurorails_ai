# JIRA-263 — Post-delivery replan strands a carried Tourists load because the implicit-carry signal in `detectCarriedLoads` walks the entire `activeRoute.stops` (including already-executed stops), causing a just-delivered loadType to be marked as still-carried; a fresh demand of the same loadType drawn from the post-delivery card draw inherits this phantom-carry flag and wins a pair-carry+fresh candidate (behavioral)

In game `8e176094-a679-490f-9406-d6faa7b55723` (all-bot Haiku match), player s3 (superfreight, cap=3, speed=12) carried Tourists+Bauxite into T44 with active route `[pickup Tourists@Ruhr, deliver Bauxite@Munchen, deliver Tourists@Venezia]` (Tourists picked up T42, Bauxite picked up much earlier). T44 delivered Bauxite@Munchen mid-turn (+$14M). The post-delivery replan that fired immediately after produced route `[pickup Beer@Munchen, deliver Bauxite@Berlin, deliver Beer@Hamburg]` — a plan that (a) does not deliver the still-carried Tourists, and (b) treats Bauxite as "carried" (no pickup stop) even though it was just delivered. T44–T46 the bot moved NW toward Berlin; T46 attempted to deliver phantom Bauxite at Berlin → `action_failed` → `[stuck-route-abandon]` → PassTurn. T47 replan returned to Venezia/Sevilla. Tourists was finally delivered T49 for $19M, 5 turns after Bauxite delivery, with no offsetting cash earned during the detour (T44→T49: $80M → $88M, +$8M total).

## Source

`logs/game-8e176094-a679-490f-9406-d6faa7b55723.ndjson`, player s3 turns T42–T49. Discovered 2026-05-24 — user-reported.

## Plain-English walkthrough of the current carried-load logic

When the bot finishes a delivery mid-turn, `PostDeliveryReplanner` calls `TripPlanner.planTrip` → `planTripDeterministic` in `DeterministicTripPlanner.ts`. The planner first asks **what is the bot carrying right now?** via `detectCarriedLoads(activeRoute, demands, cargoLoads)`. That helper combines three signals to produce a `Map<loadType, count>`:

1. **Canonical cargo** (`snapshot.bot.loads`) — per-instance ground truth. Mutated mid-turn by `TurnExecutor.handleDeliverLoad` at lines 754-760 (the JIRA-220 follow-up) after a successful early-exec delivery.
2. **isLoadOnTrain flag** on each demand — rebuilt from a fresh DB capture during MovementPhasePlanner's JIRA-165 refresh.
3. **Implicit carry** — walks `activeRoute.stops` and marks any `loadType` with a `deliver` stop that has no preceding `pickup` stop in the route. Intended as a defense against stale isLoadOnTrain when the canonical signals lag.

The result feeds `normalizeRows`, which stamps `isCarry=true` on demand rows matching the carried map (highest payout wins when multiple demands share a loadType). Then `genSingles/genPairs/genTriples` enumerate candidates:

- `carry:X` — deliver a carried load (no pickup)
- `single:X` — pickup + deliver a fresh demand
- `pair-two-carry` — both demands carried (cAcB / cBcA)
- `pair-carry+fresh` — one carry + one fresh, four orderings
- `pair-fresh+fresh` — two fresh, four orderings
- triple variants similar

Each candidate gets `aggregateScore = NET / turns`. The highest aggregate wins.

## Why T44 went wrong — root cause

The active route at T44 was `[pickup Tourists@Ruhr, deliver Bauxite@Munchen, deliver Tourists@Venezia]`. After delivering Bauxite@Munchen, `currentStopIndex` advanced past that stop, but **`activeRoute.stops` is not sliced** — the executed `deliver Bauxite@Munchen` stop remains in the stops array.

`detectCarriedLoads` lines 281-290 (`DeterministicTripPlanner.ts`):

```ts
if (activeRoute?.stops) {
  const pickedUp = new Set<string>();
  for (const stop of activeRoute.stops) {                        // ← walks ALL stops
    if (stop.action === 'pickup') pickedUp.add(stop.loadType);
    else if (stop.action === 'deliver' && !pickedUp.has(stop.loadType)) {
      implicitCarry.add(stop.loadType);                          // ← Bauxite added here
    }
  }
}
```

Walking the full route:
- `pickup Tourists@Ruhr` → `pickedUp = {Tourists}`
- `deliver Bauxite@Munchen` → Bauxite not in pickedUp → `implicitCarry.add('Bauxite')`
- `deliver Tourists@Venezia` → Tourists in pickedUp → skip

`implicitCarry = {Bauxite}`. Lines 294-298 then merge implicitCarry into cargoCount, producing `{Tourists: 1, Bauxite: 1}` — Bauxite is **phantom-carried**.

Then a fresh `Bauxite→Berlin@14` demand was drawn after the Bauxite-Munchen delivery (post-delivery card replacement). `normalizeRows` matches this new demand's `loadType` against the carried map and stamps `isCarry=true` on it. The new card inherits the phantom-carry status of the just-delivered load.

`genPairs` emits `pair:Beer+Bauxite-Berlin:cB-pA-sup:Munchen-null`:

- A = Beer (fresh pickup at Munchen)
- B = Bauxite-Berlin (false carry, no pickup needed)
- Stops: `pickup Beer@Munchen, deliver Bauxite@Berlin, deliver Beer@Hamburg`
- Payout: $9 + $14 = $23M, turns: 3, aggregate: 7.72 M/turn

The runner-up `pair-two-carry: Tourists+Bauxite-Berlin:cAcB` (both phantom-carried) lost on geography — Venezia south + Berlin north = 5 turns, $33M, aggregate 6.65 M/turn. Tourists was the real carry but in BOTH the chosen plan and the runner-up, the planner believed Bauxite was also carried.

## Observed trace — s3

| Turn | action | cash | activeRoute stops | actionTimeline highlight |
|------|--------|------|---------------------------|--------------------------|
| T42 | MoveTrain | 80 | `[Ruhr(Tourists), Munchen(Bauxite), Venezia(Tourists)]` | `pickup Tourists@Ruhr` |
| T43 | MoveTrain | 80 | (same) | moving south, Tourists+Bauxite on train |
| T44 | MoveTrain | 94 | **`[Munchen(Beer), Berlin(Bauxite), Hamburg(Beer)]`** | `deliver Bauxite@Munchen +$14`, `pickup Beer@Munchen`, move NW |
| T45 | MoveTrain | 94 | (same) | arrived Berlin |
| T46 | **PassTurn** | 94 | (same) | `[stuck-route-abandon] no progress for 45 turns (a2=action_failed)` (Bauxite delivery failed — no Bauxite on train) |
| T47 | BuildTrack | 94 | `[Venezia(Tourists), Sevilla(Beer)]` | replan returned to Venezia |
| T49 | MoveTrain | 88 | — | `deliver Tourists@Venezia +$19` |

## T44 deterministic-top-1 reasoning (verbatim)

```
[deterministic-top-1] pair:78-Beer+9-Bauxite:cB-pA-sup:Munchen-null chosen.
  Picked: pair-carry+fresh — payout 23M, build 0M, 3 turns, NET 23M
  Aggregate: 7.72 M/turn (standalone — no feasible follow-up)
  Stops: 1) pickup Beer at Munchen; 2) deliver Bauxite at Berlin; 3) deliver Beer at Hamburg
  Rationale: One load on board, one needs pickup. Interleave to maximize efficiency.
  Supply chosen: Beer via Munchen (DemandContext default: Frankfurt) — closer along existing track.
  Runner-up #2: pair:78-Tourists+9-Bauxite:cAcB-sup:null-null, aggregate 6.65 M/turn, NET 33M, 5 turns. Lost by 1.07.
  Runner-up #3: pair:78-Tourists+9-Bauxite:cBcA-sup:null-null, aggregate 6.65 M/turn, NET 33M, 5 turns. Lost by 1.07.
```

The `sup:Munchen-null` line names the Beer supply as Munchen and the Bauxite supply as **null** — `null` means the planner believes Bauxite is already on the train. With correct carry detection (Bauxite not phantom-carried), this candidate's `null` supply would force the planner to pick the canonical Marseille source for Bauxite, adding a long build/travel leg that would push turns from 3 toward 10+, dropping aggregate from 7.72 to ~2 M/turn and demoting the candidate below every plan that delivers the actual Tourists.

## What the algorithm should do

Per user framing: "a human enters replanning by looking first at what it is carrying — that has zero acquisition cost and a simple delivery path (1–3 turns until payday). That route isn't written in stone — a new demand may present an improved opportunity, but IN ADDITION to the carried load. Only rarely does it displace, and that's due to the math, not to arbitrary penalties or tuning knobs."

Concretely the algorithm should:

1. **Detect carries correctly.** Implicit-carry must walk only the REMAINING stops (those at or after `currentStopIndex`), not the entire route history. A successfully-executed delivery in the past is not evidence of current carry.
2. **Score on the actual cost/benefit of each candidate.** Carry deliveries naturally show up with high aggregate scores: the pickup turn is already paid (sunk), so the M/turn contribution is `payout / (deliver-leg turns)` — a strong number. Fresh demands cost both pickup turns AND delivery turns to net their payout. So carry-bearing pairs structurally outrank carry-dropping pairs in the typical case — without any extra penalty or filter.
3. **Allow displacement when the math says so.** A bot can legitimately pick a `pair-fresh+fresh` plan over a `pair-carry+X` plan when the fresh pair is dramatically better positioned (high-payout fresh demands on-network, carry's matching demand pays poorly with a long detour). This is rare but valid. No hard exclusion of carry-dropping candidates — let the aggregate score decide.

The current bug is step 1: implicit-carry walks the wrong slice. Once that's fixed, steps 2 and 3 already work as described — the existing aggregate-score ranking is correct over a candidate set built from correct carry flags.

## Not in scope (single-game observation)

This is one observation in one game (s3, T44). Per repo convention, no generalization beyond "the implicit-carry walk should slice by currentStopIndex". Broader changes to ranking, scoring, or candidate-set enumeration require corroborating observations across games.
