# JIRA-228 — Fresh-fresh pair enumeration missing pickup-deliver-pickup-deliver backhaul ordering (behavioral)

## Source

Surfaced 2026-05-10 while analysing Sonnet's behavior in game `3612bf42-68ef-47d4-8bac-cb86d5dd453b`. The user observed: at T78 Sonnet picked a single (Wood Sarajevo→Budapest, NET 8M, 9 turns) instead of an obviously-better human pattern that would chain two same-direction loads:

> "Sonnet has decided to go Valencia to get Oranges. It is currently in central Europe. It is not far from a Copper source and Madrid has a demand for Copper. A human would go get the Copper first, then head to Spain to deliver it and pick up the Oranges. In other words, a human would always try to fill the train both directions. Does our algo try to do that?"

The hand had:
- card4 Copper Wroclaw→Madrid (46M)
- card122 Oranges Valencia→Manchester (40M)

Geographically: Wroclaw is east of the bot's network in Poland. Madrid is southwest in Spain. Valencia is on the Spanish east coast (~10 hops from Madrid). Manchester is in northern England.

The natural "human" trip: Wroclaw → Madrid → Valencia → Manchester. Pick up Copper at Wroclaw, deliver Copper at Madrid (cash-positive mid-trip), pick up Oranges at Valencia (already next door), deliver Oranges at Manchester. 4 stops. Crow-flies hops: ~5 + 30 + 10 + 35 = ~80.

## Observed behavior

The deterministic planner's `genPairs` enumerates pair candidates with several stop orderings. For pairs where one demand is already on the train (carry case), it includes interleaved patterns like `:cA-pB` (`pickup B, deliver A, deliver B`) and `:delAfirst` (`deliver A, pickup B, deliver B`) — these are exactly the "drop one before grabbing the other" backhaul shapes a human plays.

But for pairs where **both** demands are fresh (neither carried), the enumeration is restricted to two orderings:

```ts
} else {  // both fresh
  variants.push({ suffix: 'AB', stops: [pickA, pickB, delA, delB] });
  variants.push({ suffix: 'BA', stops: [pickA, pickB, delB, delA] });
}
```

Both force **pickup-pickup-deliver-deliver**. The pattern `[pickA, delA, pickB, delB]` (drop A on the way to pickup B) is **never enumerated** for fresh-fresh pairs.

## Why this matters geographically — Copper + Oranges from T78

The two enumerated orderings produce significantly worse Chebyshev hop sums than the human ordering:

| Variant | Sequence | Approx hops |
|---------|----------|-------------:|
| `:AB` (algo) | Bot → Wroclaw → Valencia → Madrid → Manchester | ~90 |
| `:BA` (algo) | Bot → Wroclaw → Valencia → Manchester → Madrid | ~115 |
| `:A-then-B` (missing) | Bot → Wroclaw → Madrid → Valencia → Manchester | ~80 |

The `:AB` variant requires going from Wroclaw past Madrid (without delivering) all the way to Valencia, then doubling back to Madrid, then forward again to Manchester — roughly 10 wasted hops vs the human ordering. The `:BA` variant is even worse and likely gets cut by the prune cliff (at ~115 hops the build estimate hits ~150M, over the 130M cap from JIRA-227).

The downstream effect on candidate selection:

- **Survival**: `:A-then-B` would have ~10 fewer hops than `:AB`, so it's more likely to clear the build/turn caps (related to JIRA-227, but a separate issue: even after JIRA-227 unfreezes the build cap, `:A-then-B` is strictly cheaper to evaluate).
- **Score**: with 10 fewer hops the simulator estimates fewer turns, which directly improves `score = (payout − buildCost) − OCPT × turns`. At late-phase OCPT=7, 2 fewer turns is +14 score points — often the difference between top-1 and top-3.
- **Cash flow**: `:A-then-B` realises the 46M Copper payout at Madrid mid-trip, before traversing back to Valencia and onward. This eases the cash dip and survives the JIRA-223 affordability gate more readily than `:AB`, which carries both loads through the entire western leg before realising any payout.

A pair that the human would pick instantly is geometrically uncompetitive in the algo's enumeration because the natural ordering is missing.

## Why fresh-fresh case is different from carry case

