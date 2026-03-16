# JIRA-103: No Retry Loop When Post-Delivery Route Fails Validation

## Problem

After delivering at a city, the bot calls the LLM for a new route. When that route fails validation (e.g., unreachable supply city, unaffordable track cost), there is no retry loop to ask the LLM for a better plan. The bot becomes rudderless — it either builds blindly toward a bad route or wastes turns with no strategic direction.

### Example: Game c9736f59, T5 (player aa9b65d8 "flash")

After delivering Wine at Warszawa, LLM planned Marble@Firenze → Lodz. This route required $38M+ in Alpine track building — far beyond what the bot could afford in a single turn. There was no mechanism to:
1. Detect that the route was infeasible at real pathfinding costs
2. Retry the LLM with feedback ("Firenze route too expensive, suggest alternatives")
3. Fall back to a cheaper route or pass the turn

Instead, the bot blindly built toward Firenze, spending $38M and nearly going bankrupt.

## Root Cause

`AIStrategyEngine.ts` Stage 3d (lines 497-514): `brain.planRoute()` is called once. If the returned route passes RouteValidator's structural checks but is infeasible in practice (cost estimate wrong, terrain too expensive), there is no retry. The route is accepted and immediately executed.

## Expected Behavior

After the LLM returns a route, the system should:
1. Validate the route against actual pathfinding costs (not just demand scoring estimates)
2. If validation fails, retry the LLM with the rejection reason (up to N attempts)
3. If all attempts fail, fall back to a safe action (pass turn, or build toward existing route stops)

The bot should never be left without a validated plan after a delivery.

## Files to Investigate

- `AIStrategyEngine.ts:497-514` — post-delivery planRoute() call (single attempt, no retry)
- `RouteValidator.ts` — validation that could gate infeasible routes
- `LLMStrategyBrain.ts` — planRoute() method that could accept rejection feedback
