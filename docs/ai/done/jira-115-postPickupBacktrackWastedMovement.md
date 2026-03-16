# JIRA-115: Post-Pickup A2 Continuation Backtracks When Next Stop Is Off-Network

## Symptom

Game `00df7daa`, Flash bot, turn 7. Flash moves from Ruhr to Frankfurt, picks up Beer, then backtracks to Ruhr with remaining movement (5 mileposts) — wasting an entire turn of forward progress. The next route stop (Leipzig) and delivery target (Szczecin) are both off-network, so `findMoveTargets` falls through to reachable fallback cities, routing the bot backwards.

A human would have continued east from Frankfurt toward Berlin, then built remaining track to connect toward Szczecin.

## Timeline

| Turn | Start | End | Action | Loads | Notes |
|------|-------|-----|--------|-------|-------|
| 7 | Ruhr | Ruhr | Move + Pickup + Build | Beer | Moved to Frankfurt (4mp), picked up Beer, backtracked to Ruhr (4mp), 1 wasted. Built 3M toward Leipzig |
| 8 | Ruhr | (28,48) | Move + Build | Beer | Moved east 9mp, built 5M toward Szczecin |

Flash wastes ~8 mileposts backtracking on T7. If it had continued east from Frankfurt instead, it would be ~8 mileposts closer to Szczecin — saving roughly a full turn.

## Root Cause

After the pickup at Frankfurt, the **A2 continuation loop** (TurnComposer.ts:258-381) calls `findMoveTargets()` (line 339) to find where to move with remaining budget:

1. **Priority 1** — Route stops: Leipzig (off-network → MOVE fails), Szczecin (off-network → fails)
2. **Priority 2** — Demand delivery cities on network: none relevant
3. **Priority 3** — Demand supply cities on network: none relevant
4. **Priority 4** — Reachable fallback cities: **Ruhr** (the only hub)

The bot moves back to Ruhr because it's the only reachable city. `findMoveTargets` has no concept of **"move toward the track frontier closest to my off-network target"** — it only considers named city destinations.

## Impact

- ~8 mileposts wasted backtracking (nearly a full Freight turn)
- Delays delivery by ~1 turn
- Compounds over many turns: every off-network pickup at a branch endpoint causes backtracking

## Proposed Fix

Add a new priority to `findMoveTargets` between route stops (P1) and demand cities (P2): **frontier approach targets**. When the primary route stop is off-network, find the on-network milepost/city that is geographically closest to that off-network target and move toward it.

```typescript
// Priority 1.5: Frontier approach — when next stop is off-network,
// move toward the edge of own track closest to that target
if (activeRoute) {
  for (let i = activeRoute.currentStopIndex; i < activeRoute.stops.length; i++) {
    const stop = activeRoute.stops[i];
    const city = stop.city;
    if (!context.citiesOnNetwork.includes(city)) {
      // Find the on-network city closest to this off-network target
      const frontier = findClosestNetworkCityToTarget(city, context);
      if (frontier) add(frontier);
      break;
    }
  }
}
```

Alternatively, when no forward-progress target exists, the A2 loop should **stay put** rather than backtracking. Moving backward is always worse than not moving, since it wastes mileposts that could have been used going forward next turn.

## Files

- `src/server/services/ai/TurnComposer.ts` — `findMoveTargets()` lines 782-841
- `src/server/services/ai/TurnComposer.ts` — A2 continuation loop lines 258-381
