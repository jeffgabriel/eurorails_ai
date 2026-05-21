# JIRA-209 — On the very first turn of the game (initial-build phase 1, before the bot has placed its pawn), Flash's `demandRanking` reports `trackCostToSupply` + `trackCostToDelivery` totaling 69M for a Wood/Sarajevo→Lodz demand whose true minimum build cost is 34M; the cold-start branch that would have produced 34M is bypassed because the initial-build-planner has already committed 5 segments toward an unrelated demand by the time the demand ranking gets snapshotted

The demand ranker computes per-card track-cost estimates against `snapshot.bot.existingSegments`. The "cold-start" path — which evaluates each major city as a hypothetical starting point and picks the cheapest one — fires only when `existingSegments.length === 0`. On the first turn of this game, by the time the demand ranker is called and its output is recorded, the initial-build-planner has already placed 5 segments toward Bern (chasing a Cheese demand). `existingSegments.length === 5`, the cold-start branch is bypassed, and every other demand in the hand gets evaluated as "cost to add two independent spurs from the Milano→Bern track" rather than "what is the cheapest starting position and route for this demand if I were starting fresh."

The reported 69M figure is ~2x the true minimum (34M, achievable by starting at Wien and using the Wien→Lodz hub corridor). The Wood demand is ranked 8/9 with score `-47.3`. The bot does not pursue it. The bot's *decision* is still defensible (22M payout is below 34M build cost even at the optimum), but the *score* the bot logs is wildly inconsistent with what cold-start logic would have produced for the same demand on the same turn.

## Game evidence — `02be02dc-a624-4ef1-b8ac-6d8d8f53056b`

Player: **Flash**, turn 2 (initial-build phase 1 — bots build track before placing their pawns).

Authoritative state recorded for Flash on T2:
- `positionStart: null`, `positionEnd: null` (pawn not yet placed)
- `cash: 38` (started 50M, already spent 12M on build)
- `segmentsBuilt: 5`
- `buildTargetCity: "Bern"`
- `decisionSource: "initial-build-planner"`
- `reasoning: "[initial-build-planner] Build toward Bern for Cheese pickup"`
- `composition.build: { target: "Bern", cost: 0, skipped: false }`

Demand hand (3 cards):
| Load | Supply → Delivery | Payout |
|---|---|---|
| Bauxite | Marseille → Madrid | 20M |
| Tourists | Ruhr → Napoli | 32M |
| **Wood** | **Sarajevo → Lodz** | **22M** |

`demandRanking` row for the Wood card (turn 2):
```json
{
  "loadType": "Wood",
  "supplyCity": "Sarajevo",
  "deliveryCity": "Lodz",
  "payout": 22,
  "score": -47.32,
  "rank": 8,
  "estimatedTurns": 8,
  "trackCostToSupply": 31,
  "trackCostToDelivery": 38,
  "ferryRequired": false
}
```

The same `trackCostToSupply: 31, trackCostToDelivery: 38` values reappear on Flash's turns 3, 4, and 5 — Flash's track stays west of Milano, so the cheapest Milano-area endpoint to Sarajevo and the cheapest Milano-area endpoint to Lodz are unchanged turn-over-turn.

## What the demand ranker should have produced — verified directly against the game's own pathfinder

Running the cold-start optimization (`estimateColdStartRouteCost`'s major-city loop) for `Wood / Sarajevo → Lodz` against the live `gridPoints.json` and the game's `estimatePathCost` Dijkstra:

| Hypothetical start | path(start → Sarajevo) | path(start → Lodz) | best total |
|---|---|---|---|
| **Wien** | **20M** | **14M (hub model)** | **34M** ← optimum |
| Berlin | 35M | 14M (hub) | 49M |
| Milano | 24M | 31M (linear via Sarajevo) | 55M |
| Ruhr | 37M | 27M (hub) | 64M |
| Holland | 42M | 31M (linear) | 73M |
| Paris | 45M | 40M (linear) | 76M |
| London | 50M | 42M (linear) | 81M |
| Madrid | 70M | 69M (linear) | 101M |

Cold-start logic, if it had been allowed to run, would have selected **Wien** as the optimal start (`supplyCost: 20, deliveryCost: 14`, total 34M, `isHubModel: true`).

What actually got logged was **post-track / spur-from-Milano**: nearest track endpoint is Milano-center, and the algorithm computes Sarajevo and Lodz as two independent spurs from that endpoint:

- `path(Milano → Sarajevo)` raw = 24M, after `applyBudgetPenalty` ≈ 28M
- `path(Milano → Lodz)` raw = 36M, after `applyBudgetPenalty` ≈ 41M
- Total ≈ 69M ← matches the reported figure

(The 31/38 split logged differs slightly from the 28/41 split this reproduction returns — the algorithm picks the top-5 nearest track endpoints by hex distance and runs Dijkstra from each, so the split varies with which Milano outpost wins per leg. The total is invariant.)

## Why this matters even though the bot's action was correct

The bot did not pursue the Wood demand. Score `-47.3` parks it last; it never becomes a candidate. That is the right action — even at 34M true cost, the 22M payout is unprofitable.

What the bot loses is the *signal*. With a 34M cold-start cost, the score for this demand would be roughly `(22/turns) - 34*0.1` ≈ `-1` to `-2` per turn (uneconomical, but only mildly so), and the demand would rank somewhere in the middle of the hand. With the inflated 69M cost, the score becomes `-47` and the demand looks like an outlier disaster. Several downstream consumers read the score and the cost figures:

- The build-advisor system prompt embeds top-N ranked demands, and a 2x cost inflation on lower-ranked demands changes how the LLM weighs "is there a cheaper alternative I should switch to?"
- The discard heuristic uses score to decide whether the hand is bad enough to discard — a hand with one demand at `-47` and two demands near `0` reads as "there's one really bad card" rather than "every demand is mildly underwater."
- The starting-city decision (when it runs at all — see scope note below) needs cold-start cost data to compare candidate starts. Once the initial-build-planner has committed, that comparison is no longer available.

## Initial-build phase, in this codebase, is two turns long

Per the game rules embedded in `CLAUDE.md` (under *Building Railroads — Order of Play in the First Two Turns*):

> Players take two turns at the start of the game to build track before moving trains.

So `existingSegments.length === 0` is true only on the *very first* call into the initial-build-planner of turn 2, and false for every subsequent demand-ranking snapshot on turn 2 *and* every snapshot on turn 3. The cold-start branch in `DemandEngine.ts:508` is gated on a condition that flips false within milliseconds of the game starting, before any per-turn logging happens. The window during which cold-start figures are observable to a logged-event consumer is effectively zero turns.

## Scope of this report

- One game (`02be02dc`), one player (Flash), turns 2-5 of an early-aborted run.
- Verified against `configuration/gridPoints.json` and `src/server/services/ai/MapTopology.ts:368 estimatePathCost` directly.
- The "post-track spur estimation overstates true minimum" pattern is independent of *which* demand or *which* player — it will reproduce for any demand whose supply-and-delivery pair lies far from the bot's committed track.
- This report does **not** address the related defect "`estimateTrackCost` evaluates supply and delivery as parallel spurs even when one lies on the path to the other" — that is a separate corridor-vs-spur bug whose fix is independent. JIRA-209 is scoped strictly to "the cold-start branch should remain available to the demand ranker for the duration of the initial-build phase."
