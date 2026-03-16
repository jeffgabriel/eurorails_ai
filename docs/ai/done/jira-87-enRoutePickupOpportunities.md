# JIRA-87: Bot Ignores Profitable En-Route Pickup Opportunities

## Observed Behavior

In game `15d203e2` (~turn 14), the Haiku bot is traveling from Zagreb (labor pickup) to Århus (demand city). Budapest — which has bauxite matching a demand card for København at 30M ECU — is only 2-3 mileposts off the existing route. The bot passes right by without picking it up.

A human player would immediately recognize this as an easy 30M detour. The bot doesn't even consider it.

## Expected Behavior

When a bot is traveling an active route, it should notice profitable pickup opportunities at cities near its path — especially high-value ones requiring minimal detour. It should be able to decide "I'll swing through Budapest, grab the bauxite, and continue to Århus" the same way a human would.

## Root Cause (5 factors)

1. **ContextBuilder blind spot**: `computeCanPickup()` (ContextBuilder.ts:1393-1441) only reports loads at the bot's CURRENT milepost. The LLM literally cannot see loads at nearby cities — they aren't in the context.

2. **A1 scanner too strict**: TurnComposer's A1 opportunistic pickup scanner (TurnComposer.ts:597-617) has a feasibility pre-filter that only considers cities reachable within the current turn's remaining movement. A city 2 mileposts off-route that requires a slight detour gets filtered out.

3. **No detour cost awareness**: Even if a load were surfaced, there's no data telling the LLM "this is 2 extra mileposts" vs "this is 15 extra mileposts." Without detour cost, the LLM can't make a cost/benefit decision.

4. **ActionResolver demand-card gate**: ActionResolver.resolvePickup() (ActionResolver.ts:461-468) correctly requires demand card matching. This isn't a bug — but it means any fix must pre-filter to demand-matched loads only.

5. **Haiku conservative config**: Haiku bots run with effort='low', 2048 token budget, temperature 0.7. Any en-route data must be extremely compact to fit.

## Relationship to JIRA-86

JIRA-86 restructures LLM calls into a human-like decision model. This defect maps to **two specific call types** in that architecture:

### Call A: `planRoute()` with en-route context
When `planRoute()` fires (any urgency level), the context should include en-route pickup opportunities along the planned route. This lets the LLM factor in profitable detours when initially planning — e.g., "route through Budapest to grab bauxite on the way to Århus."

### Call C: `evaluateOpportunity()` — primary fix location
This is the natural home for this fix. Call C fires when:
- A delivery just happened and a new demand card was drawn
- Bot has unused cargo capacity
- Bot has an active route

The `evaluateOpportunity()` prompt already asks "is there a profitable pickup along your route?" — but it can only answer well if the context includes what's actually available nearby. **This defect is essentially "Call C doesn't have the data it needs."**

### What this means for implementation
- The **context enrichment** (scanning nearby cities, computing detour costs) belongs in `ContextBuilder` and feeds into both Call A and Call C
- The **decision logic** belongs in Call C's prompt and output schema — JIRA-86 already defines the `evaluateOpportunity()` interface
- This defect should NOT add a new LLM call or new decision path — it provides data to the calls JIRA-86 is creating

## Fix: Enrich ContextBuilder with En-Route Pickups

### New context field: `enRoutePickups`

Scan cities within 3 mileposts of the bot's planned route. For each city, check if any available load matches a demand card. Compute the detour cost in mileposts. Surface top 3-5 results sorted by net value (payoff minus detour cost).

**Example context output (compact for token budget):**
```
En-route pickups (near your route):
- Budapest: Bauxite → København 30M (2 mp detour)
- Wien: Steel → Berlin 18M (1 mp detour)
```

### Data shape
```typescript
interface EnRoutePickup {
  city: string;           // Pickup city
  load: string;           // Load type
  demandCity: string;     // Demand card destination
  payoff: number;         // ECU millions
  detourMileposts: number; // Extra mileposts to reach city from route
  onRoute: boolean;       // true if directly on route (0 detour)
}
```

### Where this feeds in the JIRA-86 call flow
```
ContextBuilder.buildContext()
  └─ computeEnRoutePickups()  ← NEW (this defect)
      │
      ├─→ Call A: planRoute() context — bot sees nearby opportunities when planning
      └─→ Call C: evaluateOpportunity() context — bot has data to evaluate detours
```

## Constraints

- **3 milepost scan radius** — covers observed cases like Budapest, avoids noise from distant cities
- **Demand card pre-filter** — only surface loads matching a demand card (ActionResolver will reject others anyway)
- **Top 5 cap** — limit results to control token usage
- **Compact format** — one line per opportunity, abbreviate milepost as "mp"
- **Graceful degradation** — if route is empty or computation fails, return empty array, don't block the turn

## Files Affected

- `src/server/services/ai/ContextBuilder.ts` — new `computeEnRoutePickups()` method, wire into `buildContext()`
- `src/server/services/ai/TurnComposer.ts` — relax A1 scanner feasibility gate for cities reachable within current movement + 1 turn

## Dependency

- **Depends on JIRA-86** — the en-route data feeds Call A and Call C from the new call architecture. Implementing this before JIRA-86 would mean enriching context that the current single-call architecture can't act on effectively.
- **Alternatively**: the ContextBuilder enrichment can land independently (it just adds data to the context), but the full value isn't realized until Call C exists.

## Acceptance Criteria

- [ ] Bot context includes `enRoutePickups` listing demand-matched loads within 3 mileposts of active route
- [ ] Each entry includes city, load, demand destination, payoff, and detour cost in mileposts
- [ ] Budapest bauxite case from game `15d203e2` would appear in en-route pickups
- [ ] Empty route returns empty array without errors
- [ ] Context with en-route pickups fits within Haiku's 2048 token budget
- [ ] No loads without matching demand cards appear in results
