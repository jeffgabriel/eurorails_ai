# JIRA-96: Route Validator Accepts Infeasible Routes at $0M

## Problem

The route feasibility validator does not check whether the bot has enough cash to cover the track cost required to complete a route. At $0M, it accepted a route with trackCost=$5M, causing the bot to pick up a load it could never deliver.

### Example: Game 069de7f0, T13

Flash bot at $0M after discarding hand twice (T11-T12). LLM plans Coal Wroclaw→Frankfurt:
- `trackCostToDelivery: $5M` (Frankfurt is NOT on the network)
- `bot.money: $0M`
- Route validator **accepted** this route as feasible
- Bot moved to Wroclaw (T14-T15), picked up Coal, then got permanently stuck because it couldn't afford the $5M track to Frankfurt
- This directly caused the death spiral in JIRA-95

### Root Cause

The route feasibility check validates that a route is geometrically possible (supply → delivery path exists) and that cumulative track cost fits within the projected budget, but "projected budget" likely uses the $20M/turn build limit rather than actual available cash. At $0M with no income source, any route requiring track building is infeasible.

## Fix

Add a cash gate to route feasibility validation: if `trackCostToDelivery > bot.money` AND the bot has no income source (no active deliveries that would generate cash before reaching the build segment), reject the route as infeasible.

Simple version: if `bot.money < 1` and route requires any track building (`trackCostToDelivery > 0`), reject unless the route includes a delivery stop before the build-requiring segment that would generate enough cash.

## Files to Investigate

- Route feasibility validator (likely in `ResponseParser.ts` or `RouteValidator.ts`) — where LLM route responses are validated
- `ContextBuilder.ts` — where `trackCostToDelivery` is calculated, confirm it reflects actual cost
- `AIStrategyEngine.ts` — where validated routes are accepted and committed to execution
