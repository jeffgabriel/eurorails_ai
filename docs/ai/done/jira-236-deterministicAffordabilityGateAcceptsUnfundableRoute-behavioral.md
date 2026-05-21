# JIRA-236 — Deterministic affordability gate accepts unfundable route; bot ends stuck mid-route at <$10M (behavioral)

This ticket captures D2 from the JIRA-234/235 chain: in game `cccbc7e1`, bot s3 (Medium skill) accepted a $48M-build trip with $27M starting cash and ended the game stuck at $7M with 17+ consecutive PassTurns. The chosen route went through `DeterministicTripPlanner.scoreCandidate`, whose JIRA-223 / JIRA-232 affordability gate is supposed to catch exactly this case. It did not.

In addition, the bot upgraded fast_freight → superfreight during the same turn even though the deterministic planner's reasoning does not contain an "Upgrade emitted" line — suggesting an upgrade-emission path outside the documented `selectUpgradeTarget` flow. That secondary mystery is captured here as an open question for the investigator; the primary defect is the affordability acceptance.

## Source

`logs/game-cccbc7e1-e4ad-4efa-9928-9725bd7f5f7c.ndjson` — bot s3, t15 post-delivery replan. Discovered 2026-05-12.

## Observed trace

s3 starts game with a Freight train. Upgrades to fast_freight at t11 (with bot.money=$61M at planning time, build=$41M, so `61 >= 20+41 = 61` — passes affordability by exactly $0).

Between t12 and t14 the bot completes the Wine pair route (Wien×2 → Napoli/Roma):

| Turn | Cash (end) | Train | Loads | Action |
|------|-----------|-------|-------|--------|
| t13 | 5 | fast_freight | [Wine, Wine] | BuildTrack (cost=16, segs=12) |
| t14 | 0 | fast_freight | [Wine, Wine] | BuildTrack (cost=5, segs=1) |
| t15 | 27 | fast_freight | none | **UpgradeTrain (cost=20, segs=0)** ← composite turn (see below) |
| t16 | 21 | superfreight | none | BuildTrack (cost=6, segs=2) |
| t17 | 7 | superfreight | [China] | BuildTrack (cost=14, segs=11) |
| t18–t34 | 7 | superfreight | [China] | MoveTrain / **PassTurn × 17** |

t15 actionBreakdown (per game log): `Move → Deliver Wine → Move → Deliver Wine → Move → **UpgradeTrain**` — six steps. The two Wine deliveries (Napoli + Roma) clear the train; the post-delivery replan fires; the new Fish+China route gets committed; the bot then executes an UpgradeTrain that takes fast_freight → superfreight.

End-of-game state for s3 at t34: **cash=$7M, carrying China, route still `del:China@Oslo` at currentStopIndex=1, no progress for 17 turns**. The JIRA-234 A3 guardrail (widened stuck-build-progress detection) is what eventually breaks the loop — but the original sin is that this route was accepted in the first place.

## The planner's decision

t15 `deterministic-top-1` reasoning (verbatim from game log, length 878):

```
[deterministic-top-1] pair:116-Fish+71-China:B-then-A-sup:Oslo-Leipzig chosen.
  Phase: early (OCPT=2)
  Picked: pair-fresh+fresh — payout 72M, build 48M, 15 turns, NET 24M, score -6.0
  Aggregate: 1.45 M/turn (chained with single:4:Cheese-sup:Bern, empty-leg 2 turns)
  Stops: 1) pickup China at Leipzig; 2) deliver China at Oslo; 3) pickup Fish at Oslo; 4) deliver Fish at Budapest
  Rationale: Two fresh demands; pick up and deliver both for combined payout.
  Runner-up #2: single:4:Cheese-sup:Bern, aggregate 1.45 M/turn, NET 5M, 5 turns. Lost by 0.00.
  Runner-up #3: single:4:Cheese-sup:Arhus, aggregate 1.35 M/turn, NET 11M, 11 turns. Lost by 0.10.
  Survivors after spatial prune: 144 of 926 raw.
  Discarded by prune: 694 (turns > 12) | 88 (build > 130M).
  Candidates: raw=926 survivors=144 enumerationMs=1405
```

