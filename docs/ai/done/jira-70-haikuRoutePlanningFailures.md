# JIRA-70: Haiku Route Planning Failures — Parse Errors + Demand Hallucination

## Observed in Game
`668c1ab3-633c-44d4-95c1-7abde035a977` — Haiku bot (`e2e65ac9...6db22d83`)

## Problem

From turn 13 onward, **every LLM route planning call fails all 3 retry attempts**, forcing heuristic fallback every turn. Two distinct failure modes:

### Bug A: Markdown-fenced JSON despite structured output mode (~50% of attempts)

Haiku returns responses wrapped in ` ```json ``` ` markdown code blocks:
```
```json
{
  "route": [
    { "action": "PICKUP", "load": "Chocolate", "city": "Zurich" },
    ...
```

Since the bot uses structured outputs (JSON schema mode via `output_config`), the response should be **pure JSON**. The parser rejects the markdown wrapper as unparseable.

This happens on attempts at turns 7, 13, 14, 15, 16, 17, 18, 19, 20, 21 — roughly every other attempt.

**Possible cause**: Haiku may not be using structured outputs at all, or the `output_config` isn't being passed correctly for the route planning call. Need to verify AnthropicAdapter sends `output_config` with `ROUTE_SCHEMA` on the planRoute path.

### Bug B: Haiku hallucinates demands and supply cities (~50% of attempts)

When parsing succeeds, the route is rejected by validation because:

1. **Hallucinated demand cards**: Turns 13-16, Haiku repeatedly plans "Chocolate → Wien" and "Chocolate → Stuttgart" but **does not hold a demand card for Chocolate delivery**. The route validator rejects: "Deliver for Chocolate was infeasible — pickup without viable delivery."

2. **Invented supply cities**: Turns 18-20, Haiku plans "Cars from Munchen" and "Cars from Wien" — but **Cars is not a valid load at those cities** (and may not be a valid EuroRails load at all). Validator rejects: "Munchen is not a known supply city for Cars."

3. **Ignores cash constraint**: Turns 17-21, Haiku plans routes to Bruxelles costing ~11M track when bot has **0-1M cash**. Validator rejects: "Cumulative budget exceeded."

**Possible cause**: The context prompt may not clearly enumerate which demand cards the bot holds vs. general demand information. Haiku may be confusing "demands available in the game" with "demands in my hand."

## Impact

- Bot falls back to heuristic every turn from T13-T21 (9 consecutive turns)
- Heuristic fallback produces suboptimal BuildTrack/MoveTrain/DropLoad instead of strategic route following
- ~30 wasted LLM API calls (3 retries x 10 turns), each costing 2-8 seconds latency

## Acceptance Criteria

1. Verify structured output mode is active for Haiku route planning calls — if not, fix AnthropicAdapter to pass `output_config` with ROUTE_SCHEMA
2. If structured outputs ARE active but Haiku still returns markdown fences, add a fallback strip of ` ```json ``` ` wrappers in the response parser before JSON.parse
3. Review context prompt to ensure demand cards in hand are clearly distinguished from general game information
4. Add the bot's current cash to the route planning prompt if not already present, so the LLM can self-filter unaffordable routes
