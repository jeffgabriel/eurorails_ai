# JIRA-263 — Slice `activeRoute.stops` by `currentStopIndex` in `detectCarriedLoads` implicit-carry signal (technical)

Companion to `jira-263-postDeliveryReplanStrandsCarriedLoad-behavioral.md`.

One structural fix. No tuning knob, no scoring penalty, no hard filter on candidates. The defect is a stale-state read in `detectCarriedLoads`; once carry detection matches reality, the math handles the rest.

## The fix — implicit-carry signal must slice by `currentStopIndex` (1-line change)

**Defect locus.** `src/server/services/ai/DeterministicTripPlanner.ts:281-290` (the implicit-carry walk inside `detectCarriedLoads`).

Current code:

```ts
if (activeRoute?.stops) {
  const pickedUp = new Set<string>();
  for (const stop of activeRoute.stops) {                        // ← walks ALL stops
    if (stop.action === 'pickup') pickedUp.add(stop.loadType);
    else if (stop.action === 'deliver' && !pickedUp.has(stop.loadType)) {
      implicitCarry.add(stop.loadType);
    }
  }
}
```

After a mid-turn delivery, `currentStopIndex` advances past the delivered stop, but `stops` is unchanged. The walk treats the historical `deliver Bauxite@Munchen` as evidence that Bauxite is implicitly carried — because no `pickup Bauxite` precedes it in the original route (Bauxite was picked up before this route was created, on an earlier strategic route).

Fix:

```ts
if (activeRoute?.stops) {
  const remaining = activeRoute.stops.slice(activeRoute.currentStopIndex);
  const pickedUp = new Set<string>();
  for (const stop of remaining) {
    if (stop.action === 'pickup') pickedUp.add(stop.loadType);
    else if (stop.action === 'deliver' && !pickedUp.has(stop.loadType)) {
      implicitCarry.add(stop.loadType);
    }
  }
}
```

Note: the signature of `detectCarriedLoads(activeRoute, demands, cargoLoads)` already passes the full `activeRoute` (with `currentStopIndex`), so no new arguments needed. The slice happens locally.

**Effect on T44.** Remaining slice after Bauxite delivery is just `[deliver Tourists@Venezia]`. Tourists is not in pickedUp → `implicitCarry.add('Tourists')`. Bauxite no longer falsely flagged. cargoCount becomes `{Tourists: 1}` — correct.

Subsequent flow with the corrected carry map:
- The fresh `Bauxite→Berlin@14` demand has loadType=Bauxite, NOT in cargoCount → `isCarry = false`.
- `genPairs` cannot emit `cB-pA` with Bauxite as carry; the only Bauxite-Berlin candidate has a pickup at Marseille (the canonical Bauxite supply) with substantial build cost + travel turns, pushing turns from 3 toward 10+ and dropping aggregate from 7.72 to ~2 M/turn.
- Pair-carry+fresh candidates including Tourists rank higher because the Tourists carry adds $19M for zero pickup cost.
- The genuine winner is some `pair-carry+fresh: Tourists+X` plan (likely Tourists+Beer-Sevilla@$48 — payout $67M, route Munchen→Venezia→Sevilla — or Tourists+Beer-Hamburg if geography prefers).

## Why no hard "carries must be delivered" filter, no scoring penalty

A prior draft of this ticket proposed two extras: (a) a scoring penalty that subtracts abandoned-carry payout from candidate NET, and (b) a hard candidate filter that excludes any plan dropping a deliverable carry. Both are wrong on principle.

**Carry abandonment is a real strategic option, just rare.** A bot CAN legitimately choose to drop a carry — e.g., a $48M fresh pickup is right alongside the network while the carry's delivery is a 6-turn diversion for $6M, or the carry's matching demand card is about to be discarded for hand cycling. These cases are uncommon, but they exist, and the planner needs to be free to pick them when the math says so. Hard-filtering carry-dropping candidates would prevent the planner from ever finding them.

**The math already handles displacement correctly — once carry detection is right.** With Fix A applied:

