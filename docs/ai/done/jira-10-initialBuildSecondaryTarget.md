# JIRA-10: LLM Should Always Plan Primary + Secondary Build Targets

## Problem

The LLM plans a route with specific stops, but once those stops are connected to the network, all subsequent build decisions fall to a cost-greedy heuristic (`findDemandBuildTarget`). The heuristic picks the cheapest unconnected demand city regardless of payout, strategic value, or proximity to existing track. This wastes budget on speculative builds the LLM would never choose.

This affects every phase of the game — initial builds, mid-route Phase B builds, and between-route builds.

## Change

The LLM route plan should always include a **secondary build target** alongside the primary delivery route. The route planning prompt already asks for pickup/deliver stops — extend it to also ask: "After your route stops are connected, where should the bot build next?"

### What the LLM needs to make this decision

The LLM currently gets demand card details, track network summary, and victory progress. It does NOT get geographic proximity data. Add to `serializeRoutePlanningPrompt`:

1. **Nearby cities per route stop** — For each stop on the planned route, list cities within ~5 mileposts and the estimated build cost to reach them. This tells the LLM "Berlin is 8M from Szczecin" or "Ruhr is 4M from Holland."

2. **Unconnected demand cities with build costs** — For each demand whose supply or delivery city is off-network, show the estimated cost to connect it. The LLM can then weigh payout vs. build cost.

3. **Resource proximity** — Flag when a city that produces a demanded load is near existing track (e.g., "Coal is available at Essen, 3M from your network"). This lets the LLM identify cheap pickup opportunities that the heuristic misses.

### Route plan output format

Extend the LLM response format to include a `secondaryBuildTarget` field:

```json
{
  "startingCity": "Ruhr",
  "stops": [...],
  "secondaryBuildTarget": {
    "city": "Holland",
    "reasoning": "Cheap to connect (4M), enables future Imports pickups"
  }
}
```

### Consuming the secondary target

- `PlanExecutor` and `TurnComposer.tryAppendBuild` should use `activeRoute.secondaryBuildTarget` instead of `findDemandBuildTarget` when the primary route stops are all on-network.
- If the secondary target is also on-network (already connected during play), fall back to the existing heuristic.
- `findDemandBuildTarget` remains as a last-resort fallback.

## Files to Change

| File | Change |
|------|--------|
| `ContextBuilder.ts` | Add nearby-city and resource-proximity data to `serializeRoutePlanningPrompt` |
| `systemPrompts.ts` | Update route planning prompt to request secondary build target |
| `LLMStrategyBrain.ts` | Parse `secondaryBuildTarget` from LLM response |
| `GameTypes.ts` | Add `secondaryBuildTarget` to `StrategicRoute` type |
| `TurnComposer.ts` | Use `activeRoute.secondaryBuildTarget` in `tryAppendBuild` |
| `PlanExecutor.ts` | Use secondary target during initial build turn 2 |
| `RouteValidator.ts` | Validate secondary target exists and is a real city |
