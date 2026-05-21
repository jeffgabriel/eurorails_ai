# JIRA-234 — Three regressions in game cccbc7e1: stuck mid-route bot, missed adjacent pickup, BuildAdvisor re-enabled (behavioral)

## Source

`logs/game-cccbc7e1-e4ad-4efa-9928-9725bd7f5f7c.ndjson` and `logs/llm-cccbc7e1-e4ad-4efa-9928-9725bd7f5f7c.ndjson` — discovered 2026-05-12 during a manual test run after restoring lost stash work (log viewer routes, leaderboard payload pips). All three defects observed in the same game; report bundles them because they share the evidence base.

Game timestamp: 2026-05-12T18:10Z. Was started AFTER commits `6d31631` (JIRA-231/232 affordability gate) at 2026-05-12 13:45Z, so the known affordability fix should have been active.

---

## Defect A — Bot s3 stuck mid-route at $7M, 17 consecutive PassTurns, route never abandoned

### Observed trace

| Turn | Cash | Train | Loads | Position | Action | Notes |
|------|------|-------|-------|----------|--------|-------|
| t11 | 41 | freight | — | — | — | Cash from prior deliveries |
| t12 | 21 | fast_freight | — | — | UpgradeTrain | freight → fast (-$20M) |
| t13 | 5  | fast_freight | — | — | — | Spending on previous route |
| t14 | 0  | fast_freight | — | — | — | Wine deliveries imminent |
| t15 | 27 | fast_freight | — | — | (mid-turn) | Wine delivered@Napoli+@Roma. NEW route appears: `pic:China@Leipzig → del:China@Oslo → pic:Fish@Oslo → del:Fish@Budapest` |
| t16 | 21 | superfreight | — | — | (mid-turn) | Bot upgraded fast → super (-$20M). Cash 27 → 21. |
| t17 | 7  | superfreight | [China] | Leipzig | BuildTrack | Built 11 segments for $14M, then ran out of cash. China pickup complete. |
| t18 | 7  | superfreight | [China] | Leipzig | MoveTrain | Stuck. |
| t19–t34 | 7 | superfreight | [China] | Leipzig | **PassTurn ×16** | Route still `del:China@Oslo` at idx=1. Never abandoned. |

### Three sub-symptoms

**A1.** The Leipzig→Oslo→Oslo→Budapest route was approved at t15 even though the bot had only $27M, was about to spend $20M upgrading to superfreight, and Leipzig→Oslo via Germany/Denmark/Sweden water crossings + Norwegian mountains costs far more than $7M of remaining cash.

**A2.** Every s3 record shows `decisionSource: route-executor`. The deterministic trip planner (where the JIRA-232 upgrade-aware affordability gate lives) is never invoked for s3 in this game — zero `[JIRA-232][predict]` log lines exist in the file. The route was set by an in-turn replan path (PostDeliveryReplanner or equivalent) that does not go through `scoreCandidate`'s affordability gate.

**A3.** From t19 onward the bot PassTurns 16 consecutive times with: carry=[China], cash=$7M, build target=Oslo, build cost=$0/turn (cannot afford any segment that helps progress toward Oslo). The existing stuck-bot guardrails (JIRA-166 "isActivelyTraveling", JIRA-177 "broke-and-stuck", JIRA-199 "Unaffordable-and-stuck", JIRA-225 "stuckRouteAbandonNotFiringFastEnough") do not fire. The carry-load + non-zero-cash combination is outside the conditions those guards check.

### Acceptance

- A bot in mid-route with carry > 0 and persistent inability to build progress segments (e.g., `build.cost == 0` for N consecutive turns while `a2.terminationReason == 'stop_city_not_on_network'`) abandons the route and replans — drop carried load if necessary.
- Post-delivery / in-turn replans must apply the same affordability gate as `DeterministicTripPlanner.scoreCandidate` (including JIRA-232 upgrade-awareness).
- A regression test that simulates s3's t15 state (cash=27M, fast_freight, just-paid Wine deliveries, China demand to Oslo plus other demands) must produce a feasible route or no-route, never the Leipzig→Oslo→Oslo→Budapest plan that bankrupts the bot.

---

## Defect B — s1 skips Newcastle Oil pickup despite empty slot, on-route geography, and matching demand card

### Observed trace

s1 is a **Superfreight (capacity=3)** carrying just Hops. Two empty slots. At t34 s1 holds 9 demand cards including:

| Load | Supply | Delivery | Payout |
|------|--------|----------|--------|
| Fish | Aberdeen | London | $6M |
| Hops | Cardiff | Munchen | $29M |
| Wine | Wien | Bilbao | $8M |
| Chocolate | Bruxelles | London | $10M |
| **Oil** | **Newcastle** | **Warszawa** | **$21M** |
| Wine | Wien | Belfast | $33M |
| Wheat | Toulouse | Madrid | $15M |
| Marble | Firenze | Lodz | $27M |
| Fish | Aberdeen | Bern | $37M |

