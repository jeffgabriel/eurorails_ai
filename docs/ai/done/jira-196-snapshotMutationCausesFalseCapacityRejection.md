# JIRA-196: Pickup-Side Snapshot/Context Mutation Causes Pickup Bugs

**Status:**
- Bug 1 (pickup stop incorrectly skipped on duplicate same-type pickup) — SPEC, awaiting fix.
- Bug 2 (false "Train at full capacity" rejection) — Fix A SHIPPED on `compounds/guardrail-updates`. Fix B (the contract-clean refactor) deferred → now folded into Bug 1's fix plan.

**Related:** JIRA-193 (Bug A — pickup-side load-state mutation introduced via `applyStopEffectToLocalState`), JIRA-104 (count-aware `isPickupComplete`), JIRA-156 (TurnExecutor / TurnExecutorPlanner split). Both bugs are direct consequences of the JIRA-193 R2 fix interacting with `ContextBuilder.ts:179`'s shared array reference.

**Reproduces in:**
- Bug 1: Game `6bdd0bb6-b130-4052-9827-77c5d9867bdf` — Flash bot, Bern, route `[pickup Cheese, pickup Cheese, deliver Milano, deliver Budapest]`. Only one pickup is emitted; the second same-type pickup stop is skipped.
- Bug 2: Game `7fae7b25-dcae-41dc-852d-884a60ddb8fd`, Haiku T5 — Steel@Luxembourg → Paris. (Fix A shipped.)

---

## The shared root cause

Two places interact to produce both bugs:

**`src/server/services/ai/ContextBuilder.ts:179`**
```ts
loads: snapshot.bot.loads,
```
`context.loads` is **not a copy** — it's the same array reference as `snapshot.bot.loads`.

**`src/server/services/ai/routeHelpers.ts:249-251`** (`applyStopEffectToLocalState`, added by JIRA-193 R2)
```ts
if (action === 'pickup') {
  context.loads.push(loadType);
  snapshot.bot.loads.push(loadType);   // same array — pushes a duplicate
}
```

Because `context.loads === snapshot.bot.loads`, every pickup pushes the load type **twice**. JIRA-193 R2 was written believing they were two separate arrays; the ContextBuilder line predates it and was never audited under the new contract.

The two bugs below are different *symptoms* of this same defect.

---

## Bug 1 — Pickup stop incorrectly skipped on duplicate same-type pickup

### Symptom

Game `6bdd0bb6-b130-4052-9827-77c5d9867bdf`, Flash T4. Route is `[pickup Cheese@Bern, pickup Cheese@Bern, deliver Cheese@Milano, deliver Cheese@Budapest]`. Bot reaches Bern but emits only **one** PickupLoad action. Audit log shows `currentStopIndex=2` at end-of-turn (advanced past both pickup stops) and `carriedLoads=['Cheese','Cheese','Cheese']` (3 loads on a capacity-2 train — impossible). DB-persistent state at start of T5 confirms only **1** Cheese was actually committed.

### Reconstructed turn

1. Bot reaches Bern, executes pickup #1 (DB write succeeds — 1 Cheese onboard).
2. `applyStopEffectToLocalState` runs:
   - `context.loads.push('Cheese')` → `['Cheese']`
   - `snapshot.bot.loads.push('Cheese')` → same array, now `['Cheese','Cheese']`
   - `context.loads` is now `['Cheese','Cheese']` (shared ref).
3. Planner advances to stop 1 (the second pickup) and asks `isPickupComplete`:
   ```ts
   loadsOnTrain = context.loads.filter(l => l === 'Cheese').length;   // = 2
   sameTypePickupsUpToHere = 2;   // both pickup stops at indices 0 and 1
   return 2 >= 2;   // TRUE — falsely reports stop 1 already complete
   ```
4. `skipCompletedStops` skips stop 1.
5. Loop moves on to stop 2 (deliver Milano). Bot heads south. Movement budget exhausted; turn ends.
6. Plan emits **one** PickupLoad even though the route has **two** pickup stops at the same city.

### Why `carriedLoads` shows 3 in the audit log

The audit log captures `snapshot.bot.loads` at end-of-turn, not the DB-committed loads. After:
- `applyStopEffectToLocalState` (2 pushes via the shared ref → 2 Cheese)
- `TurnExecutor.handlePickupLoad` also pushes onto `snapshot.bot.loads` after its DB write (1 more Cheese → 3 Cheese in snapshot)

…the snapshot ends up at 3. The DB row itself has 1 Cheese, which is what T5 reads.

### Why this is a sibling of Bug 2

