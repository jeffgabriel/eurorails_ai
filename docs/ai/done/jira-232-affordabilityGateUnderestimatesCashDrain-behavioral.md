# JIRA-232 — Affordability gate approves routes the bot cannot actually afford to complete (behavioral)

## Source

Pattern observed in three games:

- `logs/game-20e24f2d-b232-4639-8e08-5008f1639aaa.ndjson` — bot `1ab45c0d`, cash hits $0 at t15, then 87-turn PassTurn streak.
- `logs/game-36eab81a-ca98-47b9-9707-9c980b0d9ef6.ndjson` — bot `462ba082`, 103-turn PassTurn streak.
- `logs/game-d04bca96-5d79-4030-9ba8-cfbe96b11792.ndjson` — bot `963fc9d5` (s1), 41-turn PassTurn streak, also after JIRA-230 shipped.

Most diagnostic detail is from game `20e24f2d` (s1's t9-t15 trace), reproduced below.

## Observed behavior — game 20e24f2d, bot 1ab45c0d, t9-t15

| Turn | Cash before | Action | Spend | Cash after | Event |
|------|------------:|--------|------:|-----------:|-------|
| t8 | 30M | MoveTrain | 0 | 30M | en route to Munchen with Coal (active route: Coal Krakow→Munchen) |
| **t9** | **30M** | **UpgradeTrain** | **20M** | **25M** | Delivers Coal (+15M). Planner replans → picks route Wine Frankfurt→Antwerpen with `upgradeOnRoute: fast_freight`. **Reasoning says: "Picked: single-fresh — payout 10M, build 14M, 6 turns, NET −4M, score −16.0" AND "Upgrade emitted: fast_freight (cost 20M, cash 45M, build 14M)".** |
| t10 | 25M | BuildTrack | 7M | 18M | Building toward Wine pickup |
| t11 | 18M | BuildTrack | 8M | 10M | Picks up Wine — built **15M of new track so far** |
| t12 | 10M | BuildTrack | 3M | 17M | Delivers Wine (+10M). Total Wine-route build = **18M**. **Planner replans → picks NEW route Chocolate Bruxelles→Manchester** |
| t13 | 17M | BuildTrack | 7M | 10M | Picks up Chocolate, building toward Manchester |
| t14 | 10M | BuildTrack | 4M | 6M | |
| t15 | 6M | BuildTrack | 6M | **0M** | Stranded mid-build. No further income possible. |
| t16+ | 0M | PassTurn × 87 | — | 0M | |

The planner correctly predicted the Wine route's per-trip economics: "NET −4M, score −16.0" — it knew the route was a money-loser. It picked it anyway because every other candidate was *worse* under aggregate ranking, given the bot's poor hand at the time. **Picking a money-losing route is a separate concern; the bug this ticket addresses is that the JIRA-223 affordability gate approved a route the bot couldn't actually afford to execute.**

## Why the affordability gate let this through — two compounding defects

### Defect A: Upgrade cost is not in the simulator's cash flow

`RouteDetourEstimator.simulateTrip` tracks `cashRelative` turn-by-turn:
- `RouteDetourEstimator.ts:583` — `cashRelative -= builtThisTurn;` (subtracts build spend)
- `RouteDetourEstimator.ts:619` — `cashRelative += stop.payment;` (adds delivery payout)

There is **no code path that subtracts the 20M upgrade cost** when the chosen route carries `upgradeOnRoute`. Yet `selectUpgradeTarget` (DeterministicTripPlanner.ts:807) emits the upgrade alongside the route, and the bot pays 20M on the same turn the route starts.

Concrete numbers from t9:

| Component | Simulator's view | Reality |
|-----------|-----------------:|--------:|
| `startingCash` | 45M (post-Coal-delivery projection) | 45M ✓ |
| `result.minCashRelative` | ~−14M (Wine-route build only) | −34M (build + 20M upgrade) |
| `projectedMin` (used by gate) | 45 + −14 = **31M** ✓ passes floor=0 | 45 + −34 = **11M** (would still pass, but barely) |
| Actual lowest cash during route | — | observed at $0 mid-build (t15) — additional 8-10M not captured |

The gate computed `45 + −14 = 31M ≥ 0` and approved. If the upgrade had been included, the gate would have computed `45 + −34 = 11M ≥ 0` — still approved, but the safety margin would have been visibly thin instead of invisibly so.

This defect alone doesn't fully account for the broke state. Defect B does the rest.

### Defect B: Predicted `totalBuildCost` is systematically below actual build spend

At t9 the planner predicted **build 14M** for the Wine route. The bot's actual BuildTrack spend on the Wine route (t10-t12) summed to **18M** (7 + 8 + 3). That's a **29% overrun on a single route**.

At t12 the planner replanned to Chocolate Bruxelles→Manchester. Starting cash $17M. The bot built 7 + 4 + 6 = **17M** for the new route and ran out before the route completed. If `simulateTrip` had predicted ≥18M of build for this route (which it didn't, or the gate would have rejected with `17 − 18 = −1M < 0`), the gate would have caught it.

The mechanism for the simulator's underestimate is not yet diagnosed. Plausible candidates from reading `simulateTrip` and surrounding code:

- **Path divergence.** `simulateTrip` uses `findShortestBuildablePath` to plan a route from the bot's current position through all stops. At execution time, the runtime `BuildPhasePlanner` chooses each turn's build segments independently. If the runtime picks a different (longer) path than the simulator, the cumulative build cost diverges.
- **Major-city build cost accounting.** Building into a major city costs 5M (per the rulebook), into medium/small cities 3M. If `pathToNewSegments` doesn't apply the city milepost surcharge identically to how the runtime BuildTrack action does, costs diverge by 2-5M per city entered.
- **Water-crossing surcharges.** Rivers (+2M), lakes (+3M), ocean inlets (+3M), mountain mileposts (+2M), alpine (+5M). Any discrepancy in how the simulator's segment cost sums these vs how the runtime executor applies them produces an undercount.
- **Multi-leg builds with shared track.** If the simulator's leg-by-leg path computation lets the leg-2 path reuse infrastructure built mid-leg-1, but the runtime can't (because the leg-1 build wasn't completed when leg-2 starts), costs diverge.

This list is hypothetical until the mechanism is instrumented. The behavioral evidence — multiple 4-8M per-route overruns across three games — is solid; the exact cause requires investigation as part of the fix.

## Expected behavior

The affordability gate's `projectedMin` must be a **true upper bound** on the bot's mid-route cash drain. Specifically:

1. **`simulateTrip`'s `cashRelative` must include the upgrade cost** when the route is being scored as a candidate that would carry `upgradeOnRoute`. The simulator currently has no visibility into the upgrade decision, which is made downstream in `selectUpgradeTarget`. Either:
   - The simulator accepts an optional `pendingUpgradeCost: number` parameter that scoreCandidate passes when an upgrade would be emitted, OR
   - The affordability gate itself subtracts 20M from `projectedMin` after the simulation completes, when `selectUpgradeTarget` indicates an upgrade would be emitted alongside this route.

2. **`simulateTrip`'s `totalBuildCost` (and therefore `minCashRelative`) must match or upper-bound the actual build the runtime executor will perform.** The simulator-vs-runtime path divergence must be instrumented and corrected — either by making the runtime use the same path the simulator predicted, or by making the simulator's prediction conservatively account for the runtime's actual path choice algorithm.

The success criterion: across the three observed broke-state games, replaying each bot's pre-broke turn through the patched gate must result in the gate rejecting the route that historically led to the broke state (or, if the route is genuinely the best available, the gate's projection accurately predicts the cash-at-$0 outcome and a higher-level policy can intervene).

## Pressure-test predictions

**Game 20e24f2d t9 (1ab45c0d picks Wine + upgrade):**
- Current gate: `projectedMin = 45 − 14 = 31M`, approves
- After Defect A fix: `projectedMin = 45 − (14 + 20) = 11M`, still approves but visibly tight
- After Defect A + B fix (assume B adds ~25% margin to build estimate): `projectedMin = 45 − (18 + 20) = 7M`, still approves
- The route is genuinely the bot's best option at this point given its hand. A correct gate approves it but signals (via the cash projection) that the bot has thin margin.

**Game 20e24f2d t12 (1ab45c0d picks Chocolate after Wine delivery):**
- Current gate: `projectedMin = 17 − ~14 = 3M`, approves
- After Defect B fix (predict actual ~17M build): `projectedMin = 17 − 17 = 0M`, exactly at the floor. Gate behavior at the boundary determines outcome (current code is `< floor`, so 0 = 0 passes). Recommendation: change to `<= floor` or move floor to a small positive buffer that doesn't violate the "no cash reserve" rule by being a strict-inequality boundary instead of a reserve floor.

**Game d04bca96 t26 (s1 upgrade trigger):**
- Bot upgraded at $13M post-upgrade — i.e., had $33M pre-upgrade. Whatever route was approved alongside should be re-checked under the patched gate. If the projected drain exceeds $33M, the gate should reject (and consequently the upgrade emission should be suppressed by the existing `selectUpgradeTarget` cash check).

## Scope of this ticket

Tight to the two defects observed:

1. Add upgrade-cost awareness to the affordability gate. Either thread an explicit `pendingUpgradeCost: number` parameter through `scoreCandidate → simulateTrip`, OR (simpler) extend `scoreCandidate` to deduct the upgrade cost from `projectedMin` after the simulation, when `selectUpgradeTarget` would emit `upgradeOnRoute` for this candidate.
2. Diagnose and fix the simulator-vs-runtime build-cost divergence. This is investigative — first step is instrumenting `simulateTrip`'s predicted `totalBuildCost` vs the runtime's cumulative build cost for the same route, captured in the existing game log. Once the mechanism is identified, the fix may be in `pathToNewSegments`, the runtime's BuildPhasePlanner, or a shared cost-computation primitive that both should use.
3. Regression test: reproduce game 20e24f2d t9 snapshot and game d04bca96 t26 snapshot, run the patched gate against the historical chosen routes, assert the patched `projectedMin` matches observed reality within a small tolerance (e.g., ±2M).

## Out of scope

- **PassTurn recovery / broke-state escape.** That's a separate concern — even if the gate is fixed, a bot may still find itself in unsalvageable positions due to other game state (opponent moves, bad hand, etc.). A safety-net recovery is worth filing separately as JIRA-233; do NOT bundle here.
- **The upgrade trigger itself.** This ticket assumes the upgrade gate at `selectUpgradeTarget` is allowed to emit upgrades; it fixes the affordability gate to *accurately predict* the cash consequence. Whether the upgrade should fire less aggressively (more conservative `selectUpgradeTarget`) is a separate, downstream conversation.
- **Cash reserve floors above zero.** Per `feedback_no_cash_reserves.md`, no floor change. The fix is making the simulator's prediction honest, not changing where the floor sits.
- **JIRA-227, JIRA-229, JIRA-230 changes.** Those address different scoring/ranking concerns and remain in place.

## Acceptance

**Unit tests in `src/server/__tests__/ai/RouteDetourEstimator.test.ts` (extend existing) and `src/server/__tests__/ai/DeterministicTripPlanner.test.ts`:**

- **Defect A regression**: When `scoreCandidate` is invoked for a candidate whose `selectUpgradeTarget` would emit an `upgradeOnRoute`, the affordability gate's `projectedMin` value subtracts the 20M upgrade cost. Test constructs a fixture where the route's standalone-cash dip is −15M but with upgrade subtraction becomes −35M, and asserts the gate rejects when `startingCash = 30M` (would have passed without upgrade subtraction at 30 − 15 = 15M, must fail with 30 − 35 = −5M < 0).

- **Defect B observability**: A new test/instrumentation captures the discrepancy between `simulateTrip`'s `totalBuildCost` and the runtime BuildPhasePlanner's actual cumulative build for the same route. The test logs the discrepancy and fails if the diagnosis hasn't been completed (i.e., the test is a placeholder that the implementer must investigate and convert to a real assertion once the mechanism is identified).

- **Game 20e24f2d t9 regression**: Reconstruct the snapshot at t9 (cash, train type, demand cards, position). Run the patched `planTripDeterministic`. Assert that either (a) the Wine + upgrade route is approved with `projectedMin` reflecting the upgrade (≤ 15M, not 31M), OR (b) a different route is selected because the patched gate rejected the Wine + upgrade combination.

- **Game d04bca96 t26 regression**: Same shape — reconstruct snapshot, assert the patched gate's prediction matches actual cash trajectory within ±2M.

## Evidence

- `src/server/services/ai/RouteDetourEstimator.ts:543-583` — `simulateTrip` cash-flow tracking. Lines that subtract build (583), add delivery (619). No upgrade subtraction anywhere.
- `src/server/services/ai/DeterministicTripPlanner.ts:618-636` — `scoreCandidate` affordability gate. Uses `result.minCashRelative` directly.
- `src/server/services/ai/DeterministicTripPlanner.ts:807-831` — `selectUpgradeTarget`. Emits `upgradeOnRoute` based on `cash >= 20 + tripBuildCost` check. The cash check uses `tripBuildCost = top1.buildCost`, which itself is the (undercount) prediction from simulateTrip.
- `logs/game-20e24f2d-b232-4639-8e08-5008f1639aaa.ndjson` — t9-t16 trace showing the gate-approved Wine route's actual cost overrun (predicted 14M, actual 18M).
- `logs/game-36eab81a-ca98-47b9-9707-9c980b0d9ef6.ndjson` — 462ba082's broke-state trajectory, less detailed instrumentation but same outcome.
- `logs/game-d04bca96-5d79-4030-9ba8-cfbe96b11792.ndjson` — s1's t26 upgrade with $13M post-upgrade cash (i.e., pre-upgrade $33M), same defect class.
- `feedback_no_cash_reserves.md` — guardrail; the fix must not introduce a reserve floor above zero. The fix is in *prediction accuracy*, not in the floor's value.
