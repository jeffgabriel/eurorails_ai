# JIRA-37: LLM Plan vs Execution Gaps — Game 1c8c8f55

Analysis of game `1c8c8f55-85a5-4dba-a195-01c669002646` (Haiku vs Flash, 110 turns) comparing LLM strategic plans against what the route-executor actually executed.

---

## Bug 1: Same-City Multi-Pickup Ignored by Route-Executor

**Severity:** High

**Evidence — Flash T84-T93 (Iron + Steel at Birmingham):**

LLM plan at T84:
> `pickup(Iron@Birmingham) → pickup(Steel@Birmingham) → deliver(Iron@Antwerpen) → deliver(Steel@Budapest)`

The LLM correctly planned to pick up both Iron and Steel at Birmingham — two different loads at the same city, one trip. The Freight train carries 2 loads so this is perfectly valid.

| Turn | What happened |
|------|--------------|
| T90 | Arrives at Birmingham, picks up **Iron only** |
| T91 | **Departs Birmingham** (moved 5mp, wasted 4) |
| T92 | Moves 2mp, wastes 7 — appears to turn around |
| T93 | **Returns to Birmingham**, picks up Steel |

The bot picked up one load, left the city, then came back for the second. **3 turns and ~13 mileposts wasted.**

**Evidence — Flash T17-T21 (Ham x2 at Warszawa):**

LLM plan at T17:
> `pickup(Ham@Warszawa) → pickup(Ham@Warszawa) → deliver(Ham@Zagreb)`

The LLM correctly planned to pick up two copies of Ham at Warszawa (game rules allow picking up multiple loads of the same type). The bot picked up only one Ham at T17 and moved on. The second pickup was never executed.

**Root cause:** The PlanExecutor processes stops sequentially. After completing stop 0 (first pickup), it advances to stop 1 (second pickup at same city) and issues a `MoveTrain` toward the city it's already standing in. The TurnComposer's A1 opportunity scanner only checks cities along the movement path, not the current city for pending route stops.

**Fix:** When PlanExecutor advances to the next stop and the target is the **current city**, execute the pickup/delivery immediately in the same turn without issuing MoveTrain. Alternatively, after any pickup action, check if the next route stop is at the same city and chain it.

**Files:** `src/server/services/ai/TurnComposer.ts` (A1 opportunity scanner), `src/server/services/ai/LLMStrategyBrain.ts` (PlanExecutor stop advancement)

---

## Bug 2: DropLoad Consumes an Entire Turn

**Severity:** High

**Evidence — Flash T46:**

Plan: `pickup(Ham@Warszawa) → pickup(Flowers@Holland) → deliver(Flowers@Oslo) → deliver(Ham@Paris)`

At T39, the bot speculatively picks up Cheese at Holland en route to Warszawa. Carrying it is free (dead weight, good strategy). At T43 it picks up Ham at Warszawa — train now full (Ham + Cheese, 2/2). It returns to Holland at T46 to pick up Flowers (stop 1), but the train is full.

T46: `action=DropLoad, outputPlan=['DropLoad']` — the **entire turn** is consumed by the drop. No movement, no pickup, nothing else.
T47: Picks up Flowers at Holland.

Per game rules, dropping a load at a city is free — it does not reduce movement, does not end the turn. The bot should have dropped Cheese and picked up Flowers in the same turn at T46. Instead, the TurnComposer produced `['DropLoad']` as the complete plan, wasting an entire turn.

**Evidence — Flash T86:**

Plan: `pickup(Iron@Birmingham) → pickup(Steel@Birmingham) → deliver(Iron@Antwerpen) → deliver(Steel@Budapest)`

At T80, the bot speculatively picks up Beer at Praha. At T86, the guardrail drops Beer as undeliverable: `action=DropLoad, outputPlan=['MoveTrain']`. The drop consumed the turn — no actual movement happened (`moved=` empty, `wasted=0`). In this case the bot wasn't at the pickup city yet, so the cost was lower, but the drop still blocked movement for that turn. **Note:** JIRA-42 removes G5 (force-drop undeliverable), so this specific trigger will no longer occur. The T46 case (LLM-chosen drop for full train) remains.

