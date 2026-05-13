# JIRA-235 — Investigation: deterministic enumerator and Newcastle Oil pickup (behavioral, analysis-only)

**Status: analysis-only. No code change shipped. Recommendation: do not implement the originally-proposed fix.**

This ticket investigates whether the deterministic trip planner missed a profitable route for s1 in game `cccbc7e1` at t31 (the "skipped Newcastle Oil pickup" observation). After gathering map data and running the aggregate-score math, the planner's choice was correct under its current scoring model. A smaller, genuine defect exists in `computeAggregateScore` (carry-forward blindness), but its magnitude in this specific case is too small to justify the implementation complexity discussed below.

## Source

`logs/game-cccbc7e1-e4ad-4efa-9928-9725bd7f5f7c.ndjson` — bot s1 (Medium skill, deterministic trip planning), t31 replan after Steel→Paris delivery. Discovered 2026-05-12.

## What was observed

At t31 the planner's top-1 reasoning:

```
[deterministic-top-1] pair:83-Hops+20-Fish:BA-sup:Cardiff-Aberdeen chosen.
  Phase: mid (OCPT=4)
  Picked: pair-fresh+fresh — payout 66M, build 35M, 12 turns, NET 31M, score -17.0
  Aggregate: 2.42 M/turn (chained with single:51:Wine-sup:Wien, empty-leg 1 turns)
  Stops: 1) pickup Hops at Cardiff; 2) pickup Fish at Aberdeen; 3) deliver Fish at Bern; 4) deliver Hops at Munchen
  Runner-up #2: single:51:Wine-sup:Wien, aggregate 2.30 M/turn, NET 15M, 9 turns.
  Runner-up #3: single:83:Hops-sup:Cardiff, aggregate 2.29 M/turn, NET 17M, 7 turns.
  Survivors after spatial prune: 204 of 776 raw.
  Discarded by prune: 552 (turns > 12) | 20 (build > 130M).
  Upgrade emitted: superfreight (cost 20M, cash 56M, build 35M).
```

s1's snapshot state at t31:
- `train: fast_freight`, `trainCapacity: 2`
- `cash: 36M`, `connectedMajorCities: ['Paris', 'Holland', 'Wien']`
- 9 demand cards in hand, including:
  - Hops: Cardiff → Munchen ($29M)
  - Fish: Aberdeen → Bern ($37M)
  - **Oil: Newcastle → Warszawa ($21M)** ← the demand cited as "skipped"
  - Wine: Wien → Belfast ($33M)
  - …and 5 others

The observation: the bot would soon pick up Hops at Cardiff and Fish at Aberdeen. Cardiff→Aberdeen passes essentially through Newcastle. Oil's supply is Newcastle. With Oil's demand in hand and an empty slot (cap going to 3 after the planned upgrade), why wasn't Oil picked up "on the way"?

## What the data actually says

### City coordinates (from `configuration/gridPoints.json`)

| City | Row | Col |
|------|-----|-----|
| Cardiff | 17 | 26 |
| Newcastle | 9 | 32 |
| Aberdeen | 2 | 34 |
| Bern | 37 | 40 |
| Munchen | 36 | 47 |
| Wien | 36 | 55 |
| Warszawa | 26 | 63 |

### Hex distances (Chebyshev)

| Pair | Hex |
|------|-----|
| Cardiff → Aberdeen (direct) | 15 |
| Cardiff → Newcastle | 8 |
| Newcastle → Aberdeen | 7 |
| **Cardiff → Newcastle → Aberdeen** | **15** |
| Munchen → Warszawa | 16 |
| Wien → Warszawa | 10 |
| Newcastle → Warszawa | 31 |

**Newcastle sits on the Cardiff→Aberdeen path** — the hex-distance detour cost is zero. The user's "skipped right past Newcastle" framing is geographically correct.

### Aggregate-score math (back-of-envelope)

