# JIRA-40: Demand Scoring Overvalues Expensive Cross-Map Routes

**Severity:** High
**Source:** Game `1c8c8f55` analysis (JIRA-37 Bug 3)

## Problem

`estimateTrackCost()` dramatically underestimates costs for long-distance routes, causing the demand scoring algorithm to rank expensive cross-map demands too highly. High-payout demands exist precisely because the routes are difficult — the scoring doesn't capture this.

## Evidence — Haiku T99-T110

Demand ranking at T99:

| Rank | Load | Route | Payout | Score | Est. Turns | Est. Track Cost |
|------|------|-------|--------|-------|------------|----------------|
| #1 | Marble | Firenze→Stockholm | 55M | 11.5 | 8 | ? |
| #2 | Oranges | Sevilla→Zurich | 31M | 8.8 | 8 | ? |
| #3 | Tobacco | Napoli→Ruhr | 31M | 7.9 | 6 | 18M |

The bot chose Tobacco (#3) and spent 12 consecutive turns (T99-T110) building track toward Napoli, bleeding $59M in track costs for a 31M payout route. The game ended before the bot reached Napoli.

But all three options were likely bad:

- **Marble Firenze→Stockholm (55M, #1):** Crosses most of Europe. Estimated 8 turns is almost certainly wrong — requires extensive track through Scandinavia. The 55M payout exists because this route is extremely difficult.
- **Oranges Sevilla→Zurich (31M, #2):** Sevilla is in southern Spain, far from any existing track. Building to Sevilla alone could cost $40M+.
- **Tobacco Napoli→Ruhr (31M, #3):** `estimateTrackCost` returned 18M but actual cost was $59M+.

The LLM actually made a reasonable choice picking the "cheapest" option. The scoring was wrong for all three.

At T99 with $144M, the bot should have been running short profitable routes on its existing network, not committing to a 12-turn build project.

## Root Cause

`estimateTrackCost()` uses `hexDistance * 1.5M` which underestimates for:

1. **Mountain/alpine terrain:** 2-5M per milepost vs the 1.5M average assumed
2. **$20M/turn build cap:** A 40M route takes minimum 2 build turns, but the scoring only sees the dollar cost, not the turn cost of building
3. **Overland path vs hex distance:** Hex distance cuts through obstacles; actual routes go around mountains, water, and terrain (see JIRA-34 for ferry-specific case)

## JIRA-42 Impact

JIRA-42 (guardrail overhaul) removes strategic guardrails G2/G4/G5 that previously compensated for bad demand selections by force-dropping loads or force-picking up alternatives. With those guardrails gone, the LLM's demand choice becomes the sole decision-maker. Inaccurate scoring that sends the bot on a 12-turn cross-map build has no safety net to catch it.

**This ticket becomes higher priority after JIRA-42.** Accurate `estimateTrackCost()` is critical when guardrails no longer override bad picks.

## Related

- JIRA-34: Ferry-aware track cost estimation (specific case of water crossings)
- JIRA-35 Bug 1: Demand scoring ignores cash reserves
- JIRA-42: Guardrail overhaul (elevates priority of this ticket)

## Files

- `src/server/services/ai/ContextBuilder.ts` (estimateTrackCost, demand scoring)