s1's active route throughout t32–t37: `pic:Hops@Cardiff → pic:Fish@Aberdeen → del:Fish@Bern → del:Hops@Munchen`. Newcastle Oil pickup is not on the route. Position trace t33–t36: Birmingham(16,30) → Manchester(13,30) → (3,31) → Aberdeen-area(7,30). The bot traverses northern England with two empty cargo slots and a $21M Newcastle→Warszawa demand in hand — and never adds Newcastle to the trip.

### Why this is a defect

- The pickup is geographically adjacent to the bot's already-planned UK pickups (Cardiff in Wales, Aberdeen in Scotland — Newcastle is on the way north).
- The bot has 2 empty cargo slots; capacity is not the constraint.
- The Oil card pays $21M (third-highest in hand); the trip planner is leaving substantial value on the table.
- This matches the failure class targeted by JIRA-228 (backhaul pair ordering) and JIRA-229 (two-trip look-ahead) — the planner is selecting a fixed 2-pickup-2-delivery shape rather than enumerating extended-pickup variants where capacity permits.

### Acceptance

- Trip enumeration must consider `pickup` insertions for additional demand cards when (a) capacity allows and (b) the supply city is within a small detour of an existing waypoint, even when the demand is not part of the chosen pair.
- A regression test with s1's t32 state (superfreight, Cardiff/Aberdeen/Newcastle demands all in hand, no carry) must produce a route that includes the Newcastle Oil pickup somewhere between Cardiff and the eventual European delivery — or a planner-emitted rationale for why the detour was rejected (e.g., detour cost > opportunity value).

---

## Defect C — BuildAdvisor LLM is still being called; was supposed to be removed/disabled

### Observed

- `logs/game-cccbc7e1-…ndjson`: **73 mentions** of BuildAdvisor.
- `logs/llm-cccbc7e1-…ndjson`: **69 LLM calls** to the BuildAdvisor.
- `src/server/services/ai/TurnExecutorPlanner.ts:305-307`: `AdvisorCoordinator.adviseBuild(...)` is invoked unconditionally inside the build phase whenever `useAdvisor && brain != null && gridPoints != null`.

### Expected

The BuildAdvisor LLM call was supposed to be gated off based on 7-day log analysis showing 41.6% LLM success rate with **no measurable delivery uplift** over the heuristic Dijkstra-only path. The intended state: skip the LLM, go straight to the heuristic; flip on only via `ENABLE_BUILD_ADVISOR=true` for A/B comparison.

### Root cause (code management, not a logic bug)

Discovered in dropped git stash `d7e1798` (May 12 WIP, never committed, currently dangling):

```ts
// src/server/services/ai/BuildAdvisor.ts (stash content)
export function isBuildAdvisorEnabled(): boolean {
  const value = process.env.ENABLE_BUILD_ADVISOR;
  if (value === undefined || value === '') return false;
  return value.toLowerCase() === 'true';
}
```

```ts
// src/server/services/ai/TurnExecutorPlanner.ts (stash content)
if (useAdvisor && brain != null && gridPoints != null && isBuildAdvisorEnabled()) {
  const advisorBuildResult = await AdvisorCoordinator.adviseBuild(...)
}
```

That stash was dropped (along with several other May 11-12 WIP stashes) and never committed. HEAD is missing the feature flag and still always-calls the BuildAdvisor LLM.

### Acceptance

- `src/server/services/ai/BuildAdvisor.ts` exports `isBuildAdvisorEnabled()` reading `process.env.ENABLE_BUILD_ADVISOR`, defaulting to `false`.
- `TurnExecutorPlanner.ts` build-phase block gates the `AdvisorCoordinator.adviseBuild` call behind `isBuildAdvisorEnabled()`.
- A test run with default env produces zero BuildAdvisor LLM calls; setting `ENABLE_BUILD_ADVISOR=true` restores them.
- Startup log emits `[BuildAdvisor] ENABLE_BUILD_ADVISOR=<true|false>` so an operator can see whether the LLM is engaged.

---

## Cross-cutting observation

This game was started 4½ hours after the JIRA-231/232 fix landed, but **all three defects above are observable**. Defect A demonstrates that the affordability fix only protects routes that flow through `DeterministicTripPlanner.scoreCandidate`; in-turn / post-delivery replan paths bypass it. Defect B shows the trip enumerator (and thus the existing affordability gate) never sees the broader option space — Defect A's fix is necessary but not sufficient. Defect C is a code-management regression introduced by a dropped stash, not a logic bug.

Treating these as one ticket because the same game produced all three; if compounds prefers to split, A and B are tightly related (replan / enumeration), and C is independent.