Both bugs stem from `applyStopEffectToLocalState` mutating `snapshot.bot.loads` in a way that other code reads as if it were the DB state:
- **Bug 2:** `TurnExecutor.handlePickupLoad`'s pre-check reads the mutated snapshot and falsely rejects.
- **Bug 1:** `isPickupComplete` reads `context.loads` (which equals `snapshot.bot.loads` due to the shared reference), sees a double-pushed count, and falsely reports completion.

Fixing Bug 2 alone (Fix A — already shipped) does not fix Bug 1. The `ContextBuilder.ts:179` shared reference must also be addressed.

---

## Bug 2 — False "Train at full capacity" rejection (Fix A shipped)

### Symptom (historical, retained for context)

The bot's first pickup of a turn fails with `Train at full capacity (N/N)` even when the actual database state has `N-1` loads. Error fires inside `TurnExecutor.handlePickupLoad`'s in-snapshot capacity pre-check. Bot loses the entire turn to a pipeline error and emits `PassTurn`.

### Reconstructed turn (Haiku T5)

From `logs/game-7fae7b25-dcae-41dc-852d-884a60ddb8fd.ndjson`:

- T5 starts: bot at (30,40), `bot.loads = ["Steel"]` (DB), `currentStopIndex: 0`. Route `[pickup(Steel@Luxembourg), deliver(Steel@Paris), pickup(Chocolate@Zurich), deliver(Chocolate@Munchen)]`.
- Iter 1: bot moves 1mp to Luxembourg. `plans.push(MoveTrain)`.
- Iter 2: `executeStopAction` → `ActionResolver.resolvePickup` sees the *unmutated* snapshot (`1 < 2`) → success. Plan generated. `plans.push(PickupLoad)`. `applyStopEffectToLocalState` then pushes Steel onto `snapshot.bot.loads` (now `["Steel","Steel"]`). `currentStopIndex` advances 0 → 1.
- Iter 3: target = Paris (deliver). Plan move toward Paris. Budget exhausted.
- `TurnExecutor.executeMultiAction(plans, snapshot)` runs with the same mutated snapshot:
  - Step 2 (PickupLoad): `handlePickupLoad`'s pre-check sees `snapshot.bot.loads.length === 2`, capacity 2 → rejects with `Train at full capacity (2/2)`.
- Turn aborts.

### Fix A (shipped): remove the snapshot pre-check in `TurnExecutor.handlePickupLoad`

The DB-side check (`SELECT array_length(loads, 1) FROM players WHERE id = $1 FOR UPDATE`) is the authoritative one — race-safe, reads actual DB state. The snapshot-based pre-check at `TurnExecutor.ts:505-518` was redundant (because `ActionResolver.resolvePickup` already does the same check at planner stage on the unmutated snapshot) and harmful under the JIRA-193 R2 contract. Deleted.

---

## The fix plan (combined Bug 1 + deferred Fix B)

Two coordinated changes. Together they fix Bug 1 and clean up the contract that produced both bugs.

### Change 1 — `ContextBuilder.ts:179`: copy the array

```ts
// Before
loads: snapshot.bot.loads,

// After
loads: [...snapshot.bot.loads],
```

This severs the shared reference. `context.loads` becomes an independent working array that the planner can mutate without polluting the snapshot.

**Risk:** Very low. `context.loads` is only mutated by `applyStopEffectToLocalState` and read by planner-internal helpers — none of them rely on the alias. Audit grep `context\.loads` confirms no caller treats it as a live view of `snapshot.bot.loads`.

### Change 2 — `routeHelpers.ts`: `applyStopEffectToLocalState` mutates only `context.loads`

```ts
export function applyStopEffectToLocalState(
  stop: RouteStop,
  context: GameContext,
  // snapshot parameter no longer needed — drop it
): void {
  const { action, loadType } = stop;

  if (action === 'pickup') {
    context.loads.push(loadType);
  } else if (action === 'deliver' || action === 'drop') {
    const ctxIdx = context.loads.indexOf(loadType);
    if (ctxIdx !== -1) context.loads.splice(ctxIdx, 1);
  }
}
```

The snapshot now stays in sync with actual DB state across the entire planner run. `context.loads` is the planner's working state.

**Callers to update:**
- `TurnExecutorPlanner.ts` — drop the `snapshot` argument at every `applyStopEffectToLocalState` call site.

**Readers to audit (must not depend on `snapshot.bot.loads` reflecting planner-simulated state):**
- `isPickupComplete` (`routeHelpers.ts:194`) — reads `context.loads`. ✓ correct.
- `isDeliveryComplete` (`routeHelpers.ts:218`) — reads `context.loads`. ✓ correct.
- `evaluateCargoForDrop` (`TurnExecutorPlanner.ts:991`) — reads `snapshot.bot.loads.map(...)`. **Must change to `context.loads`** so it sees the planner's working state, not stale DB state. Otherwise the recovery branch could try to drop a load the planner thinks was already picked up.
- Any other reader of `snapshot.bot.loads` between `applyStopEffectToLocalState` and `TurnExecutor.handlePickupLoad` — grep `snapshot\.bot\.loads` and trace.