Notable: **no "Upgrade emitted" line and no "Upgrade skipped" line**. Per `DeterministicTripPlanner.ts:1436–1440` this means `selectUpgradeTarget` returned `{}` (neither target nor gateReason). For s3's state at planning time (fast_freight, cash≈47M after Wine deliveries, buildCost=48M, capSaturated≥2), this is consistent with the affordability check inside `selectUpgradeTarget`: `47 >= 20 + 48 = 68` is FALSE → return `{}`.

So the deterministic trip planner did NOT emit an upgrade. The route's `upgradeOnRoute` field should therefore be undefined.

## State at the affordability gate

City coordinates (from `configuration/gridPoints.json`, mapped as row=GridY, col=GridX):
- s3 position at t15 replan: approximately `(54,46)` (positionStart) — south-central Europe, just-completed Roma delivery
- Leipzig: `(27,50)` — 27 hex north of bot
- Oslo: `(2,51)` — 25 hex further north
- Budapest: `(40,59)` — 38 hex south-east of Oslo

Total straight-line travel: ~90 hex. At fast_freight speed 12: ~8 turns of travel. Plus build for any track not on existing network.

Connected cities: `[Berlin, Wien]`. Both south of Leipzig. The bot's existing track does NOT reach Leipzig, Oslo, or Budapest.

`snapshot.bot.money` at the replan moment is approximately **$47M** (≈$0 at turn start + Wine delivery payouts from Napoli + Roma).

`top1.buildCost = $48M` (per the reasoning log) — the simulator's predicted total build cost across all three legs.

The affordability gate at `DeterministicTripPlanner.ts:812`:
```ts
const projectedMin = startingCash + result.minCashRelative;
if (projectedMin < AFFORDABILITY_FLOOR_M /* = 0 */) reject;
```

For the gate to have PASSED with `startingCash ≈ $47M`, the simulator must have computed `minCashRelative >= -$47M`.

## What actually happened in-game

Cumulative build spend by s3 across t15–t17 (post-Wine-deliveries to stuck point):

- **t15**: $20M (upgrade only — but where did this come from? see open question below)
- **t16**: $6M (2 segments)
- **t17**: $14M (11 segments)
- **Total**: $40M spent. Bot reached **just to Leipzig**, picked up China, then cash dropped to $7M.

Build still required from Leipzig → Oslo: estimated 25 hex × ~$1.5M/hex (mountain + ferry crossings to Norway) = **~$37M more** to reach the FIRST delivery payout. Bot has $7M, can build 1–2 hex/turn until cash → 0, with no income arriving for another ~15–20 turns. Stuck.

Then Oslo → Budapest: another ~38 hex × $1.5M = **~$57M** for the second leg.

Realistic total trip cost: $40M (spent) + $37M (Leipzig→Oslo) + $57M (Oslo→Budapest) ≈ **$134M**, versus the simulator's prediction of $48M.

**Simulator underestimated total build cost by ~$86M**, or roughly 2.8×. Without that underestimate, the affordability gate would have rejected this route (`47 + (-130) = -83 < 0`).

## Likely root cause (hypothesis)

The simulator's `findShortestBuildablePath` (`RouteDetourEstimator.ts:264`) uses Dijkstra over a hex grid with:
- Terrain cost from `getTerrainCost(nbData.terrain)` (clear=1, mountain=2, alpine=5, etc.)
- Water surcharge from `edgeCrossingCost`
- Intra-city major-city red-area: free traversal (per game rule)
- Bot's existing track: free traversal
- **Ferry crossings: FREE** (`newCost = current.cost; // free crossing` at line 364)