**Root cause:** When the PlanExecutor detects a full train at a pickup stop, it emits a standalone `DropLoad` plan. The TurnComposer treats DropLoad as a terminal action and doesn't compose further actions (pickup, movement) into the same turn. Per game rules, drop + pickup + movement should all happen in one turn.

**Fix:** TurnComposer should compose DropLoad as a prefix action, not a terminal one. When a pickup is blocked by a full train, the composition should be `[DropLoad, PickupLoad, MoveTrain, ...]` in a single turn plan.

**Files:** `src/server/services/ai/TurnComposer.ts` (DropLoad composition), `src/server/services/ai/LLMStrategyBrain.ts` (PlanExecutor full-train handling)

---

## Bug 3: Demand Scoring Overvalues Expensive Cross-Map Routes

**Severity:** High

**Evidence — Haiku T99-T110 demand ranking:**

| Rank | Load | Route | Payout | Score | Est. Turns | Est. Track Cost |
|------|------|-------|--------|-------|------------|----------------|
| #1 | Marble | Firenze→Stockholm | 55M | 11.5 | 8 | ? |
| #2 | Oranges | Sevilla→Zurich | 31M | 8.8 | 8 | ? |
| #3 | Tobacco | Napoli→Ruhr | 31M | 7.9 | 6 | 18M |

The LLM chose #3 Tobacco — the lowest-scored option — and it was still a disaster (12 turns building, $59M spent, never completed). But the real problem is that **all three options are probably bad** and the scoring doesn't reflect it:

- **Marble Firenze→Stockholm (55M, score 11.5, #1):** Scored highest because of the massive payout. But Firenze to Stockholm crosses most of Europe. The estimated 8 turns is almost certainly wrong — this route requires extensive track building through Scandinavia. The high payout exists precisely because the route is extremely difficult.

- **Oranges Sevilla→Zurich (31M, score 8.8, #2):** Sevilla is in southern Spain, far from any existing track. Building from the bot's network to Sevilla alone could cost $40M+.

- **Tobacco Napoli→Ruhr (31M, score 7.9, #3):** `estimateTrackCost` returned 18M but actual cost was $59M+ over 12 turns. The bot never even finished building.

The LLM actually made a reasonable choice picking the "cheapest" option. The bug is that `estimateTrackCost()` dramatically underestimates costs for long-distance routes, making all three look viable when none of them were. At T99 with $144M, the bot should have been running short profitable routes on its existing network, not committing to a 12-turn build project.

**Root cause:** `estimateTrackCost()` uses `hexDistance * 1.5M` which underestimates for:
1. Routes through mountains/alpine terrain (2-5M per milepost vs 1.5M average)
2. Routes requiring many turns of building at $20M/turn cap (the $20M/turn limit means a 40M route takes minimum 2 build turns, but the scoring only sees the dollar cost, not the turn cost)
3. Routes to distant cities where the hex distance understates the actual overland path (see JIRA-34 for the ferry-specific case)

**Files:** `src/server/services/ai/ContextBuilder.ts` (estimateTrackCost, demand scoring)

---

## Summary

| Bug | Description | Wasted Turns | Priority | Fix Location |
|-----|-------------|-------------|----------|-------------|
| 1 | Same-city multi-pickup ignored — bot leaves and returns | 3+ turns per occurrence | High | `TurnComposer.ts`, `LLMStrategyBrain.ts` PlanExecutor |
| 2 | DropLoad consumes entire turn instead of composing with pickup | 1 full turn wasted per occurrence | High | `TurnComposer.ts`, `LLMStrategyBrain.ts` PlanExecutor |
| 3 | Demand scoring overvalues expensive cross-map routes | 12 turns + $59M on Tobacco | High | `ContextBuilder.ts` (estimateTrackCost, demand scoring) |
