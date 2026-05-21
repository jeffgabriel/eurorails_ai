# JIRA-54: Bot Never Discards Hand Even When All Demands Are Unaffordable

**Severity:** High
**Source:** Game `2d3d214b` analysis — Flash (gemini-3-flash-preview) T11-T20

## Problem

When every demand in the bot's hand requires more track investment than the bot can afford, the bot continues chasing those demands instead of discarding and drawing new cards. Neither the LLM nor the heuristic fallback ever triggers a discard, even after multiple turns of zero progress with an unplayable hand.

## Evidence — Game `2d3d214b`, Flash T11-T20

Flash held these 3 demands from T11 onward with 1M (later 0M) cash:
- Coal→Göteborg: needs 33M of track
- Wheat→Stockholm: needs 47M of track
- Sheep→Bilbao: needs 14M of track (supply side)

Hand quality was rated "Poor" (scores -0.95 to 0.42) for 10 consecutive turns. Flash had an extensive existing network (Holland-Stuttgart-Leipzig-Wrocław-Frankfurt) with multiple supply cities already connected. A discard could have drawn demands deliverable on that network for free — generating immediate income to break out of the cash spiral.

Instead, Flash spent 7 turns traveling to Lyon to pick up Wheat it could never deliver, then dropped it on T20 with 0M cash. The game was effectively over by T13.

## Expected Behavior

The heuristic fallback should discard the hand when ALL of the following are true:
1. **Not initial build phase** — discarding during build turns is never correct
2. **Bot has no achievable delivery on existing network** — no demand can be fulfilled by moving on already-built track (no reachable supply+delivery pair)
3. **Bot cannot achieve a delivery using new track built from cash reserve** — the cheapest demand's required track cost exceeds the bot's available cash

If all three conditions hold, the hand is dead — passing just delays the inevitable. Discarding gives a chance at demands that match the existing network.

Note: JIRA-44 removed the old discard trigger from heuristicFallback because it was too aggressive (fired before trying build/drop/pass, used loose "estimated track cost > budget" check that ignored on-network routes). This fix should add the discard back as step 5 (after deliver/pickup/move/build/drop fail, before pass) with the tighter conditions above.

## Related

- JIRA-44: Heuristic fallback defaulted to DiscardHand too aggressively — now defaults to PassTurn. This ticket adds discard back with correct conditions.
- JIRA-51: Demand scoring gives positive scores to unaffordable demands — masks the signal that a discard is needed

## Files

- `src/server/services/ai/ActionResolver.ts` (heuristic fallback — add discard as step 5 with the three conditions above)
- `src/server/services/ai/ContextBuilder.ts` (may need to surface "achievable on network" flag per demand)
- `src/server/services/ai/LLMStrategyBrain.ts` (route planning — should consider discard as an option)
