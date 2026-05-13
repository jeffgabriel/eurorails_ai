# JIRA-228 — Fresh-fresh pair enumeration missing backhaul ordering (technical)

Companion to `jira-228-freshPairBackhaulOrderingMissing-behavioral.md`. Read that first for the game evidence and acceptance criteria.

## Current implementation

### `genPairs` (`DeterministicTripPlanner.ts:340-392`)

```ts
function genPairs(rows: NormalizedDemandRow[], cap: number): Candidate[] {
  if (cap < 2) return [];
  const pairs: Candidate[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      if (a.cardIndex === b.cardIndex) continue;
      const aCarry = a.isCarry, bCarry = b.isCarry;
      const delA: RouteStop = { /* ... */ };
      const delB: RouteStop = { /* ... */ };
      const pickA: RouteStop = { action: 'pickup', loadType: a.loadType, city: a.supplyCity! };
      const pickB: RouteStop = { action: 'pickup', loadType: b.loadType, city: b.supplyCity! };

      const variants: { suffix: string; stops: RouteStop[] }[] = [];
      if (aCarry && bCarry) {
        variants.push({ suffix: 'cAcB', stops: [delA, delB] });
        variants.push({ suffix: 'cBcA', stops: [delB, delA] });
      } else if (aCarry) {
        variants.push({ suffix: 'cA-pB', stops: [pickB, delA, delB] });
        variants.push({ suffix: 'pB-cA', stops: [pickB, delB, delA] });
        variants.push({ suffix: 'delAfirst', stops: [delA, pickB, delB] });
      } else if (bCarry) {
        variants.push({ suffix: 'cB-pA', stops: [pickA, delB, delA] });
        variants.push({ suffix: 'pA-cB', stops: [pickA, delA, delB] });
        variants.push({ suffix: 'delBfirst', stops: [delB, pickA, delA] });
      } else {
        // Fresh-fresh — only two variants
        variants.push({ suffix: 'AB', stops: [pickA, pickB, delA, delB] });
        variants.push({ suffix: 'BA', stops: [pickA, pickB, delB, delA] });
      }
      // ...
    }
  }
}
```

The fresh-fresh `else` branch at lines 377-380 is the only branch that omits interleaved orderings.

## Fix plan

Add two interleaved variants to the fresh-fresh branch. Mirrors the structure of the carry-case branches.

### Edit (`DeterministicTripPlanner.ts:377-380`)

```ts
} else {
  variants.push({ suffix: 'AB',         stops: [pickA, pickB, delA, delB] });
  variants.push({ suffix: 'BA',         stops: [pickA, pickB, delB, delA] });
  variants.push({ suffix: 'A-then-B',   stops: [pickA, delA, pickB, delB] });
  variants.push({ suffix: 'B-then-A',   stops: [pickB, delB, pickA, delA] });
}
```

That's the entire production code change. No other files touched.

### Why these two and not more

There are six distinct stop orderings for a fresh-fresh pair where each pickup precedes its delivery:

1. `[pickA, pickB, delA, delB]` — `:AB` (existing)
2. `[pickA, pickB, delB, delA]` — `:BA` (existing)
3. `[pickA, delA, pickB, delB]` — `:A-then-B` (new)
4. `[pickB, delB, pickA, delA]` — `:B-then-A` (new)
5. `[pickA, delA, pickB, delB]` — duplicate of #3 (no other arrangement keeps pickup before delivery for both)
6. `[pickB, pickA, delA, delB]` and similar — symmetrical with `:AB` / `:BA` if we consider unordered (i,j).

The outer loop already enumerates unordered pairs (`j = i + 1`), so the (B,A) symmetric of `:AB` is implicitly covered by iterating over the same pair with A and B swapped — which DOES happen at the variant level: `:BA` differs from `:AB` only in delivery order. By symmetry, `:A-then-B` and `:B-then-A` cover the two non-trivial interleaved patterns. No further variants are needed.

### Capacity considerations

With train capacity 2 (Freight, Fast Freight), the bot can carry both A and B simultaneously. Both new variants respect this:

- `:A-then-B`: capacity used 1 (pickup A → 1) → 0 (deliver A → 0) → 1 (pickup B → 1) → 0 (deliver B → 0). Peak: 1.
- `:B-then-A`: peak: 1.

Both stay well within capacity 2. Capacity 3 trains are even safer.

### Why not also add `[pickB, pickA, delA, delB]` style?