**Risk:** Medium. Requires the audit. Pays for itself by establishing a clean contract: `snapshot` = DB state, `context` = planner-local working state.

### Why both changes are needed

Either change in isolation is insufficient:
- **Change 1 only:** `applyStopEffectToLocalState` would still mutate `snapshot.bot.loads` (now a different array from `context.loads`). Bug 2's class would re-emerge if Fix A were ever reverted, and any other code reading `snapshot.bot.loads` mid-planner-run would still see polluted state.
- **Change 2 only:** mutating only `context.loads` would still mutate `snapshot.bot.loads` (because they're the same array via the shared reference). Bug 1 would not be fixed.

---

## Tests

Three layers, mapped to the failure modes:

### 1. Unit — `routeHelpers.applyStopEffectToLocalState` no longer mutates snapshot

Construct a `WorldSnapshot` with `bot.loads = ['Steel']` and a `GameContext` whose `loads` is a *copy* (mirrors the new ContextBuilder behaviour). Call `applyStopEffectToLocalState({action:'pickup', loadType:'Cheese'}, context, snapshot)`. Assert:
- `context.loads === ['Steel','Cheese']`
- `snapshot.bot.loads === ['Steel']` (unchanged)

### 2. Unit — `isPickupComplete` correctly handles double-pickup of same load type

Set up a route `[pickup Cheese, pickup Cheese, deliver Milano]`. Context starts with `loads: []`. After applying the effect of the first pickup:
- `isPickupComplete(stop=pickup#0, idx=0, route, context)` → `1 >= 1` → true (correctly considered done).
- `isPickupComplete(stop=pickup#1, idx=1, route, context)` → `1 >= 2` → false (correctly NOT done; second pickup still pending).

### 3. Integration — Flash Bern repro (Bug 1)

Set up a route `[pickup Cheese@Bern, pickup Cheese@Bern, deliver Cheese@Milano, deliver Cheese@Budapest]` with the bot at Bern carrying 0 Cheese in DB. Run `AIStrategyEngine.takeTurn`. After fix: the plan contains **two** PickupLoad actions; turn ends with 2 Cheese onboard. Before fix: only one PickupLoad action; second pickup stop skipped.

### 4. Regression — JIRA-193's original bug

Set up the JIRA-193 reproduction (post-pickup at supply city, route says deliver next). Verify the fix does NOT regress JIRA-193 — the bot continues moving toward the delivery after a successful pickup, doesn't stop at the supply city. This guards against accidentally undoing JIRA-193 R2 while fixing the snapshot-mutation contract.

### 5. Regression — Bug 2 (Fix A interaction)

Set up the Haiku T5 scenario (bot carrying 1 Steel in DB, planning to pick up 1 Steel at Luxembourg). Verify the pickup still succeeds end-to-end after Changes 1 + 2. This confirms the new contract still admits valid pickups when Fix A's DB-only check runs.

---

## Related code paths

- `src/server/services/ai/ContextBuilder.ts:179` — the shared array reference.
- `src/server/services/ai/routeHelpers.ts:188-200` — `isPickupComplete`, the false-completion site (Bug 1).
- `src/server/services/ai/routeHelpers.ts:242-259` — `applyStopEffectToLocalState`, the source of the snapshot mutation.
- `src/server/services/ai/TurnExecutorPlanner.ts:266-320` — route-stop iteration; calls `applyStopEffectToLocalState`.
- `src/server/services/ai/TurnExecutorPlanner.ts:991` — `evaluateCargoForDrop`, reads `snapshot.bot.loads` (must migrate to `context.loads`).
- `src/server/services/ai/TurnExecutorPlanner.ts:1042-1072` — `executeStopAction` pickup branch and recovery.
- `src/server/services/ai/TurnExecutor.ts:479-555` — `handlePickupLoad` (Fix A landed here).
- `src/server/services/ai/ActionResolver.ts:730-797` — `resolvePickup`, the unmutated capacity check.

## Why now

Bug 1 fires on essentially any route with two same-type pickups at the same supply city — a common pattern when a bot has two demand cards for the same load type (e.g., two Cheese demands routed through Bern). Until fixed, those routes silently lose pickups and leave the bot under-loaded for downstream deliveries. JIRA-195's Stage 3 decomposition (now landed) makes the planner-state vs. executor-state boundary the next architectural seam to reinforce, and this fix is exactly that reinforcement.
