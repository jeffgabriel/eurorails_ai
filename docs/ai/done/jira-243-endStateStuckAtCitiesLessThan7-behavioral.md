# JIRA-243 — End-state bot stops building cities once cash overshoots; game runs to turn limit with no winner (behavioral)

In game `8738866e-0f51-488a-bff1-a5fab6b80ff1`, all three bots reached End state, accumulated cash past the $250M victory threshold (s1=321, s2=336, s3=313), and then stopped building track entirely. The game ran to t116 (the turn limit) with no winner declared — all three bots ended `victory: too-few-cities`. s2 spent 41 unbroken turns of `MoveTrain` (t76–t116) with zero `BuildTrack` actions despite holding $286–336M cash and missing only one city for victory.

The defect is a JIRA-241 regression. JIRA-241 simultaneously (1) introduced End-state scoring (`applyEndStateScoring` at `DeterministicTripPlanner.ts:1024`) that caps `effectivePayoff` at `max(0, 250M − cash)`, and (2) suppressed the pre-existing victory-build override (`routeHelpers.ts:144-147`) in End state. Once cash crosses $250M the scoring cap is zero, every candidate scores negative, the planner picks the least-negative (always zero-build same-network), and there is no fallback path to force a build toward an unconnected major. The bot delivers on-network demands forever, earns more cash, never lays new track.

## Source

`logs/game-8738866e-0f51-488a-bff1-a5fab6b80ff1.ndjson` — all three bots, t75–t116. Discovered 2026-05-17.

## Observed trace (winner-most-likely s2)

End-state latch (cash > 200M for the first time): t63 (cash=219).

| Period | turns | BuildTrack | MoveTrain | City changes |
|--------|------:|-----------:|----------:|-------------:|
| t1–t55 (mid game) | 55 | 18 | 33 | 0 → 5 |
| t56–t75 (entering End) | 20 | 4 | 15 | 5 → 6 (Berlin added t75) |
| **t76–t116 (deep End, cash > 250)** | **41** | **0** | **37** | 6 → 6 (stuck) |

Cash trajectory across the stuck period: 286 → 286 → … → 286 → 324 → 336.

s2's hand throughout the stuck period contained demands whose delivery cities were unconnected majors (Manchester, Antwerpen, Bruxelles, Hamburg, Barcelona) — e.g., t76 top-ranked demand `Bauxite Budapest→Manchester payout=31`. The trip planner generated build-and-deliver candidates for these but consistently picked zero-build same-network candidates because End-state scoring at `cashGap=0` makes any `buildCost > cityCost penalty` lose to any zero-build alternative.

## gameState field never written to game log

`GameLogger.ts:42` declares the optional `gameState` field. 0 of 345 rows in this game's log have it. AC7 of JIRA-241 ("Each per-turn record in the game log includes the bot's gameState value, so post-game analysis can grep transitions") is not satisfied. The End transition is invisible in production logs.

## Fix

Re-enable the pre-JIRA-241 victory-build override whenever `cash ≥ $250M AND cities < 7`, regardless of `gameState`. The bot targets the cheapest unconnected major (via `findCheapestUnconnectedMajorCity` at `routeHelpers.ts:166`) and builds toward it each turn until 7 cities are connected. Same behavior as before JIRA-241 introduced the suppression.

Mechanically: drop the `context.gameState !== GameState.End` clause from the eligibility check at `routeHelpers.ts:144-147`. End-state scoring (`applyEndStateScoring`) is otherwise untouched — it continues to govern trip selection; only the build-target resolution changes.

Trade-off accepted: the bot may briefly drop below $250M cash during multi-turn builds and need to recover before victory declares. This is strictly better than 41 turns of zero builds.

## Expected behavior

When `cash ≥ $250M AND cities < 7`, on every turn:
1. `resolveBuildTarget` returns the cheapest unconnected major city as the build target.
2. `BuildPhasePlanner` lays track toward it within the turn's build budget.
3. After the build connects a major (cities increments), the next turn targets the next cheapest unconnected major.
4. Victory declares the first turn after which `cash ≥ $250M AND cities ≥ 7` both hold.

## Acceptance

- **AC1 — overshoot triggers victory-build:** Reconstruct s2's t76 snapshot (cash 286, 6 cities, `gameState=End`). Run `resolveBuildTarget`. Assert: returns `{targetCity: <cheapest unconnected major>, isVictoryBuild: true}`.
- **AC2 — bot connects 7th city and wins:** Replay the t76 snapshot through 15 turns. Assert: cities count reaches 7 AND the per-turn `victoryCheck` field in the log transitions to `'declared'`.
- **AC3 — gameState in log:** Unit test on `appendTurn` / `BotTurnTrigger`. Replaying any End-state snapshot through one tick produces a log row with `gameState: 'end'`.
- **AC4 — lucky path still works:** Regression for s2 t74-style cases. Fixture: cash 286, 5 cities, route whose final stop is `deliver Tourists @ Berlin` (off-network). Assert: bot ends the turn with Berlin connected (whether via the route-based target or the cheapest-major override is fine; both connect Berlin if Berlin is the cheapest).
- **AC5 — sub-threshold unchanged:** Fixture: cash 220, 6 cities, `gameState=End`. Assert: victory-build does not fire; trip planner's normal selection drives behavior.

## Not in scope

- Re-tuning the 200M End-state latch threshold or the 250M cashGap cap.
- Reworking `applyEndStateScoring` itself (it still runs for trip selection).
- Affordability gates against the 250M victory threshold (bot may temporarily dip below; will recover via deliveries).
- Changes to JIRA-239's delivery-first guard or JIRA-240's bundling guard (both downstream of the override).
- Behavior when `cities ≥ 7 AND cash < 250M`.
- Discard policy in End state.
- LLM-driven endgame decisions.