The outer loop's `j = i + 1` ordering means we enumerate each unordered pair exactly once. The `:AB` / `:BA` / `:A-then-B` / `:B-then-A` set of 4 variants captures all four meaningfully distinct orderings of pickup-deliver patterns for the unordered pair {A, B}:

- Both pickups first, deliver A first
- Both pickups first, deliver B first
- A all-the-way before B
- B all-the-way before A

The two not-yet-listed orderings (`[pickB, pickA, ...]`) are isomorphic to `[pickA, pickB, ...]` after swapping A and B's labels, which the outer loop's symmetry handles (when the pair is enumerated as (A=other, B=this) instead of (A=this, B=other), `:AB` becomes `:BA` of the original).

## Tests

### Unit (`DeterministicTripPlanner.genPairs.test.ts` extensions)

- **AC1**: Given two fresh `NormalizedDemandRow` entries (neither `isCarry`), `genPairs` MUST return 4 variants per pair: `:AB`, `:BA`, `:A-then-B`, `:B-then-A`. Variant count assertion: `result.length === 4` for a 2-row input.
- **AC2**: Each new variant has the expected stop sequence:
  - `:A-then-B`: stops match `[pickA, delA, pickB, delB]` by city and action.
  - `:B-then-A`: stops match `[pickB, delB, pickA, delA]` by city and action.
- **AC3**: Existing carry variants unchanged. With one fresh and one carry, `genPairs` MUST still return exactly 3 variants (`:cA-pB`, `:pB-cA`, `:delAfirst`) — fix only touches the fresh-fresh branch.
- **AC4**: Demands on the same `cardIndex` still skipped (existing behavior preserved). `genPairs` MUST return 0 variants for `[a, b]` where `a.cardIndex === b.cardIndex`.

### Game-replay regression (`DeterministicTripPlanner.game3612bf42T78.test.ts`)

Reproduce the T78 hand. Without the fix: pair Copper+Oranges enumerates as `:AB` and `:BA` only. With the fix: the candidate list contains `:A-then-B` with stops `[pickup Copper @ Wroclaw, deliver Copper @ Madrid, pickup Oranges @ Valencia, deliver Oranges @ Manchester]`.

### Score smoke test (`DeterministicTripPlanner.backhaulScoring.test.ts`)

Score the Copper+Oranges pair across all four fresh-fresh variants under late-phase OCPT=7 with the bot starting near Berlin. Assert: `:A-then-B` score > `:AB` score (less negative). The exact values come from the simulator and may shift as the simulator evolves; the test asserts ordering only.

## Risk

- **Candidate count growth**: 2× more pair variants per fresh-fresh pair. For a 9-card hand with no carry: previously 9×8/2 × 2 = 72 fresh-fresh pair candidates; after fix: 144. Total candidate count goes from 90-ish to ~160. The spatial prune already runs in O(candidates) so this adds modest cost. `simulateTrip` runs only on survivors, so the per-call cost in scoring is bounded by survivors.
- **Cluttered runner-up output**: more variants might add noise to the `composition.reasoning` runners-up list. Current code shows top-3 only, so the runners-up list size doesn't grow — but the chosen vs runners-up gap may compress (more candidates clustered at similar scores). Mitigate by keeping the current top-3 cap; if observability suffers, add a fourth or fifth runner-up later.
- **Variant naming collisions**: the new suffixes `:A-then-B` and `:B-then-A` have hyphens. Existing suffixes like `:cA-pB` already use hyphens, so no parser collision. Tests verify the suffix string in the candidate ID.

## What does NOT change

- `genSingles`, `genTriples` — fix is scoped to `genPairs` fresh-fresh branch only.
- `cheapPrune`, `scoreCandidate`, `simulateTrip` — they consume candidates by stops; orderings flow through unchanged.
- The OCPT scoring weights, prune thresholds, or any other tuning constant.

## Confirmation

After the fix, the T78 reasoning output for a Copper+Oranges pair candidate could legitimately read:

```
Picked: pair:4-Copper+122-Oranges:A-then-B — payout 86M, build 18M, 11 turns, NET 68M, score -9.0
  Stops: 1) pickup Copper at Wroclaw; 2) deliver Copper at Madrid;
         3) pickup Oranges at Valencia; 4) deliver Oranges at Manchester
```

(Numbers illustrative — actual values come from the simulator at runtime.)

The variant suffix `:A-then-B` in the candidate ID is the visible signal that the new ordering is being considered.
