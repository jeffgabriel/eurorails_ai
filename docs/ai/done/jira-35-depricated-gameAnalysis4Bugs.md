# JIRA-35: Game Analysis — 4 Bugs Found in Game 85a69b96

**Status: SUPERSEDED** — All bugs have been moved to individual tickets or identified as duplicates:
- Bug 1 (cash reserves) → duplicate of JIRA-30 Bug 1 / JIRA-25 Bug 1
- Bug 2 (DiscardHand overridden) → resolved by **JIRA-42** (guardrail overhaul removes G5 which overrides DiscardHand)
- Bug 3 (debug overlay stale) → moved to **JIRA-41**
- Bug 4 (Haiku LLM fails) → duplicate of JIRA-30; death spiral component resolved by **JIRA-42**

Analysis of game `85a69b96-b825-4b07-9b27-13a913aebe4a` (Haiku vs Flash, 49 turns) using JIRA-32 NDJSON game log.

---

## Bug 1: Demand Scoring Ignores Cash Reserves — Bot Bankrupts Itself

**Severity:** High

**Evidence:** At T14, haiku has $11 and commits to Cattle Bern→Kobenhavn (28M payout). Demand scoring shows `trackCostToDelivery=11M` — the bot's entire cash reserve. It spends every dollar building toward Kobenhavn (T14-T18), hits $0 by T25, and never recovers.

**Root cause:** `efficiencyPerTurn=3.0M/t` looks attractive, but the scoring doesn't penalize demands where `trackCost >= cash`. A route costing $11 when you have $11 is treated the same as a route costing $11 when you have $50. The `isAffordable` field exists in `DemandContext` but doesn't weight the score enough to prevent selection.

**Fix:** Apply a multiplier penalty to `demandScore` when build cost exceeds a cash threshold. DemandContext scoring should heavily penalize demands where `estimatedTrackCostToSupply + estimatedTrackCostToDelivery > cash * 0.7`.

**Files:** `src/server/services/ai/ContextBuilder.ts` (demand scoring calculation)

---

## Bug 2: DiscardHand Overridden by Guardrails — Death Spiral

**Severity:** High

**Evidence:** At T20 and T22, the heuristic fallback correctly produces `DiscardHand` (visible in composition trace: `inputPlan: ['DiscardHand']`, `outputPlan: ['DiscardHand']`). But the **logged action is `DropLoad`**, not `DiscardHand`. Something between TurnComposer output and execution converts DiscardHand to DropLoad.

From T20 onwards, haiku enters a death spiral: pickup → drop → pickup → drop, endlessly for 30 turns. The heuristic picks up loads (priority chain says pickup), next turn can't do anything useful so heuristic says discard, but guardrails override to drop, then next turn it picks up again...

**Root cause:** Most likely the GuardrailEnforcer or the post-guardrail "never PassTurn while carrying loads" safety check is overriding DiscardHand because the bot is carrying loads. The guardrail forces a DropLoad instead of allowing the discard.

**Files:** `src/server/services/ai/GuardrailEnforcer.ts`, `src/server/services/ai/ActionResolver.ts` (heuristicFallback)

---

## Bug 3: Debug Overlay Demand Ranking Out of Sync with Player Hand (~T22)

**Severity:** Medium

**Evidence:** Flash player's demand ranking in the NDJSON log is identical across T19-T23 (9 items, same scores). This is correct server-side — no new demand card was drawn, so the ranking shouldn't change. The ranking only updates at T24 after the Steel@Venezia delivery at T23 (which triggers a new card draw).

The server-side `demandRanking` in `bot:turn-complete` has 9 items (3 cards × 3 demands each). If the debug overlay shows different cards than what's in the ranking, the issue is client-side: the overlay may not re-render when the same ranking repeats, or may hold stale state from a previous emission.

**Fix:** Investigate client-side `DebugOverlay.ts` rendering — check whether:
- The overlay re-renders on every `bot:turn-complete` emission even when data is identical
- State is correctly reset between turns
- Card count matches between overlay display and `demandRanking` array

**Files:** `src/client/components/DebugOverlay.ts`

---

## Bug 4: Haiku Plays Far Worse Than Flash — Model Quality + Fallback Spiral

**Severity:** High

**Evidence:**

| Metric | Flash (Sonnet) | Haiku |
|--------|---------------|-------|
| Deliveries | Multiple (T14, T23, T29, T32, T38, T46...) | Zero deliveries entire game |
| Cash at T49 | $60 | $0 |
| Model | `route-planned` / `route-executor` (LLM routes work) | `heuristic-fallback` from T20 onwards |
| Route quality | Multi-stop efficient routes (4-5 stops) | Single 2-stop routes that bankrupt |
| Movement waste | 0 wasted most turns | 7-9 wasted most turns |

**Root causes:**

1. **Haiku LLM fails from T20 onwards** — every turn shows `model=heuristic-fallback` with "LLM planning failed". Zero `llmLog` attempts recorded (empty array), meaning the LLM call itself is failing before producing a response. Haiku can't produce valid route plans, so it falls into the heuristic pickup→drop death spiral (Bug 2).

2. **Flash picks efficient multi-stop routes** — chains pickups and deliveries along existing track. Delivers Steel at T14, again at T23, and keeps cash flowing. Routes are 3-5 stops long, maximizing each trip.

3. **Movement utilization** — Flash uses all 9 mileposts nearly every turn (`wasted=0`). Haiku wastes 7-9 mileposts on most turns because it's stuck doing BuildTrack with no movement phase (A3 never finds a useful move target because the bot is bankrupt with no viable demands).

**Fix:**
- Investigate why Haiku's LLM calls fail entirely from T20 (no attempts logged) — may be a schema/prompt issue specific to Haiku's smaller context window, or an API error that isn't being captured
- Increase `maxRetries` for Haiku model, or use a more forgiving prompt/schema
- The heuristic fallback priority chain needs the stuck detector from Bug 2

**Files:** `src/server/services/ai/LLMStrategyBrain.ts` (retry/fallback logic), `src/server/services/ai/providers/AnthropicAdapter.ts` (Haiku-specific handling)

---

## Summary

| Bug | Description | Priority | Fix Location |
|-----|-------------|----------|-------------|
| 1 | Demand scoring ignores cash reserves → bankruptcy | High | `ContextBuilder.ts` |
| 2 | DiscardHand overridden when carrying loads → death spiral | High | `GuardrailEnforcer.ts`, `ActionResolver.ts` |
| 3 | Debug overlay demand ranking stale on client | Medium | `DebugOverlay.ts` |
| 4 | Haiku LLM fails → heuristic fallback spiral | High | `LLMStrategyBrain.ts`, `AnthropicAdapter.ts` |

**Note:** A 5th bug (ferry-blind track cost estimation) was captured separately in JIRA-34.
