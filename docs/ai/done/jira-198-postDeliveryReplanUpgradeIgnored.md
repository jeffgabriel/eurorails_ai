# JIRA-198 — Bots silently ignore LLM upgrade requests after first delivery

## What's broken

The LLM is correctly emitting `upgradeOnRoute: "FastFreight"` (or HeavyFreight / Superfreight) in its trip plans. But once a bot has an active route, every subsequent trip plan goes through `PostDeliveryReplanner.replan()` — and that function never consumes the upgrade hint. The new route is saved, the upgrade field rides along but is never turned into an actual `UpgradeTrain` action.

Game `76663d98-288b-499b-8f4d-ceb8e09ad573` shows Nano had this happen 5 times while sitting on 65M–106M cash, and ended the game on Freight despite 10 deliveries / 213M total payout. Across all three bots, 19 LLM upgrade requests were issued and 0 upgrades executed.

## Root cause

There are two code paths that call `TripPlanner.planTrip()`:

1. **`NewRoutePlanner.run()`** (`src/server/services/ai/NewRoutePlanner.ts:167`) — runs only when the bot has **no active route**. After the LLM returns, it calls `tryConsumeUpgrade()` (lines 220–227) and emits `pendingUpgradeAction`, which `AIStrategyEngine.ts:345` injects into the turn plan as a real `UpgradeTrain` action.

2. **`PostDeliveryReplanner.replan()`** (`src/server/services/ai/PostDeliveryReplanner.ts:111`) — runs after **every successful delivery** while a route is active. It calls `planTrip()`, gets a route with `upgradeOnRoute` populated, calls `AdvisorCoordinator.adviseEnrichment(...)` and `skipCompletedStops(...)`, and returns the route — **with no `tryConsumeUpgrade` call**. The upgrade field rides along on the new route object but is never turned into a `pendingUpgradeAction`, never enters the turn plan, never reaches `TurnExecutor.handleUpgradeTrain`.

Because the first trip after game start uses `NewRoutePlanner.run()` and every subsequent route comes from `PostDeliveryReplanner.replan()` (deliveries trigger replans, never reaching the no-active-route branch again), the bot is permanently locked on whatever train it had after the first ~4 deliveries. Combined with `MIN_DELIVERIES_BEFORE_UPGRADE = 4`, the eligibility window is essentially zero: by the time the gate opens, the bot is always in the wrong code path.

## Evidence (game 76663d98)

| Turn | Player | Deliveries | Cash | LLM said | Outcome |
|---|---|---|---|---|---|
| 43 | Nano | 5 | 29M | upgradeOnRoute=FastFreight | MoveTrain (upgrade dropped) |
| 52 | Nano | 6 | 65M | upgradeOnRoute=FastFreight | MoveTrain (upgrade dropped) |
| 66 | Nano | 7 | 81M | upgradeOnRoute=FastFreight | MoveTrain (upgrade dropped) |
| 79 | Nano | 8 | 92M | upgradeOnRoute=FastFreight | MoveTrain (upgrade dropped) |
| 86 | Haiku | 4 | 49M | upgradeOnRoute=FastFreight | MoveTrain (upgrade dropped) |
| 91 | Haiku | 6 | 41M | upgradeOnRoute=FastFreight | MoveTrain (upgrade dropped) |

All decisionSource=`route-executor`, all carrying a `planTrip` LLM call from the post-delivery replan, all with `upgradeOnRoute=FastFreight` in the response, all silently dropped.

## Fix — fits the JIRA-195b decomposition exactly

The JIRA-195b spike already created `Stage3Result` (`schemas.ts:275-308`) with `pendingUpgradeAction` and `upgradeSuppressionReason` as first-class cross-branch fields, and the injection at `AIStrategyEngine.ts:345` already consumes them regardless of source branch. The active-route branch (`ActiveRouteContinuer.run`) returns a `Pick<Stage3Result, ...>` that simply *omits* these two fields — that omission is the structural reason the active-route branch can't emit an upgrade today. The fix is to extend the `Pick` and plumb the fields through the existing decomposition layers.

Phase ordering is on our side: `PostDeliveryReplanner.replan()` runs inside `MovementPhasePlanner` (Phase A), strictly before `BuildPhasePlanner` (Phase B). The upgrade signal always arrives before Phase B is composed, so it can replace the Phase B build cleanly via the existing `MultiAction` injection — no mid-Phase-B injection problem exists.