**Pair (Hops+Fish), as chosen:**
- c1.net = 31M, c1.turns = 12 (from log)
- Best c2 = `single:Wine-Wien` (Wien is on s1's network). Cheap, c2.net ≈ 15M
- aggregate ≈ (31+15) / (12+1+7) = 46/20 ≈ **2.3 M/turn** ✓ (matches the logged 2.42)

**Hypothetical pair+carry-Oil (would require cap=3):**
- c1.net = 31 − ~1M for tiny Newcastle detour = 30M, c1.turns ≈ 12
- c2 = "deliver Oil from Munchen": new track to Warszawa. Cheapest route is via Wien (already connected). Wien→Warszawa = 10 hex × ~1.5M/hex ≈ 15M build. Travel ≈ 2 turns. c2.payout = 21M. c2.net ≈ 21 − 15 = **~6M**
- aggregate ≈ (30+6) / (12+1+3) = 36/16 ≈ **2.25 M/turn**

**Pair (Hops+Fish) wins by ~0.05 M/turn.** The user's gut — "Warszawa is heavy new track" — is correct. Even at the geometrically-free Newcastle pickup, the deferred Warszawa delivery has enough build cost to make the aggregate slightly worse than picking a cheap follow-up like Wine-Wien.

### The cap-at-planning-time finding

`snapshot.bot.trainType = fast_freight` at t31, so the planner ran with `cap = 2`. The "Upgrade emitted: superfreight" line in the log is the planner's **post-hoc** decision to attach an upgrade action to the chosen candidate (see `selectUpgradeTarget` in `DeterministicTripPlanner.ts:~1169`). Candidate enumeration runs **before** that decision.

This means: even if a `genPairsWithCarryPickup` generator existed and was gated on `cap >= 3`, **it would have been a no-op for this exact case** — the planner sees `cap=2` and doesn't generate cap-3 variants.

A real fix would have to either:
1. Run enumeration twice (pre-upgrade cap and post-upgrade cap, with upgrade cost included in the post-upgrade pass), or
2. Reframe upgrade as a candidate-time decision rather than a post-hoc attachment.

Both are larger changes than the originally-proposed enumerator addition.

## Conclusions

1. **The planner's choice was correct under its current scoring model.** The user's gut about heavy Warszawa track is borne out by the math: pair beats pair+carry on aggregate by ~0.05 M/turn even with the Newcastle pickup being geometrically free.

2. **The "Newcastle is on the path" observation is geographically accurate** but it does not by itself imply a planning bug. The cost of the eventual delivery dominates the credit from a free pickup.

3. **There IS a smaller genuine defect** in `computeAggregateScore`: it doesn't account for carry-forward state. When the planner considers c2 candidates for the pair (no-carry case), it should ideally recognise that the Oil follow-up requires re-traversing UK→Newcastle, which is expensive. In the carry-forward case, the bot is already at Munchen with Oil on board, saving ~30 hex of future travel. The current aggregate doesn't see this.

   In this specific scenario the magnitude of the defect is small (~0.05 M/turn) because Wine-Wien is a cheap-enough alternative c2 that the bot wouldn't naturally chase Oil next anyway. In other game states the gap could be larger.

4. **The originally-proposed `genPairsWithCarryPickup` generator is the wrong fix.** Reasons:
   - Wouldn't trigger for the observed case (cap=2 at planning).
   - The carry-credit constant (`CARRY_CREDIT_FRACTION = 0.5`) is unprincipled and would over- or under-credit different carries.
   - Even when triggered correctly, the variant doesn't beat the regular pair in this case.
   - The candidate-count growth (~3× the base ~776) isn't justified by the marginal score benefit.

## Recommendation

**Do not implement the originally-proposed generator.** Revert the `genPairsWithCarryPickup` change (done).

Two smaller defects remain on the table for future tickets:
- **D1 (smaller):** `computeAggregateScore` carry-forward blindness. Score improvement in this game ≈ 0.05 M/turn; impact in other games unknown but expected small. Low priority unless a game surfaces a larger gap.
- **D2 (independent):** s3's actual stuck-at-$7M problem is `scoreCandidate`'s affordability gate accepting an unfundable Medium-skill deterministic route at t15. This is a different bug — likely `simulateTrip` underestimating `minCashRelative` for high-build routes with no income mid-trip. Spin out as a separate ticket; A3's stuck-build-progress guardrail (already shipped in JIRA-234) is the safety net there.
