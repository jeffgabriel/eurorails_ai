# JIRA-254 — Add same-delivery-city corridor-add enumeration to DeterministicTripPlanner (technical)

Companion to `jira-254-deliveryCorridorMissesOnNetworkFreshPickup-behavioral.md`.

## Defect locus

`src/server/services/ai/DeterministicTripPlanner.ts` — `enumerateCandidates` (or whichever function generates the candidate set fed into scoring). Currently enumerates:

- Single demand candidates (carry-only or pickup+deliver pair)
- Pair candidates (two demands sharing supply OR sharing delivery via the LLM's pair-shared-delivery rule)
- Carried-deliver floor (via `enumerateCarriedDeliveryFloor` from JIRA-248)
- Same-supply corridor candidates (via `enumerateSameSupplyCorridorCandidates` from JIRA-250)

Missing: **carried-deliver + same-delivery-city fresh-pickup corridor-add** candidates.

## Fix shape

Add a new enumeration helper analogous to `enumerateSameSupplyCorridorCandidates`:

```ts
function enumerateCarriedDeliverCorridorAddCandidates(
  context: GameContext,
  snapshot: WorldSnapshot,
  capacity: number,
): CandidateRoute[]
```

**Logic:**

1. For each demand `D_carry` in `context.demands` where `D_carry.isLoadOnTrain === true` AND `D_carry.isDeliveryReachable === true`:
   - Let `deliveryCity_X = D_carry.deliveryCity`.
2. For each other demand `D_fresh` in `context.demands` where:
   - `D_fresh.deliveryCity === deliveryCity_X` (same delivery)
   - `D_fresh.loadType !== D_carry.loadType` (different load, otherwise it's the JIRA-250 same-supply case)
   - `D_fresh.isLoadOnTrain === false` (fresh, not already carried)
   - `D_fresh.isSupplyOnNetwork === true` OR `D_fresh.estimatedTrackCostToSupply <= SOME_THRESHOLD` (cheap to reach supply)
   - `carriedCount(snapshot) + 1 <= capacity` (cargo slot available)
   - `isLoadChipAvailable(D_fresh.loadType, D_fresh.supplyCity, snapshot.gameId)` (load chip still in tray at supply city)
3. Emit candidate of shape `[pickup(D_fresh.loadType @ D_fresh.supplyCity), deliver(D_carry.loadType @ deliveryCity_X), deliver(D_fresh.loadType @ deliveryCity_X)]` with delivery order chosen by network distance from the supply city.

Wire into `enumerateCandidates` alongside the existing emit-rules. No change to scoring — let `scoreCandidate` evaluate these new candidates the same way it evaluates all others. If the corridor-add candidate's aggregate score exceeds the carry-only floor, it wins.

## Scoring expectations

For the T25 game-`6033c903` case, the corridor-add candidate should outrank carry-only because:

- Build cost: identical (0 for both — Zurich is on network)
- Movement cost: corridor-add has +4 mileposts detour to Zurich (1/3 of a Freight turn) + the same Copper→Torino movement
- Payout: +8M (Chocolate) on top of carry-only's 24M
- Estimated turns: corridor-add likely 4 turns vs carry-only's 3 turns (one extra movement turn for the detour + pickup)
- Score (NET / turns):
  - Carry-only: 24M / 3 = 8.0
  - Corridor-add: 32M / 4 = 8.0 ... hmm, equal-ish
- If equal, JIRA-242's multi-delivery expansion bonus tips the corridor-add ahead

The acceptance criteria don't require corridor-add to ALWAYS win — they require it to be ENUMERATED. The scorer then handles ranking. AC2 in the behavioral asserts top-1 wins for the T25 case specifically; if scoring with current weights ties, JIRA-242's bonus should break the tie in corridor-add's favor.

If scoring doesn't break the tie correctly in the T25 fixture, the scorer needs a small additional tuning — but that's a follow-up scope, not part of this ticket. The primary defect is enumeration.

## Acceptance from behavioral

- **AC1** Unit test on `enumerateCarriedDeliverCorridorAddCandidates`: fixture matching T25. Assert: function returns at least one candidate with shape `[pickup(Chocolate@Zurich), deliver(Copper@Torino), deliver(Chocolate@Torino)]`.
- **AC2** Unit test on `planTripDeterministic`: same T25 fixture. Assert: top-1 chosen candidate matches the corridor-add shape. If scoring ties with carry-only, JIRA-242's bonus must break the tie toward corridor-add — if it doesn't, file a follow-up scoring-tune ticket.
- **AC3** Unit test: same fixture but Zurich is NOT on network. Assert: corridor-add candidate IS enumerated (the gate is `isSupplyOnNetwork === true || estimatedTrackCostToSupply <= THRESHOLD` — both should permit Zurich-off-network too, perhaps with a higher cost threshold). Score will be lower; carry-only may win — that's fine.
- **AC4** Unit test: same fixture but Chocolate's deliveryCity = "Milano" (different from Copper's Torino). Assert: corridor-add NOT enumerated (different delivery city).
- **AC5** Unit test: same fixture but bot capacity = 1 (still has Copper in slot 1, no room for Chocolate). Assert: corridor-add NOT enumerated.
- **AC6** Integration test: replay Sonnet T23 of game `6033c903`. Assert: the candidate set logged in `CompositionTrace.candidates` includes a Chocolate corridor-add candidate.

## Not in scope

- LLM-side candidate generation. The trip-planning system prompt already says "COMBINE CORRIDORS"; verify whether the LLM (Hard skill) handles this correctly. If yes, JIRA-254 only fixes the deterministic (Medium) path.
- Scoring weight tuning. If AC2 fails because the corridor-add ties with carry-only and the tiebreaker doesn't favor it, file a follow-up. The enumeration fix is the primary goal.
- N-stop corridor extensions (e.g., chaining 3+ deliveries to the same city). Limited to the 2-stop add-on case.

## Validation hooks to inspect during fix

- `CompositionTrace.candidates` at T25 of game `6033c903` should include a candidate of the form `pickup(Chocolate@Zurich) + Copper→Torino + Chocolate→Torino`.
- The carry-only candidate (from `enumerateCarriedDeliveryFloor`) should remain as a floor — the corridor-add is an *addition*, not a replacement.
- `demandRanking` at T25 should continue to include both demands as before; no demand-context change.

## Relationship to existing JIRAs

- **JIRA-248** (`enumerateCarriedDeliveryFloor`): the floor that's being augmented. The corridor-add is an *extension* of the floor candidate.
- **JIRA-250** (`enumerateSameSupplyCorridorCandidates`): sibling enumeration rule. Same family of candidate-generator gap fix.
- **JIRA-242** (multi-delivery expansion bonus): may act as the tiebreaker if corridor-add and carry-only score equally on raw NET/turn.
- **JIRA-253** (carry-deliver abandon livelock): orthogonal executor concern; doesn't interact with this enumeration fix.
