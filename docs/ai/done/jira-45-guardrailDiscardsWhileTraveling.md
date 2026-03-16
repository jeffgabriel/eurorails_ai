# JIRA-45: Guardrail Stuck Detection Discards Hand While Bot Is Actively Traveling to Deliver

**Severity:** High
**Source:** Game `aaf1bb82` analysis — Haiku (claude-haiku-4-5) T12

## Problem

The GuardrailEnforcer's progress-based stuck detection counts movement-only turns as "no progress" and force-discards the hand after 3 consecutive turns without deliveries, cash increase, or new cities. This fires even when the bot is actively traveling toward a delivery destination with a load on the train.

## Evidence — Game `aaf1bb82`, Haiku T12

- Haiku picked up Cars at Torino (T10), was traveling to Beograd to deliver for 19M
- T9-T11 were movement-only turns (traveling, no deliveries yet)
- At T12, guardrail fired: "Progress-based stuck detection: 3 turns with no deliveries, cash increase, or new cities — forcing DiscardHand"
- Haiku was **carrying Cars, 1 estimated turn from delivery**, with hand quality score **9.45 (Good)**
- The guardrail destroyed a nearly-complete 19M delivery
- T13-T14: guardrail kept firing (4, 5 no-progress turns) because discarding doesn't count as progress either — death spiral

## Expected Behavior

The stuck detector should recognize "actively traveling toward a delivery with a carried load" as progress. Possible fixes:
- Count movement toward a route stop as progress (reset the noProgressTurns counter)
- Check if the bot is carrying a load whose delivery city is on the route before firing
- Increase the threshold when the bot has an active route with loads on train

## Note

JIRA-42 (guardrail overhaul) removed strategic guardrails but may have kept this stuck detection. If this game was played after JIRA-42, the stuck detection logic still needs the travel-awareness fix.

## Files

- `src/server/services/ai/GuardrailEnforcer.ts` (stuck detection at ~line 46-54)
- `src/server/services/ai/AIStrategyEngine.ts` (noProgressTurns tracking at ~lines 355-364)
