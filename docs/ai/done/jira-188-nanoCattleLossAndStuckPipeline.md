# JIRA-188: Nano Loses Cattle Mid-Trip via Nonsensical DROP, Then Dies in a Pipeline Loop

**Game:** `faf86a5f-afc5-4343-b38d-e8791c304d91`
**Player:** Nano (freight train, speed 9, capacity 2)
**Logs:** `logs/game-faf86a5f-afc5-4343-b38d-e8791c304d91.ndjson` (177 turn entries), `logs/llm-faf86a5f-afc5-4343-b38d-e8791c304d91.ndjson` (188 LLM calls)

## Summary

Nano picked up Cattle at Bern holding two Cattle demand cards (Bern→London 16M, Bern→Antwerpen 11M) and ended the game unable to cash in either. Two distinct bugs compose into a catastrophic outcome:

1. **Lost load (T55)** — committed route contained `pickup Bauxite@Marseille → pickup Cattle@Bern → drop Cattle@Paris → deliver Cattle@London → deliver Bauxite@London`. Route-executor obeyed the plan: dropped the cattle at Paris, arrived at London with only Bauxite. The drop was *not* from the route-enrichment advisor — it originates in the `trip-planner` LLM's **candidate #2** from T49, which proposes a `DROP Cattle@Paris` stop *while the bot is not carrying Cattle*. The LLM's own `chosenIndex` was `1`, not `2`; candidate 2 won because TripPlanner silently fell back to it after rejecting the LLM's pick.

2. **Stuck-state loop (T64–T74+)** — every turn terminates with `error: "Demand does not match delivery"` and `decisionSource: pipeline-error`. 11+ dead turns. Nano (11 pipeline-error turns) and Flash (46 on a different error class) together lost 15%+ of the game to unrecoverable pipeline failures with no replan / discard fallback.

---

## Issue 1 — Self-destructive `pickup X → drop X → deliver X` route committed

### The route that ran on T49–T56

`activeRoute.stops` (unchanged across these turns):

```
[0] pickup  Bauxite  @ Marseille
[1] pickup  Cattle   @ Bern
[2] drop    Cattle   @ Paris     ← executed T55 at Paris mileposts (30,32)→(29,32)→(29,33)
[3] deliver Cattle   @ London    ← unreachable after T55
[4] deliver Bauxite  @ London    ← T57 delivered, +25M (cash 15→40)
```

T55 `composition.outputPlan = ["MoveTrain", "DropLoad", "MoveTrain", "BuildTrack"]`, `pickups: []`, `deliveries: []`. Cattle discarded without payoff. Two Cattle demand cards (London + Antwerpen) remained in hand.

### What the LLMs actually produced on T49

Both LLM calls on T49 are in `logs/llm-*.ndjson`. Neither contains a `pickup Cattle@Bern → drop Cattle@Paris → deliver Cattle@London` triple.

**`trip-planner`** call `bfa6416b-…` returned three candidates with `chosenIndex: 1`:

| # | Stops | Chosen? |
|---|---|---|
| 0 | `pickup Wood@Firenze → deliver Wood@Ruhr(card 35) → pickup Wheat@Milano → deliver Wheat@Wien(card 32)` | no |
| **1** | `pickup Cattle@Firenze → deliver Cattle@Antwerpen(card 32, 11M) → pickup Wheat@Milano → deliver Wheat@Wien(card 32)` | **yes** |
| 2 | `pickup Bauxite@Marseille → deliver Bauxite@London(card 92, 25M) → DROP Cattle@Paris → pickup Wood@Marseille → deliver Wood@Lyon(card 35)` | no |

