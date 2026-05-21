# JIRA-125: Endgame Victory Build Priority — Bot Never Builds Toward Unconnected Major Cities

_Analysis of games `471cf7b5` (Flash, 5 cities, 299M, never builds toward victory) and `eb69a74e` (Haiku wins by luck, Flash stalls at 5 cities). Despite having the cash to win, bots fail to build track connections to the remaining major cities needed for victory._

## Summary

Two interrelated problems prevent the bot from closing out victories:

1. **TurnComposer gates victory builds behind route-based builds** — if the bot has ANY active route with unreached stops, it builds toward delivery destinations instead of unconnected major cities. This gate is never released because the bot always has a route.
2. **LLM context tells the bot what to do but the bot can't act on it** — the prompt includes "STRATEGIC PRIORITY: focus ALL building budget on connecting [Berlin, London, Milano]" but TurnComposer's build logic ignores the LLM's intent.

## The Evidence

### Game `471cf7b5` — Flash: 26 victory-eligible turns, 1 build toward a target

Flash reached 230M+ cash at turn 70 with 5 connected cities (Paris, Holland, Ruhr, Wien, Madrid). Needs 2 more from Berlin, London, or Milano. Over the next **26 turns**, Flash:

| Turns | Cash | Action | Build Target |
|-------|------|--------|-------------|
| 70-82 | 230M | Delivering to Lisboa, Wien, Holland | None (route builds) |
| 83-90 | 283M | Delivering to Ruhr, Wroclaw | None (route builds) |
| 91 | 280M | Building toward Sarajevo | None (route build to delivery city) |
| 92 | 310M | Building toward Hamburg | Hamburg (only victory-ish build — Hamburg isn't even a major city) |
| 93-98 | 299M | Delivering to Hamburg | None (route builds) |

The LLM knows it should win — turn 83 reasoning: *"I have exceeded the 250M ECU cash requirement for victory."* Turn 76: *"Delivering Cork immediately puts me over the 250M ECU victory threshold."* But it keeps executing delivery routes.

### Game `eb69a74e` — Haiku wins, but by coincidence

Haiku reached 7 cities + 265M and was actively building toward London at turn 122. But Haiku's victory wasn't strategic — it connected major cities **incidentally** through delivery routes that happened to pass through them. Haiku only triggered 2 intentional victory builds out of 22 eligible turns. It just got lucky that its delivery routes went through major cities.

Flash in the same game stalled at 5 cities with 211M. Built toward London once at turn 119 (the one time it had no route stops needing builds).

## Root Cause: TurnComposer.ts lines 748-846

The `tryAppendBuild()` method has three priority tiers:

```
1. Route-based builds (lines 748-828) — ALWAYS fires if activeRoute has unreached stops
2. routeNeedsBuild gate (line 834) — blocks tier 3 if tier 1 had targets
3. Victory builds (lines 838-846) — ONLY fires if no route needs building AND not mid-route
```

The bot **always** has a route (it's always delivering something), so tier 3 is unreachable:

```typescript
const routeNeedsBuild = unreachedRouteStops.length > 0;  // almost always true
const isMidRoute = activeRoute && (activeRoute.phase === 'travel' || activeRoute.phase === 'act');
if (!routeNeedsBuild && !isMidRoute) {  // ← never true in practice
  // Victory build code lives here — dead code in endgame
}
```

## Two-Part Fix

### Part 1: LLM Context — Bias Demand Scoring Toward Victory Cities

The LLM already receives victory context (connected cities, unconnected cities with costs, STRATEGIC PRIORITY text). But the demand ranking doesn't account for whether a delivery **routes through or near an unconnected major city**.

**Current demand context** (ContextBuilder.ts:859):
```
STRATEGIC PRIORITY: You have enough cash — focus ALL building budget on connecting [Berlin, London, Milano].
```

This tells the LLM to build, but the LLM picks routes — it doesn't directly control builds. We should:

- **Add a victory routing bonus to demand scoring** when `money >= 250` and `connectedCities < 7`. Demands whose supply or delivery city IS an unconnected major city (or whose route passes within ~3 mileposts of one) should get a significant score boost. This biases the LLM toward picking routes that organically build toward victory cities.
- **Surface which demands connect to which unconnected cities** explicitly in the context. Instead of just "VICTORY BONUS: route passes near Berlin (~12M to connect)", make it a first-class ranking signal: "This delivery takes you through Berlin — delivering here ALSO connects your 6th major city."
- **In Victory Imminent phase, only present demands that serve victory**. Filter or heavily prioritize demands whose routes pass through unconnected major cities. The bot shouldn't be chasing a 12M delivery to Wroclaw when it could be running a 10M delivery through Berlin and winning the game.

### Part 2: TurnComposer — Unconditional Victory Builds When Cash Threshold Met

The bot should build toward unconnected major cities **regardless of route state** when the endgame conditions are met. This is pure track-building — no delivery needed. The bot just extends its network toward the nearest unconnected major city.

**When to trigger** (all must be true):
- `money >= 250` (victory cash threshold met)
- `connectedMajorCities.length < 7`
- `remainingBuildBudget > 0`

**What to do:**
1. After route-based builds consume some budget (lines 748-828), check if there's remaining budget AND victory conditions are met
2. Spend any leftover budget building toward the cheapest unconnected major city
3. This happens **in addition to** route builds, not instead of — use whatever's left of the 20M/turn build cap
4. If the bot has 250M+ cash and < 7 cities, victory builds should also fire **instead of** route builds when the route target is not a major city. Don't waste 20M/turn building toward Wroclaw when Berlin is 12M away.

**Pseudocode:**
```typescript
// After route-based builds (line 828), before the current fallback:
const isVictoryReady = snapshot.bot.money >= 250 &&
  context.connectedMajorCities.length < 7;
const unconnected = context.unconnectedMajorCities ?? [];

if (isVictoryReady && unconnected.length > 0) {
  const updatedBudget = Math.min(20 - budgetSpent, snapshot.bot.money - totalSpent);
  if (updatedBudget > 0) {
    // Build toward cheapest unconnected major city with remaining budget
    const victoryTarget = unconnected[0].cityName;
    const result = await ActionResolver.resolve(
      { action: 'BUILD', details: { toward: victoryTarget }, ... },
      currentSnapshot, updatedContext,
    );
    if (result?.success) allSegments.push(...result.plan.segments);
  }
}
```

## Files to Modify

| File | Change |
|------|--------|
| `src/server/services/ai/TurnComposer.ts` | Add victory build tier between route builds and fallback. When money >= 250 and cities < 7, spend remaining build budget toward unconnected major cities regardless of route state. |
| `src/server/services/ai/ContextBuilder.ts` | In Victory Imminent / Late Game phases, boost demand scoring for demands that route through unconnected major cities. Surface explicit "this delivery connects city X" notes. |
| `src/server/services/ai/prompts/systemPrompts.ts` | Strengthen endgame directive: tell LLM to prefer demands near unconnected cities, and that victory builds happen automatically — focus route selection on cities that matter. |

## Acceptance Criteria

1. When `money >= 250` and `connectedCities < 7`, the bot spends remaining build budget toward unconnected major cities every turn — even when mid-route
2. Demand scoring in endgame biases toward routes through/near unconnected major cities
3. Bot does NOT need to deliver to a major city to build toward it — pure connector track
4. Victory builds use remaining budget after route builds (additive, not replacement) unless route target is a non-major city and victory is imminent
5. Game `471cf7b5` scenario: Flash with 299M and 5 cities should start building toward Berlin/Milano/London within 1-2 turns of hitting 250M, not 26+ turns later

## Test Cases

- Bot with 260M, 5 cities, active route to small city → should build toward nearest unconnected major city with leftover budget
- Bot with 260M, 6 cities, no route → should build toward last unconnected major city (current behavior, verify not broken)
- Bot with 200M, 5 cities → should NOT trigger victory builds (below threshold)
- Bot with 300M, 5 cities, 20M route build → no leftover budget, skip victory build (no budget waste)
- Bot with 300M, 5 cities, 8M route build → 12M remaining, build toward nearest major city with 12M
- Demand scoring: demand delivering to Berlin (unconnected) should rank higher than similar-payout demand to Wroclaw (non-major) when in endgame
