# JIRA-42: Guardrail Overhaul — Remove Strategic Overrides, Keep Rule Enforcement

**Severity:** High
**Source:** Game `85a69b96` analysis — guardrails still causing pickup-drop death spirals despite JIRA-25/30 fixes

## Problem

The GuardrailEnforcer contains 8 guardrails plus a post-guardrail safety check in AIStrategyEngine. Several guardrails make **strategic decisions** that conflict with each other, creating infinite loops (pickup→drop→pickup→drop for 30+ turns). The JIRA-25/30 fixes patched individual edges (bestPickups feasibility filter, zeroMoneyGate logging) but the fundamental problem persists: guardrails that try to play the game for the LLM create loops when they disagree.

### Evidence — Game 85a69b96, Haiku T20-T49

At T20, the heuristic correctly chose DiscardHand. TurnComposer passed it through (`inputPlan=['DiscardHand']`, `outputPlan=['DiscardHand']`). But G5 (drop undeliverable loads) fired because the bot was carrying Cattle with no feasible delivery, overriding DiscardHand to DropLoad. The bot then entered a 30-turn pickup→drop loop:

- T20: Heuristic→DiscardHand, G5 overrides→DropLoad (Cattle)
- T21: Heuristic→PickupLoad (G2 territory), then BuildTrack
- T22: Heuristic→DiscardHand, G5 overrides→DropLoad again
- T23-T49: Same pattern repeats. Bot stuck at $0 for 25 turns.

G7 (strategic discard after 3 stuck turns) never fired because `consecutivePassTurns` only counts literal PassTurn actions — the bot was doing PickupLoad/DropLoad/MoveTrain, so the counter stayed at 0.

## Root Cause

Guardrails that **enforce game rules** (G1, G3, G8) work well. Guardrails that **make strategic decisions** (G2, G4, G5) fight each other:

1. **G2** forces pickup of demand-matching loads
2. **G5** detects the load is undeliverable and forces a drop
3. **G4** prevents passing while carrying loads
4. The bot oscillates between pickup and drop indefinitely
5. **G6/G7** should break the deadlock but their counter never increments

## Change Plan

### Keep (game rule enforcement)

| Guardrail | What | Why keep |
|-----------|------|----------|
| **G1** | Force DELIVER when canDeliver has opportunities | Free money, zero downside, hard game logic |
| **G3** | Block UPGRADE during initialBuild | Hard game rule — upgrades illegal during initial build |
| **G8** | Movement budget enforcement | Silent physics check, no strategic override |

### Remove

| Guardrail | What | Why remove |
|-----------|------|------------|
| **G2** | Force PICKUP when at supply city | LLM gets `canPickup` in context — it should decide. Caused G2→G5 death spiral. Feasibility filter (bestPickups) added complexity without fully solving it. |
| **G4** | No passing with loads | Fights with G5. Path computation fallback produced empty paths (JIRA-24 Bug 6). If LLM passes with loads, fix the prompt, not the plan. |
| **G5** | Drop undeliverable loads | Overrides DiscardHand. Kills speculative pickups (valid strategy). Too aggressive — "delivery unreachable" uses `trackCost > money` but bot may earn money later. |
| **G6** | Escape hatch (5 stuck turns) | Counter never increments (only counts PassTurn, not stuck loops). Even if it fired, forcing PassTurn accomplishes nothing. |
| **G7** | Strategic discard (3 stuck turns) | Same broken counter. Never fires in real stuck scenarios. |
| **Post-guardrail** | No PassTurn with loads (AIStrategyEngine) | Duplicate of G4. Calls heuristic fallback which may produce conflicting actions. |

### Replace with: progress-based stuck detection

Instead of the broken `consecutivePassTurns` counter, track **actual progress**:

```
noProgressTurns: number of consecutive turns with:
  - zero deliveries
  - zero net cash increase
  - no new cities connected
```

When `noProgressTurns >= 3`, force DiscardHand (not PassTurn). This catches the pickup→drop oscillation, the 0M death spiral, and any other stuck pattern — without needing G2/G4/G5/G6/G7.

## Files

| File | Changes |
|------|---------|
| `src/server/services/ai/GuardrailEnforcer.ts` | Remove G2, G4, G5, G6, G7. Keep G1, G3, G8. Add progress-based stuck detection. |
| `src/server/services/ai/AIStrategyEngine.ts` | Remove post-guardrail safety (lines 324-344). Replace `consecutivePassTurns` with `noProgressTurns` counter. Update memory patch logic. |
| `src/server/__tests__/ai/GuardrailEnforcer.test.ts` | Remove tests for deleted guardrails. Add tests for progress-based stuck detection. |

## Impact on Unimplemented Tickets (JIRA-33 to JIRA-41)

| Ticket | Impact | Detail |
|--------|--------|--------|
| **JIRA-33** (demand scoring turn discount) | None | Changes `ContextBuilder.ts` scoring formula. Unrelated to guardrails. |
| **JIRA-34** (ferry-aware track cost) | None | Changes `estimateTrackCost()` in `ContextBuilder.ts`. Unrelated to guardrails. |
| **JIRA-35** (game analysis) | Superseded | Already marked superseded. Bugs 1, 2, 4 are guardrail-related and would be resolved by this overhaul. |
| **JIRA-36** (animated bot movement) | None | Client-side animation + `bot:turn-complete` payload. Unrelated to guardrails. |
| **JIRA-37** (LLM plan vs execution) | Partially resolved | Bug 2 (DropLoad consumes turn) is a TurnComposer issue, not guardrail. Bug 1 (same-city multi-pickup) is PlanExecutor, not guardrail. Bug 3 (demand scoring) is ContextBuilder. No direct overlap, but removing G5 means speculative pickups won't be force-dropped (which aligns with the finding that speculative pickups are valid strategy). |
| **JIRA-38** (same-city multi-pickup) | None | PlanExecutor/TurnComposer fix. Unrelated to guardrails. |
| **JIRA-39** (DropLoad consumes turn) | **Simplified** | With G5 removed, the primary source of forced DropLoad plans disappears. The TurnComposer fix (compose DropLoad as prefix, not terminal) is still needed for cases where the LLM *chooses* to drop, but the most common trigger (G5 force-drop) goes away. Fewer occurrences to handle. |
| **JIRA-40** (demand scoring overvalues cross-map) | **Synergy** | Better `estimateTrackCost()` means the LLM makes better demand choices. With G2/G5 removed, the LLM's demand selection matters more — inaccurate scoring has a bigger impact. Fixing JIRA-40 becomes higher priority after this overhaul. |
| **JIRA-41** (debug overlay stale ranking) | None | Client-side rendering bug. Unrelated to guardrails. |

## Implementation Order

1. **This ticket first** — removes the guardrail conflicts that cause death spirals
2. **JIRA-40** next — with guardrails removed, demand scoring accuracy becomes critical
3. **JIRA-39** then — fewer forced DropLoads but LLM-chosen drops still need prefix composition
4. **JIRA-33, JIRA-34** — scoring refinements that improve LLM decision quality
5. **JIRA-38** — PlanExecutor fix independent of guardrails
