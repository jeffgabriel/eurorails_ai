# JIRA-52: Opportunistic Pickup Only Grabs One Load Even When Train Has Capacity for More

**Severity:** High
**Source:** Game `2d3d214b` analysis — Haiku (claude-haiku-4-5) T13

## Problem

When the bot passes through a city during movement, the opportunistic pickup scanner (a1) detects available loads that match demands in hand. However, it only picks up one load per city even when the train has empty slots and multiple matching demands exist.

## Evidence — Game `2d3d214b`, Haiku T13 (Valencia)

- Haiku arrived at Valencia and delivered Tourists, freeing both cargo slots (Freight = 2 capacity)
- Haiku had TWO Orange demands in hand:
  - Oranges Valencia→Münch (36M)
  - Oranges Valencia→Holland (33M)
- The a1 scanner found 2 opportunities (`a1.opportunitiesFound: 2`)
- But only 1 Oranges was picked up
- 7 of 9 mileposts were wasted on this turn
- Haiku then had to plan a separate multi-turn trip back to Valencia (T20) to pick up the second Orange — wasting approximately 6 turns

## Expected Behavior

When the bot passes through a city with multiple loads matching demands in hand, it should pick up as many as its train capacity allows. Two matching loads at one city with two empty slots should result in two pickups.

## Related

JIRA-38 fixed same-city multi-pickup in the route-planned path. This bug is in the opportunistic (a1 scanner) path, which was not covered by that fix.

## Files

- `src/server/services/ai/TurnComposer.ts` (a1 opportunistic scanner / scanPathOpportunities)