**Key facts:**
- The LLM *wanted* to deliver Cattle to Antwerpen (candidate 1) — the 11M Antwerpen card was in its plan.
- All three candidates hallucinate supply cities (Wood's real supply for card 35 is Sarajevo; Cattle's supply for card 32 is Bern — LLM said Firenze for both). Candidates 0 and 1 are almost entirely hallucinated.
- Candidate 2 **proposes dropping Cattle at Paris while the bot is not carrying Cattle** at T49 (bot had no loads at T49 start — it's about to pick up Bauxite). Nonsensical on its face.

**`route-enrichment-advisor`** call `b9c364e1-…` (runs after trip-planner) returned only:

```json
{ "decision": "insert",
  "insertions": [
    { "afterStopIndex": 0, "action": "pickup",  "loadType": "Cattle", "city": "Bern"   },
    { "afterStopIndex": 1, "action": "deliver", "loadType": "Cattle", "city": "London" }
  ]
}
```

No drop stop. The enrichment advisor simply inserted a cattle pickup + London delivery around an *already-committed* route that already contained `drop Cattle@Paris`.

### How candidate 2 became the committed route (the real root cause)

`src/server/services/ai/TripPlanner.ts:186–198`:

```typescript
const ci = parsed.chosenIndex;
const chosenCandidateIdx = candidates.findIndex(c => c.llmIndex === ci);
if (chosenCandidateIdx >= 0 && candidates[chosenCandidateIdx].stops.length > 0) {
  selectedIdx = chosenCandidateIdx;  // honor LLM's chosenIndex
} else {
  selectedIdx = bestIdx;  // fall back to internal score winner
  // reason: "chosenIndex X has 0 feasible stops after validation"
  //     or: "chosenIndex X not found in validated candidates (LLM's pick was fully invalid)"
}
```

Candidate 1 (the LLM's chosen Antwerpen trip) hallucinated `Cattle@Firenze` as its supply — `RouteValidator.checkPickupFeasibility` rejects pickup stops whose city doesn't match any demand's supplyCity. Both pickups in candidate 1 fail (Firenze ≠ Bern for Cattle, Milano ≠ Lyon for Wheat). With all pickups pruned, the paired deliveries are pruned too ("pickup without viable delivery is wasteful", L106–111). Candidate 1 collapses to 0 feasible stops → TripPlanner falls back to `bestIdx`.

Candidate 0 similarly has Wood's hallucinated supply; it also prunes down.

Candidate 2's **Bauxite** stops survive (Bauxite@Marseille is the real supply for card 92). Its Wood stops prune (Wood's real supply is Sarajevo). Crucially, **the `DROP Cattle@Paris` stop survives** — because:

`src/server/services/ai/RouteValidator.ts:271–280`:

```typescript
private static checkDropFeasibility(stop: RouteStop): StopValidation {
  if (!stop.loadType) {
    return { stop, feasible: false, error: 'DROP stop requires a loadType.' };
  }
  return { stop, feasible: true };
}
```

The validator only checks that `loadType` is specified. It does **not** verify the bot is (or will be) carrying that load at this point in the route. A drop stop for a load the bot has no way of possessing is marked feasible.

Candidate 2 after pruning: `[pickup Bauxite@Marseille, drop Cattle@Paris, deliver Bauxite@London]`. RouteOptimizer reorders by proximity. RouteEnrichmentAdvisor then inserts `pickup Cattle@Bern` (afterStopIndex 0) and `deliver Cattle@London` (afterStopIndex 1), producing the 5-stop self-destructive route that ran for 8 turns.

### Why RouteValidator doesn't catch the contradiction after enrichment either

`src/server/services/ai/RouteValidator.ts:83–96`:

```typescript
for (let i = 0; i < validations.length; i++) {
  const v = validations[i];
  if (!v.feasible || v.stop.action !== 'deliver') continue;
  const isCarried = snapshot.bot.loads.includes(v.stop.loadType);
  const hasFeasiblePriorPickup = validations
    .slice(0, i)
    .some(pv => pv.feasible && pv.stop.action === 'pickup' && pv.stop.loadType === v.stop.loadType);
  if (!isCarried && !hasFeasiblePriorPickup) { v.feasible = false; ... }
}
```

A `deliver(X)` is feasible iff a prior pickup exists *or* the load is carried. It does not simulate `drop(X)` in between. The sequence `pickup(X) → drop(X) → deliver(X)` passes because the `pickup` comes before the `deliver`, regardless of what happens in between.

### Where the fix belongs

Three non-mutually-exclusive fix points:

- **`RouteValidator.checkDropFeasibility` (`RouteValidator.ts:271`)** — simulate load state through the stop sequence. Mark `drop(X)` infeasible if no `pickup(X)` appears earlier AND `X` is not currently carried; or if any later `deliver(X)` would become impossible.
- **Trip-planner prompt (`prompts/systemPrompts.ts:194, 219, 242`)** — clarify DROP is only legal for a currently-carried load with no demand card in hand, or remove DROP from the candidate schema entirely (the `LLMStrategyBrain.evaluateCargoConflict` path already handles "drop to free capacity" as a separate decision).
- **`RouteEnrichmentAdvisor`** — when the input route contains a DROP for a loadType, reject enrichment insertions that add pickup/deliver for that loadType (or force re-planning).

---

## Issue 2 — Unrecoverable `Demand does not match delivery` loop (T64–T74, stuck)

### The pattern

T63 ended with Nano at (24,37) `cityName: "Antwerpen"`, carrying Cattle, cash 40, active route stop 1 = `deliver Cattle@London` (no `demandCardId` on the stop — enrichment advisor didn't set one). From T64 onward:

```json
{ "turn": 64,
  "action": "PassTurn", "success": false,
  "error": "Demand does not match delivery",
  "decisionSource": "pipeline-error",
  "actor": "error", "actorDetail": "pipeline-error"
}
```

No `positionStart`, no `activeRoute`, no `demandCards` — the turn aborts before any logging payload is populated. Identical entries T64, T65, … T74.

### Where the error originates

`src/server/services/playerService.ts:862–866`:

```typescript
const matchingDemand = demandCard.demands.find(
  (d) => d.city === city && d.resource === loadType
);
if (!matchingDemand) {
  throw new Error("Demand does not match delivery");
}
```

The `(city, loadType, cardId)` triple sent by `TurnExecutor.handleDeliverLoad → PlayerService.deliverLoadForUser` does not agree with what the server's demand card has.

### The call chain that arrives here on T64

1. `AIStrategyEngine.takeTurn` captures snapshot — bot at (24,37, Antwerpen) carrying Cattle, demand cards include card 32 (Cattle→Antwerpen).
2. `ContextBuilder.computeCanDeliver` (`ContextBuilder.ts:1425`) walks `snapshot.bot.resolvedDemands`; card 32's demand `{city: "Antwerpen", resource: "Cattle"}` matches position+carried load → `context.canDeliver = [{loadType: "Cattle", deliveryCity: "Antwerpen", cardIndex: 32, payout: 11}]`.
3. Active route branch (`AIStrategyEngine.ts:338`) runs `TurnExecutorPlanner.execute`. Route target is London; bot isn't at London; planner composes a MoveTrain plan.
4. `GuardrailEnforcer.checkPlan` (`AIStrategyEngine.ts:840`) fires **Guardrail 1** (`GuardrailEnforcer.ts:50–64`):
   ```typescript
   if (context.canDeliver.length > 0 && planType !== AIActionType.DeliverLoad) {
     const best = GuardrailEnforcer.bestDelivery(context);
     return { plan: { type: DeliverLoad, load: best.loadType, city: best.deliveryCity, cardId: best.cardIndex, payout: best.payout }, overridden: true, ... };
   }
   ```
   Overrides MoveTrain with `DeliverLoad {load: "Cattle", city: "Antwerpen", cardId: 32, payout: 11}`.
5. `TurnExecutor.executePlan(deliverPlan, snapshot)` → `TurnExecutor.execute` → `handleDeliverLoad`.
6. `handleDeliverLoad` (`TurnExecutor.ts:651–678`) re-derives `cityName` from `snapshot.bot.position` via `loadGridPoints().get("24,37").name` → expected `"Antwerpen"`.
7. Calls `deliverLoadForUser(gameId, userId, cityName, "Cattle", 32)`.
8. Server throws `"Demand does not match delivery"`.

### Why the throw propagates as `pipeline-error` instead of a caught step failure

`TurnExecutor.executeMultiAction` (`TurnExecutor.ts:233–249`) wraps each step in try/catch and converts thrown errors into `{success:false, error}` results — so MultiAction plans are safe.

But `TurnExecutor.executePlan` for a *single* plan bypasses this: `TurnExecutor.ts:107` is `return TurnExecutor.execute(option, snapshot);` — a bare return. `handleDeliverLoad` (`TurnExecutor.ts:672`) calls `deliverLoadForUser` with no try/catch around it. A thrown `"Demand does not match delivery"` propagates up through `execute → executePlan → AIStrategyEngine.takeTurn` to the outer catch at `AIStrategyEngine.ts:1213`, which emits a skeletal `PassTurn` entry with `actor: 'error', actorDetail: 'pipeline-error'`.

That's why the T64 log entry has no `positionStart` / `activeRoute` / `demandCards` — everything after step 8 is the catch-all emission path that only populates `{turn, playerId, timestamp, action, success, error, decisionSource, actor, actorDetail}`.

### What actually causes the server mismatch (open question)

On paper, steps 1–7 produce a valid triple: `("Antwerpen", "Cattle", 32)` with card 32 having a `{city: "Antwerpen", resource: "Cattle"}` demand. This *should* succeed.

The data we can see from the log does not prove which part diverged. Candidate mechanisms:

- **A. Stale snapshot after a prior auto-delivery.** If an earlier branch (e.g., JIRA-170 `AIStrategyEngine.ts:384–411`) already delivered and consumed card 32, then the snapshot `resolvedDemands` fed to Guardrail 1 contains a stale cardId mapping. `deliverLoadForUser` rejects at `handIds.includes(cardId)` (L853, "Demand card not in hand") — but that's a *different* error message than what we observe. So probably not this.
- **B. Card-ID reuse / remap.** If card 32 was replaced in hand with a freshly-drawn card that happens to have id 32 but different demands, step 7 would find `demandCard` (L858 passes) but fail the demands lookup (L862). This would produce exactly the observed error. Depends on whether `demandDeckService` reuses IDs — needs verification.
- **C. City-name resolution off-by-one.** If `loadGridPoints().get("24,37").name` returns something other than the raw `"Antwerpen"` stored on card 32's demand (e.g., `"Antwerpen "`, `"antwerpen"`, or an alias), the strict-equality compare on L863 fails.

**TODO:** add `console.error` logging at `TurnExecutor.ts:672` (pre-call) and in the catch at `AIStrategyEngine.ts:1213` to dump `{plan.city, plan.cardId, derived cityName, snapshot.bot.position, handIds, card.demands}` on this specific error. Then re-run a repro scenario from T63 state.

### Why it's permanent (the real bug regardless of mechanism)

Once the error fires on T64:

- The outer catch writes a skeletal `PassTurn` audit and returns — it does **not** touch `activeRoute` in memory, does not discard hand, does not force replan.
- Next turn: same activeRoute, same position, same demand cards, same `canDeliver`, same Guardrail 1 override, same throw. Infinite loop.
- No "N consecutive pipeline errors → force discard / abandon route / PassTurn without re-attempting deliver" fallback exists.

Flash hit an analogous permanent loop (46 turns) on a different error: `"[TurnExecutorPlanner] INVARIANT VIOLATION: build direction disagrees with move direction"`. Same architectural gap.

### Where the fix belongs

- **`TurnExecutor.handleDeliverLoad` (`TurnExecutor.ts:672`)** — wrap the `deliverLoadForUser` call in try/catch, return `{success:false, error}` so the throw doesn't leak past `executeMultiAction`-equivalent safety. This matches the comment at `TurnExecutor.ts:237` which claims such errors *are* caught — but only for MultiAction, not single-step.
- **`AIStrategyEngine.takeTurn` pipeline-error catch (`AIStrategyEngine.ts:1213`)** — detect repeated pipeline errors (e.g., via `memory.consecutivePipelineErrors`) and on N≥2, clear `activeRoute`, force DiscardHand, or move-to-safe-city. No bot should be allowed to permanently PassTurn from a pipeline error.
- **Whichever mechanism (A/B/C above) is the actual cause** — fixed once the repro logging narrows it down.

---

## Cross-cutting root cause

The bot pipeline has **no degrade-gracefully path** when execution of a composed plan fails:

- Issue 1 is caused by a *validation gap* — a nonsensical route survives feasibility checks because `checkDropFeasibility` is a rubber stamp.
- Issue 2 is caused by a *recovery gap* — a thrown error isn't translated to a recoverable failure, and there's no "I'm stuck in an error loop, do something different" fallback.

Either bug alone is bad. Together they're catastrophic: Nano loses a load in one turn due to a route the validator should have rejected, then spends the rest of the game bricked by an error the pipeline has no way out of.

## Linked tickets

- **JIRA-184** — invariant violation from route-enrichment reorder. Same class as Flash's 46-turn stuck loop in this game.
- **JIRA-185** — post-delivery replan stale snapshot. Sibling pipeline data-freshness bug.
- **JIRA-170** — auto-deliver before LLM consultation. Relevant if stuck-loop mechanism is (A) above.
- **JIRA-47** — Guardrail 1 priority (delivery opportunities must never be blocked).

## Open investigation questions

1. Confirm mechanism A/B/C for Issue 2 by re-running a repro with logging at `TurnExecutor.ts:672`.
2. Audit other single-step plans for the same unwrapped-throw pattern (`handlePickupLoad`, `handleBuildTrack`, etc.).
3. Determine whether `RouteEnrichmentAdvisor` should reject enrichments that interact with an existing DROP stop, or whether the validator tightening on Issue 1 is sufficient.
