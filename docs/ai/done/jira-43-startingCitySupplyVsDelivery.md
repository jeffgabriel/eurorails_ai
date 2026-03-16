# JIRA-43: Gemini Flash Chooses Delivery City as Starting City Instead of Supply City

**Severity:** Medium
**Source:** Game `aaf1bb82` analysis — Flash (gemini-3-flash-preview)

## Problem

The Gemini Flash LLM chose Berlin (delivery city) as its starting city instead of Holland (supply city) for the Cheese Holland→Berlin demand. Starting at the supply end saves a full turn of movement and enables immediate pickup.

## Evidence — Game `aaf1bb82`, Flash T2

Opening demands:
1. Cheese Holland→Berlin (10M) — ranked #1
2. Hops Cardiff→Munchen (29M)
3. China Birmingham→Toulouse (26M)

LLM reasoning: "Cheese from Holland to Berlin is the most efficient core route available, connecting two major cities while establishing a presence in the central European network."

Flash started at Berlin, built toward Holland (T2-T3, 37M on track), moved to Holland (T4-T5), picked up Cheese, then delivered back to Berlin at T6. If Flash had started at Holland, it could have picked up Cheese immediately and delivered while building — saving at least 1 turn.

Starting at the supply city is almost always better for first-delivery routes since the bot can pick up immediately and deliver en route. Holland also positions Flash closer to Cardiff (Hops) and Birmingham (China) for its other two demands.

## Scope

This may be a prompt/strategy issue — the LLM's route planning system prompt may not emphasize starting at the supply city. Could also be Gemini-specific if Anthropic models already handle this correctly (Haiku started at Milano which was between its supply and delivery cities).

## Files

- `src/server/services/ai/ContextBuilder.ts` (starting city guidance in system prompt)
- `src/server/services/ai/providers/GoogleAdapter.ts` (Gemini-specific prompting)
