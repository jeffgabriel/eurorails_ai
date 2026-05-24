# JIRA-55: LLM Never Outputs UPGRADE — Prompt & Context Gaps

**Severity:** Medium
**Source:** Games `2d3d214b`, `aaf1bb82`, `a5766427` — all bots (same evidence as JIRA-53)
**Related:** JIRA-53 (botNeverUpgradesTrain), JIRA-29

## Problem

The LLM pipeline fully supports UPGRADE (schema, ActionResolver, TurnExecutor, system prompt), but bots never output the action. The infrastructure is dead code in practice. The root cause is in how the prompt presents upgrades to the LLM, not in missing plumbing.

### Why the LLM ignores UPGRADE

1. **UPGRADE competes with operational actions, not BUILD.** The LLM outputs a primary action (MOVE, DELIVER, BUILD, etc.). When the bot has loads to deliver or cities to reach, UPGRADE always loses to MOVE/DELIVER. The LLM doesn't realize TurnComposer handles the operational phase separately — it thinks choosing UPGRADE means forfeiting movement that turn.

2. **Upgrade advice is buried and informational.** The `UPGRADE ADVICE:` line appears near the bottom of the serialized prompt after reachable cities. It reads as background info ("you can afford...") rather than a concrete action recommendation.

3. **No multi-action examples include UPGRADE.** The system prompt's multi-action examples are all `MOVE + PICKUP + DELIVER + BUILD` patterns. There is no `MOVE + DELIVER + UPGRADE` example, so the LLM never learns that combining operational actions with UPGRADE is valid and expected.

## Fix: Three-Part LLM-Centric Approach

### A. Teach UPGRADE as a Phase B action in multi-action examples

In `src/server/services/ai/prompts/systemPrompts.ts`, add UPGRADE multi-action examples alongside the existing BUILD examples (~line 34-40):

```
- MOVE to demand city -> DELIVER for payout -> UPGRADE train (20M, replaces BUILD this turn)
- PICKUP at current city -> MOVE toward delivery -> UPGRADE (when speed/cargo matters more than track)
```

Also update the constraint line (line 40) to clarify the mutual exclusivity:
```
UPGRADE replaces BUILD for this turn's Phase B (you still MOVE, PICKUP, DELIVER normally).
You CANNOT combine UPGRADE + BUILD, or DISCARD_HAND with anything.
```

### B. Make upgrade recommendations actionable in the serialized prompt

In `src/server/services/ai/ContextBuilder.ts` (`serializePrompt`, ~line 786-791), change the upgrade advice from informational to directive when conditions are strongly met:

Instead of:
```
UPGRADE ADVICE: You can afford an upgrade (20M). Fast Freight for speed...
```

Emit:
```
RECOMMENDED PHASE B ACTION: UPGRADE to FastFreight — {"action": "UPGRADE", "details": {"to": "FastFreight"}}
You've been on Freight for 15 turns. +3 speed saves ~1 turn per delivery (estimated 3-5 turns saved over remaining game).
This is more valuable than building track this turn.
```

When conditions are NOT strongly met but upgrade is available, keep the current advisory tone.

### C. Add upgrade ROI data to context

Enrich `computeUpgradeAdvice` in `ContextBuilder.ts` (~line 1277) with quantitative data:

- **Turns saved per delivery** with Fast Freight: compute from average route length (active route stops or demand distances). If avg route > 15 mileposts, Fast Freight saves ~1 turn per delivery.
- **Extra payout potential** from Heavy Freight: count how many current demands have multi-pickup opportunities at the same city or along the same corridor.
- **Build comparison**: check whether a meaningful build target exists this turn. If no route-critical build target and budget < 5M useful track, explicitly say "no high-value build target this turn — UPGRADE is better value."

This gives the LLM quantitative trade-off data rather than generic advice.

### D. (Optional) Strong nudge for extreme cases

For egregious situations (Freight at turn 15+ with 60M+ cash), prepend a high-priority directive at the TOP of the prompt context:

```
STRONG RECOMMENDATION: You are still on Freight at turn {N}. UPGRADE to FastFreight this turn.
Every turn on Freight costs you ~3 mileposts of wasted movement. Output UPGRADE as your Phase B action.
```

This makes it very difficult for the LLM to ignore while still technically leaving the decision to it.

## Files

- `src/server/services/ai/prompts/systemPrompts.ts` — multi-action examples, UPGRADE teaching (Part A)
- `src/server/services/ai/ContextBuilder.ts` — `serializePrompt()` upgrade section, `computeUpgradeAdvice()` ROI enrichment (Parts B & C)
- `src/server/services/ai/schemas.ts` — no changes needed (UPGRADE already in schema)
- `src/server/services/ai/ActionResolver.ts` — no changes needed (resolveUpgrade already works)
- `src/server/services/ai/TurnComposer.ts` — no changes needed (already skips Phase B build when UPGRADE present)

### E. Initial build: teach LLM to choose starting city

During initial build (turns 1-2), the route planning prompt tells the LLM `"Position: Not placed"` and `"PHASE: Initial Build"` but never explains that the bot can start at any major city, or that this choice is coupled with the first delivery. The LLM has demand rankings and corridors but no guidance on where to place the train.

In `src/server/services/ai/ContextBuilder.ts` (`serializeRoutePlanningPrompt`, ~line 940), add a STARTING CITY section when phase is initial build:

```
STARTING CITY: You will place your train at any major city before moving.
Choose your starting city AND first delivery together:
- Start at or near a supply city so you can pick up immediately on turn 3
- Prefer demands where supply→delivery is short and affordable within 40M total budget
- A demand with supply at a major city lets you start there and pick up without traveling
```

This closes the gap where the LLM sometimes builds toward a delivery city instead of a supply city (related: JIRA-43).

## Acceptance Criteria

- [ ] LLM outputs UPGRADE action in at least 1 of 3 test games when conditions are met (Freight at turn 8+, cash >= 30M)
- [ ] Multi-action turns with UPGRADE work end-to-end: e.g., MOVE + DELIVER + UPGRADE resolves and executes correctly
- [ ] Upgrade advice in prompt includes ROI comparison against available build targets
- [ ] No regression in build behavior — bots still build track when upgrade is not warranted
- [ ] Initial build prompt includes STARTING CITY guidance — LLM chooses supply-side major city as starting point
