# JIRA-117: Post-delivery re-composition skips same-city double pickup

## Summary

When the post-delivery re-composition (JIRA-90) processes a new route with two consecutive pickups at the same city, it only picks up one load before moving away. The bot then has to backtrack on the next turn to pick up the second load, wasting 2 movement points.

## Observed in

Game `00df7daa`, Flash bot, turns 13-14.

## Reproduction

1. Flash arrives at Kaliningrad on T13, delivers China (completing old route).
2. Post-delivery `planRoute` returns new route: `pickup(Iron@Kaliningrad) × 2 → deliver(Iron@Praha) → deliver(Iron@Antwerpen)`.
3. Re-composition (JIRA-90) processes the new route with reclaimed movement. The A2 loop picks up **1 Iron** at Kaliningrad, then generates a `MoveTrain` toward Praha and terminates (`terminationReason: "re-eval → last step is MOVE"`).
4. Flash moves south to `(20,63)` with only 1 Iron loaded.
5. On T14, Flash backtracks: `(20,63) → (19,63)` to pick up 2nd Iron, then `(19,63) → (20,63) → south...`. **2 movement points wasted** on the round-trip.

## Root cause

The TurnComposer A2 loop advances the route stop index and checks the next stop. When stop 0 is `pickup(Iron@Kaliningrad)` and stop 1 is also `pickup(Iron@Kaliningrad)`, the A2 loop should batch both pickups before generating a MoveTrain. Instead it appears to generate `[PickupLoad, MoveTrain]` and terminate because the last step is MOVE, missing the second pickup at the same city.

## Expected behavior

When consecutive route stops are pickups at the same city and the bot is already at that city with available cargo capacity, the A2 loop should process all same-city pickups before generating movement away.

## Impact

- 2 wasted movement points per occurrence (backtrack + return)
- Adds an extra turn of travel to multi-pickup routes
- Particularly affects Iron/commodity-heavy routes from remote cities like Kaliningrad where backtracking is costly

## Related

- JIRA-90: Post-delivery movement reclamation
- JIRA-83: Turn composition movement waste
- JIRA-38: Same-city multi-pickup