The carry-case branches (`:cA-pB`, `:delAfirst`, etc.) emit exactly the interleaved shape because the carried load reduces effective capacity by 1 — the bot can't ferry both before delivering, so it has to deliver A first if it wants to pickup B. The enumeration was authored to handle that constraint.

The fresh-fresh branch was authored under the assumption "bot has full capacity, can carry both, so always pickup both before delivering." That's correct for **non-time-of-flight** capacity reasoning, but ignores **geography**: even when capacity allows pickup-pickup-deliver-deliver, the geographic detour cost can dwarf the savings of "no second pickup detour later." The missing variant is therefore a missing geographic optimization, not a capacity optimization.

## Expected behavior

`genPairs` for fresh-fresh pairs MUST enumerate the interleaved orderings in addition to the existing `:AB` / `:BA` patterns. Specifically, the four variants below should all be present:

| Variant | Stops |
|---------|-------|
| `:AB` (current) | `[pickA, pickB, delA, delB]` |
| `:BA` (current) | `[pickA, pickB, delB, delA]` |
| `:A-then-B` (new) | `[pickA, delA, pickB, delB]` |
| `:B-then-A` (new) | `[pickB, delB, pickA, delA]` |

The `:A-then-B` and `:B-then-A` variants represent the "drop A before grabbing B" and "drop B before grabbing A" backhaul shapes. They're the same geometric class as the existing `:cA-pB` / `:cB-pA` carry variants, just initiated by an upstream pickup instead of a pre-existing carry.

Optional: also add the three-step shapes that pickup A and B sequentially with one delivery in between (`[pickA, delA, pickB, delB]` already covers this) and the truly interleaved `[pickA, pickB, delA, delB]` (already covered by `:AB`). The two new variants above are the strict additions.

## Acceptance

A regression scenario reproducing the T78 hand:

- Bot at central Europe (Berlin/Wien/Ruhr connected).
- Two fresh demands: Copper Wroclaw→Madrid (46M), Oranges Valencia→Manchester (40M).
- `genPairs` MUST emit at least one variant with `stops = [pickup Copper @ Wroclaw, deliver Copper @ Madrid, pickup Oranges @ Valencia, deliver Oranges @ Manchester]`.
- Sanity check: the same `genPairs` call MUST still emit the existing `:AB` and `:BA` variants for backward compatibility.

A scoring smoke check:

- Score the new `:A-then-B` variant for the Copper+Oranges pair under late-phase OCPT=7. Score MUST be higher (less negative) than the corresponding `:AB` variant. The exact margin will depend on simulator output; the test asserts strict ordering, not a specific score.

## Out of scope

- Triples. The same logic likely applies (interleaved triple orderings for fresh-fresh-fresh pairs), but I have not enumerated a triple in the log evidence. Address in a follow-up if a triple-specific scenario surfaces.
- Heuristics for which variants to enumerate when. Just emit all four — the prune and scoring stages already discriminate. The extra two variants per fresh-fresh pair add a small constant to candidate count.
- Geographic ordering optimization (e.g., pre-sort variants by Chebyshev hop sum to score the cheapest first). The current code scores all survivors anyway.

## Evidence

- `src/server/services/ai/DeterministicTripPlanner.ts:377-380` — current fresh-fresh enumeration showing `:AB` and `:BA` only.
- `src/server/services/ai/DeterministicTripPlanner.ts:369-376` — carry-case branches showing the interleaved variants that already exist.
- `logs/game-3612bf42-68ef-47d4-8bac-cb86d5dd453b.ndjson` — T78 entry showing the demand cards available to Sonnet and the chosen single (`Wood Sarajevo→Budapest`, NET 8M, 9 turns) at the moment when Copper+Oranges was on the table.

## Note on relationship to JIRA-227

JIRA-227 fixes the spatial-prune cliffs that kill pair candidates by length, regardless of ordering. JIRA-228 adds a missing variant that would score better even under the current prune. Both can ship independently:

- JIRA-227 alone: more pairs survive, but the surviving fresh-fresh pairs still use only `:AB` / `:BA`. Some pairs that WOULD have been competitive in their `:A-then-B` form remain uncompetitive.
- JIRA-228 alone: the new variants are emitted, but for routes where the prune's geometric estimate hits the cap, they're still rejected.
- Both together: pair candidates survive the prune AND have the right ordering to win on score.