### 1. `PostDeliveryReplanner.replan()` — call `tryConsumeUpgrade` on the new route
After `tripPlanner.planTrip()` returns a route in sub-path 1 (`PostDeliveryReplanner.ts:128-148`), call `NewRoutePlanner.tryConsumeUpgrade(route, snapshot, tag, deliveryCount)` (likely needs to be promoted from `private` to a shared static, or extracted to a small helper module to avoid `NewRoutePlanner` ↔ `PostDeliveryReplanner` cross-imports). Add to `ReplanResult`:
- `pendingUpgradeAction?: TurnPlanUpgradeTrain | null`
- `upgradeSuppressionReason?: string | null`

`deliveryCount` should be `(memory.deliveryCount ?? 0) + deliveriesThisTurn` — same patched value already passed as `replanMemory` at line 107-110, so the JIRA-119 gate sees in-turn deliveries.

Sub-paths 2/3/4 (no route returned, throw, no brain) leave both fields undefined — there's nothing to consume.

### 2. `MovementPhasePlanner` — propagate from `replanResult`
At `MovementPhasePlanner.ts:255-271` the replan result is already destructured. Capture `pendingUpgradeAction` and `upgradeSuppressionReason` and add them to MovementPhasePlanner's return type. Multiple deliveries in a single Phase A means multiple replan calls; **last non-null wins** is the simplest and matches "the LLM's most recent intent". Document this in a comment.

### 3. `TurnExecutorPlanner.execute()` — pass through in `TurnExecutorResult`
Add the two fields to `TurnExecutorResult` (`TurnExecutorPlanner.ts` interface near line 145 where `replanLlmLog` etc. already live). Pure plumbing.

### 4. `ActiveRouteContinuer.run()` — extend its `Pick<Stage3Result, ...>`
Today returns `Pick<Stage3Result, 'decision' | 'activeRoute' | 'routeWasCompleted' | 'routeWasAbandoned' | 'hasDelivery' | 'execCompositionTrace'>` (`ActiveRouteContinuer.ts:58`). Extend the Pick to include `'pendingUpgradeAction' | 'upgradeSuppressionReason'`, and forward them from `execResult`.

### 5. `AIStrategyEngine.ts:278` — extend the destructure
The active-route branch destructure currently only picks 6 fields. Add `pendingUpgradeAction` and `upgradeSuppressionReason`. The injection at `ts:345` is already in place and will fire correctly with no further changes.

### 6. Don't change `MIN_DELIVERIES_BEFORE_UPGRADE = 4`
The gate is doing its job correctly. Leave it.

## Verification

1. **Replay game `76663d98`** (or run a similar 80-turn game): expect at least one bot to upgrade to FastFreight by turn ~30, and ideally Superfreight by mid-game.
2. **Unit test `PostDeliveryReplanner`**: stub `tripPlanner.planTrip` to return a route with `upgradeOnRoute='FastFreight'`, assert the result includes a `pendingUpgradeAction` with the right cost when delivery count + cash thresholds are met, and `null` with a suppression reason when not.
3. **Integration test the full active-route → delivery → replan → upgrade chain** (extend an existing `ActiveRouteContinuer` or `AIStrategyEngine` test). Assert `decision.plan` ends up as a `MultiAction` containing `UpgradeTrain`.
4. **Existing tests**: `AIStrategyEngine.jira161.test.ts` and `NewRoutePlanner.test.ts` cover the no-active-route consumption path — they should still pass unchanged.

## Out of scope

- Not touching the LLM prompts (they're working).
- Not touching `tryConsumeUpgrade` itself — it's correct, just under-called.
- Not changing the `MIN_DELIVERIES_BEFORE_UPGRADE` constant.
- Not adding a deterministic "force upgrade after N turns" rule (separate question — worth raising later, out of scope here).

## Open questions for review

1. **Where does `tryConsumeUpgrade` live after this change?** Two options: (a) promote from `private` on `NewRoutePlanner` to a shared static and call it from `PostDeliveryReplanner`; (b) extract into its own small module (e.g. `UpgradeConsumer`) and have both planners call it. Option (b) is cleaner but adds a file; option (a) creates a `PostDeliveryReplanner` → `NewRoutePlanner` import which is structurally fine but slightly weird semantically. Preference?
2. **Multiple deliveries per Phase A** — is "last non-null upgrade signal wins" the right policy, or should we prefer the *first* signal (treat the original intent as authoritative)?
3. Is this scoped correctly as a single ticket, or do you have related upgrade-pipeline work to bundle?