- A plan that drops a carry pays the real cost: the carry's payout is forgone (not earned), and the bot still has to drop the load somewhere (cargo space), and the card stays in the hand until it cycles. None of these enter as artificial penalties — they're already absent from the candidate's NET because it doesn't include the carry's delivery.
- A plan that delivers the carry earns its full payout for ~zero pickup cost (the pickup turn was already paid on a prior turn). That structural advantage is already in the aggregate score.

So in the typical case, carry-delivering plans win on aggregate because their NET is higher for the same or fewer turns. In the rare case where the math genuinely says "drop the carry, the fresh opportunity dominates" — the planner picks that plan, and it's the correct call.

The defect at T44 wasn't that the math was wrong; it was that `detectCarriedLoads` reported a phantom carry, which polluted every downstream computation. Fix the input; the output sorts itself out.

## Acceptance criteria

- **AC1 (unit, post-execution slice)** `detectCarriedLoads` with activeRoute=`[pickup A, deliver B, deliver A]` and `currentStopIndex=2` (post-B-delivery), `cargoLoads=[A]`. Assert result is `{A: 1}`, not `{A: 1, B: 1}`.
- **AC2 (unit, pre-execution preserved)** Same activeRoute=`[pickup A, deliver B, deliver A]` but `currentStopIndex=0` (B is genuinely carried, route untouched), `cargoLoads=[A, B]`. Assert result is `{A: 1, B: 1}` — existing implicit-carry behavior preserved when stops are still ahead.
- **AC3 (unit, mid-execution slice)** activeRoute=`[pickup A, deliver A, deliver B, pickup C, deliver C]`, `currentStopIndex=2` (A pickup and A delivery done, B about to deliver, C still to pickup). `cargoLoads=[B]`. Remaining slice is `[deliver B, pickup C, deliver C]`. Assert result is `{B: 1}`.
- **AC4 (replay)** Reconstruct s3's T44 state from `logs/game-8e176094-a679-490f-9406-d6faa7b55723.ndjson` (activeRoute `[Ruhr(Tourists), Munchen(Bauxite), Venezia(Tourists)]` with `currentStopIndex=2`, `cargoLoads=[Tourists]`). Assert `detectCarriedLoads` returns `{Tourists: 1}` and the planner's chosen route contains a `deliver Tourists@Venezia` stop.
- **AC5 (carry-displacement allowed)** Synthetic fixture where the carry's matching demand pays $6M with a 6-turn detour, and a fresh pair pays $80M for 4 turns on-network. Assert the planner CAN pick the fresh pair even though it drops the carry — displacement on math, not blocked by any filter. (Documents the freedom that this fix preserves; no behavioral assertion beyond "candidate is in the set and can win".)

## Files touched

- `src/server/services/ai/DeterministicTripPlanner.ts` — 1-line slice in `detectCarriedLoads`.
- `src/server/__tests__/ai/DeterministicTripPlanner.test.ts` — AC1, AC2, AC3, AC5 tests.
- Possibly a new `__tests__/ai/jira263Replay.test.ts` for AC4 if the replay fixture is non-trivial.

## Not in scope

- LLM-side replanner (`TripPlanner.planTrip`'s LLM path). The fix is in the deterministic planner only.
- Adding a hard "carries must be delivered" candidate filter. Deliberately excluded — see "Why no hard filter" above.
- Any scoring-side change (penalty / bonus / per-state carve-out). Deliberately excluded — same reason.
- The "post-delivery card draw could introduce a same-loadType fresh demand" scenario as a broader concept. The fix here handles it correctly because carries are detected against actual cargo state, not against same-loadType demand-card inheritance.
- Reordering of stops within a candidate (carry-first vs fresh-first orderings). Enumerator already produces multiple orderings; the scorer picks the best.
- Backfill of past games. Going-forward only.

## Cross-references

- JIRA-220 — `TurnExecutor.handleDeliverLoad` mid-turn `snapshot.bot.loads` mutation. That fix correctly updates the canonical signal (1) in `detectCarriedLoads`. The current ticket addresses signal (3) — the implicit-carry walk — which is independent of JIRA-220 and fires regardless of whether (1) is correct.
- JIRA-249 — route omits pickup for new demand. Related family ("candidate enumeration emits plans inconsistent with cargo state") but a different root cause; not the source of T44.
