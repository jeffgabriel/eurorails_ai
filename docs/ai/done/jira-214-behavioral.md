# JIRA-214 — Post-pickup double-delivery advisor: bot can't see what's worth grabbing while at a pickup city

## Game evidence

- Game: `d87a7577-cf49-4765-bb32-a2b5a00e1477`, turn 20 (Haiku)
- Log: `logs/game-d87a7577-cf49-4765-bb32-a2b5a00e1477.ndjson`
- Existing advisor call: `route-enrichment-advisor`, claude-haiku-4-5, 3.5s, 1,749 in / 254 out tokens

The route was `PICKUP Steel @ Ruhr → DELIVER Steel @ Krakow (20M)`. The route-enrichment LLM was shown 6 of the bot's 9 possible demands — the prompt builder hardcodes `demands.slice(0, 6)` at `RouteEnrichmentAdvisor.ts:250` (the bot holds 3 demand cards, each with up to 3 demands, capped at 6 in the prompt) — plus a corridor ASCII map, and asked whether to enrich the route. The LLM's response:

```json
{
  "decision": "insert",
  "insertions": [{
    "afterStopIndex": 0,
    "action": "PICKUP",
    "loadType": "China",
    "city": "Leipzig",
    "reasoning": "Leipzig is directly on the bot track between Ruhr and Krakow..."
  }],
  "reasoning": "...Adding this stop requires only a slight deviation and captures significant value."
}
```

The LLM's reasoning is plausible-but-wrong on two counts: (a) Leipzig is the supply for China, but China's deliver city is **Oslo** — nowhere near the Ruhr→Krakow corridor; (b) inserting a PICKUP without a matching DELIVER creates an orphan load with no drive-by delivery. The bot ignored the suggestion (the validator's downstream rules pruned it). Net effect of the LLM call: 3.5s, ~2,000 tokens spent, zero behavior change.

This isn't an isolated mishap. It's the structural pattern of every `route-enrichment-advisor` call:

- The advisor is given up to 6 of the bot's 9 possible demands and asked an open-ended "should we enrich?" question.
- It has no concrete data on detour cost (track ECU) or detour time (extra turns).
- It hallucinates plausible-but-wrong answers.
- The downstream validator silently strips the bad outputs, so the cycle is invisible from gameplay metrics — the only signal is wasted LLM spend and the bot's failure to capture *real* drive-by opportunities.

## Current behavior

The route-enrichment advisor fires at two points:

1. After `NewRoutePlanner` builds a fresh route (`src/server/services/ai/NewRoutePlanner.ts:241`).
2. After each `PostDeliveryReplanner` invocation (`src/server/services/ai/AdvisorCoordinator.ts:63` from `PostDeliveryReplanner.ts:153`).

Both fire **before the bot has moved**, with up-to-6-demand context and no detour data. The LLM either says "keep" (most often) or proposes insertions that are wrong in ways the LLM can't detect from the inputs given. Gameplay outcome: real drive-by opportunities are missed, and the LLM's bad insertions get silently stripped.

## Desired behavior

When the bot arrives at a city and completes all of its planned actions there (pickups, deliveries, drops), but **before it moves on to a different city**, a focused advisor checks: *"are there other loads here that match an unfulfilled demand card, and is the deliver leg cheap enough to add to the trip?"*

The advisor:

- Sees only loads available at the bot's current city, intersected with demand cards the bot holds. No corridor evaluation. No hallucination surface.
- Receives **per-candidate marginal track cost (ECU M) and marginal extra turns**, computed by simulating the bot's actual trip with and without the candidate inserted at each viable slot. Both numbers reflect the truth — same `computeBuildSegments` Dijkstra primitive the bot already uses for its A3 build-origin preview when reaching off-network targets (`MovementPhasePlanner.ts:362-419`).
- Filters out candidates whose detour exceeds 3 extra turns or whose marginal build cost exceeds the bot's cash before sending the prompt.
- Returns `keep`, `insert` (splice PICKUP at current city + DELIVER at LLM-named slot), or `reorder`.

Player-visible result: when the bot is at a supply city with capacity headroom and a demand card matching another available load, the bot grabs the second load on its way through. Income velocity goes up. The LLM is asked an answerable question with grounded data, so its answers are useful instead of decorative.

The two old advisor fires are removed — they're the source of the bad-call pattern visible in logs, and the new pickup-time fire covers the same opportunities at the moment the bot has the most accurate information.

## Player-visible impact

The most recent game (`b1dc793c-0b91-43d8-b150-d87ceb7057c3`, Haiku 97 turns / Flash 96 / Nano 96) has Flash beating Haiku and Nano on average ECU per turn by roughly 2×. From `scripts/ai/game-analysis.ts` Section 9 (Head-to-Head Comparison) on this log: Flash 5.6 M/turn (20 deliveries / 535M / 96 turns), Nano 2.6 M/turn (15 / 246M / 96), Haiku 2.5 M/turn (13 / 239M / 97). A meaningful fraction of Flash's edge comes from picking up multiple loads per trip; Haiku and Nano frequently make single-load trips where a second drive-by load was on the table. Closing that gap is one of the larger income-velocity levers available without changing the trip planner itself.

The bot also stops paying for ~3.5s LLM calls per route creation that produce zero gameplay impact. Two fewer calls per route × N routes per game × M games is a meaningful API spend reduction for a hobby project.

## Out of scope

- BuildAdvisor and TripPlanner consumption of the new detour primitive (separate JIRAs).
- Kaliningrad-loop unreachability fix from `BuildRouteResolver.selectCandidate` (separate JIRA, also a consumer of the new simulator).
- Drop-existing-load and upgrade-train decisions when the train is full (deliberately omitted — capacity-full means no candidates pass filter, no LLM call).
- Reorder of existing stops (schema includes it but expected to be rare in this trigger context).