The free ferry treatment is the most obvious deviation from game rules. The game rule "the first player to build to a ferry port must pay the full ferry cost" means the simulator should be charging the ferry cost on at least one end. The code computes `ferryPortCosts` from `partners[0].cost` and uses that as the terrain cost when building INTO a ferry port — so the build-into cost may be present, but the **traverse-across cost is zero**. Whether this matches the game's actual ferry economics needs verification against the in-game build logic (`computeBuildSegments`).

For s3's Leipzig→Oslo path, the natural simulator-chosen route is likely Berlin (existing) → Hamburg → København → ferry to Malmö → Göteborg → Oslo. Multiple ferry hops and Scandinavian mountain hexes. If the simulator's terrain cost and free-ferry combine to underestimate this leg by 30–50M, the entire $86M discrepancy is accounted for.

Other candidate causes:
- Pathfinder may find paths through opponent track (line 316 excludes those) — verify with s3's actual snapshot.
- Major-city outpost traversal (Berlin's red area) may chain into a longer reach than the in-game build logic uses.
- `pathToNewSegments` (line 377) may collapse multiple build hexes into fewer segments than the in-game build emits.

## Open question — surprise upgrade emission

The reasoning log shows NO upgrade emitted by the deterministic planner at t15. Yet the bot fired an UpgradeTrain action (cost $20M, fast_freight → superfreight) during the same turn, attributed in `actionBreakdown` to `actor=system, detail=route-executor`.

Searching the code, the route-executor only emits UpgradeTrain via `pendingUpgradeAction`, which is set by:
1. `NewRoutePlanner.tryConsumeUpgrade` — requires `route.upgradeOnRoute` set by the trip planner. We've shown this was NOT set for s3 at t15.
2. `NewRoutePlanner` JIRA-105b (Upgrade-before-drop LLM) — gated on `routePickupCount > effectiveFreeSlots`. For s3 t15 the new route's leading pickup count is 1 and cap is 2, so the gate is false and this path doesn't fire either.

So neither documented path should have produced the upgrade. Yet it happened. Possibilities:
- Logging defect: "Upgrade emitted" line was suppressed or truncated, hiding the actual emission.
- A third upgrade-emission path exists that grep didn't surface.
- The upgrade was emitted by an EARLIER mid-turn replan (after the first Wine delivery, before the Napoli+Roma deliveries got reflected in money), where the math worked out. The activeRoute then carried the upgradeOnRoute through to consumption.

Either way, the bot upgraded, adding $20M to the cash drain. The affordability gate didn't know about this upgrade (since the planner didn't emit it), so the simulator ran without `pendingUpgradeCost=20`. Even on top of the build cost underestimate, this added another $20M of unforeseen drain.

## Acceptance

Primary defect (build cost underestimate):
- A unit test reconstructing s3's t15 snapshot (position, cash, train, network, demand cards) and feeding it through `planTripDeterministic` produces either:
  - A route with a `minCashRelative` reflecting realistic build cost (≥-$47M minus the actual ferry/mountain Scandinavia geometry), causing the affordability gate to REJECT, OR
  - A different route candidate is selected (e.g. Cheese single from runner-up #2), OR
  - `outcome: 'no_feasible_candidates'` falls through to heuristic fallback.
- `simulateTrip`'s total build cost for an UK/Scandinavia/Eastern-Europe path agrees with what `computeBuildSegments` would charge for the same path within ±10% (or the discrepancy is documented and accepted).

Secondary defect (surprise upgrade emission):
- An investigator confirms the actual emission path for the t15 upgrade. Either:
  - A code path is identified and the simulator's `pendingUpgradeCost` integration is extended to cover it, OR
  - It's a logging defect and the existing path is correctly emitting + logging is fixed, OR
  - It's truly mysterious and should be reproduced/traced under a debugger before fixing.

## Not in scope

- Fixing s3's stuck state at runtime — already addressed by JIRA-234 A3 (widened `noProgress` detection in `ActiveRouteContinuer`).
- The carry-forward aggregate scoring defect (D1, JIRA-235 §"Conclusions point 3") — independent.
- The LLM-path affordability gate (JIRA-234 A1+A2) — already shipped; addresses Hard-skill bots only.
