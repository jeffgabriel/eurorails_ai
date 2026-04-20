# JIRA-186: `upgradeOnRoute` recommendation never consumed on active-route branch

## Summary

All three bots in game `3ef9c600-1a15-434f-871a-9cde30a17efa` (Haiku, Flash, Nano) ran as the starter Freight train for all 129 turns despite the LLM explicitly and repeatedly recommending upgrades on `upgradeOnRoute`. The recommendations are parsed and persisted onto the route, but the code path that consumes them never runs once a route is active — so every upgrade recommendation is silently discarded.

## Evidence

From `logs/llm-3ef9c600-…​ndjson` — `upgradeOnRoute` responses were emitted by the LLM on:

- **Flash** (TripPlanner): T8, T13, T20, T24, T29, T32, T43, T52, T55, T60, T65, T75, T81, T85, T104 — all recommending `FastFreight`.
- **Flash** (strategy-brain): T16, T47, T92, T97 — T97 explicitly asked for `Superfreight`.
- **Haiku** (TripPlanner): T32, T47 — both recommending `FastFreight`.
- **Nano** (TripPlanner): T6, T11, T16, T36, T44, T51×2, T55, T66, T72, T84, T91, T102, T108, T112, T127 — all recommending `FastFreight`.

Despite 30+ explicit recommendations, `bot.trainType` remained `Freight` for all three bots from T1 to T129. Nano ran at 96.9% movement utilization — the most movement-constrained bot in the game — and still never upgraded.

## Where the field is defined and produced

- `src/server/services/ai/schemas.ts` defines `upgradeOnRoute` in both `ROUTE_SCHEMA` and `TRIP_PLAN_SCHEMA` as an optional string enum (`FastFreight | HeavyFreight | Superfreight`).
- `src/server/services/ai/TripPlanner.ts` stores `parsed.upgradeOnRoute` onto the returned `StrategicRoute` as `route.upgradeOnRoute`.
- `LLMStrategyBrain.planRoute()` maps the field onto the `StrategicRoute` for the strategy-brain path.

So the LLM's recommendation is preserved on the active route and persisted in `memory.activeRoute` across turns.

## Where it is consumed — and the gap

`src/server/services/ai/AIStrategyEngine.takeTurn()` has three branches for deciding the turn's action:

1. `else if (activeRoute)` — auto-execute the existing route via `TurnExecutorPlanner.execute()`.
2. `else if (AIStrategyEngine.hasLLMApiKey(botConfig))` — no active route, consult `TripPlanner` for a new trip.
3. `else` — fallback / no LLM.

The upgrade consumption call lives only inside branch (2), around line 462:

```ts
// ── JIRA-105: Consume upgradeOnRoute from LLM route plan ──
if (activeRoute.upgradeOnRoute) {
  const { action: upgradeAction, reason: upgradeReason } =
    AIStrategyEngine.tryConsumeUpgrade(activeRoute, snapshot, tag, memory.deliveryCount ?? 0);
  ...
}
```

When `memory.activeRoute` is non-null (the common case once a route has been planned), `takeTurn()` takes branch (1) and **never checks** `activeRoute.upgradeOnRoute`. The field sits on the route object, preserved but unread, for every turn the route is executed.

`tryConsumeUpgrade()` itself is well-designed — it gates on `deliveryCount >= 4`, validates the upgrade path, and checks cash. When it does fire it produces a correct `TurnPlanUpgradeTrain` action that the existing `pendingUpgradeAction` injection (line 718) appends to the MultiAction plan. The machinery works. It just never runs.

## Why this matters

- Fast Freight adds +3 mileposts/turn. At 96.9% movement utilization (Nano), that is roughly 33% more travel reach per turn. Across 100 active turns that's ~300 additional virtual mileposts — the equivalent of ~5–6 extra deliveries at Nano's observed cadence.
- For Flash (85.8% utilization), an earlier upgrade would likely have yielded ~3–4 additional deliveries at ~22M average = 68–91M additional income.
- The 20M upgrade cost pays for itself inside 1–2 deliveries for movement-constrained bots.
- Without the upgrade firing, bots that the LLM correctly identifies as movement-starved stay starved for the entire game.

## Proposed fix (for the implementation ticket, NOT this ticket)

The smallest change is to mirror the `tryConsumeUpgrade` call into the active-route branch:

```ts
} else if (activeRoute) {
  // NEW: consume LLM's upgrade recommendation before executing the route
  if (activeRoute.upgradeOnRoute && !pendingUpgradeAction) {
    const { action: upgradeAction, reason: upgradeReason } =
      AIStrategyEngine.tryConsumeUpgrade(
        activeRoute, snapshot, tag, memory.deliveryCount ?? 0,
      );
    if (upgradeAction) pendingUpgradeAction = upgradeAction;
    else if (upgradeReason) upgradeSuppressionReason = upgradeReason;
  }

  const execResult = await TurnExecutorPlanner.execute(...);
  ...
}
```

`pendingUpgradeAction` is already injected into the final plan at line 718, so no downstream plumbing is required.

**Second consideration**: `tryConsumeUpgrade()` clears `route.upgradeOnRoute = undefined` on first call ("one-time consumption"). If the delivery-count gate blocks the upgrade on the first turn it fires, the recommendation is lost for the rest of the route. The fix should only clear the field when the upgrade is actually injected into `pendingUpgradeAction`, not when the gate rejects it.

## Out of scope for this ticket

- This ticket is documentation only. The implementation happens in a separate JIRA ticket.
- The change affects only `AIStrategyEngine.ts`. No schema changes, no validator changes, no new prompts.
- Not addressed here: the upstream question of why the LLM-initiated strategy-brain calls at T16/T47/T92/T97 returned `upgradeOnRoute` as a sub-call but weren't plumbed back into the main decision flow — that's a separate path worth reviewing if the simple fix above is insufficient.

## Success measure

- In a replayed game seed where any bot has been observed recommending `upgradeOnRoute` for 5+ consecutive turns, the bot upgrades on the first turn all gates (`deliveryCount ≥ 4`, cash ≥ cost, valid upgrade path) pass.
- No regression on cash management: the upgrade only fires when `tryConsumeUpgrade` returns an action, same rules as today.
- No bot ends a 100+ turn game still on the starter Freight when its own LLM has asked for an upgrade 10+ times.
