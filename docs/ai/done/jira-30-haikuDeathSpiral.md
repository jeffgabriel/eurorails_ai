# JIRA-30: Haiku Death Spiral — Spends to 0M, LLM Fails Silently, No Recovery

Game: `349b824f-586b-4456-9ad3-0a9d98d102bd` (bots: Haiku blue/claude-haiku, Flash green/gemini-3-flash)

---

## Implementation Status

| Bug | Status | Implemented In | Notes |
|-----|--------|---------------|-------|
| Bug 1 (Critical) | Deferred | → Project A | Build budget vs ROI; overlaps JIRA-25 Bug 1. User veto: NO cash reserve enforcement |
| Bug 2 (Critical) | Deferred | → Project A | 0M recovery (deliver on existing track or discard); = JIRA-25 Bug 6 |
| Bug 3 (High) | Duplicate | = JIRA-26 | Demand scoring favors low-cost over high-value |
| Bug 4 (Medium) | Duplicate | = JIRA-25 Bug 2 | Guardrail pickup-drop loop; fixed in Compounds `025751be` Task 1 |
| Bug 5 (Low) | Deferred | → Project A | LLM plans unaffordable routes; addressed by context enrichment |
| Bug 6 (High) | Deferred | → Project A | Strategic hand discard at any cash level; overlaps JIRA-28 Phase 3 |

---

## What Happened

Haiku delivered Wheat→Roma for 20M on turn 12, going from 1M to 21M. In the same turn, it immediately spent 20M building 16 segments eastward into the mountains — ending at 1M. On turn 13 the heuristic spent the last 1M on one more segment. From turn 13 onward, Haiku has 0M, no loads, and the LLM fails every turn. It has been stuck for 5+ consecutive turns with no recovery path.

Flash experienced the guardrail pickup-drop loop (JIRA-24/25 pattern) at turn 8-9 but recovered and is now executing a viable multi-stop route.

---

## Haiku Financial Timeline

| Turn | Action | Money After | Notes |
|------|--------|------------|-------|
| Start | — | 50M | — |
| 2 | Build toward Bruxelles+Torino | 43M | 7M build, 5 segments |
| 3 | Build toward Torino | 23M | 20M build, 14 segments through mountains |
| 4-6 | Pickup Chocolate@Bruxelles → Deliver@Torino | 31M | +8M delivery, -5M build |
| 7 | Build toward Lyon | 20M | 6M build |
| 8 | Build Lyon→Roma corridor | 1M | **19M on 14 segments — 20M to 1M** |
| 9-12 | Pickup Wheat@Lyon → Deliver@Roma | 21M | +20M delivery |
| 12 | **Build 16 segments east** | 1M | **Immediately blew 20M on speculative track** |
| 13 | Heuristic builds 1 segment | 0M | Last 1M gone |
| 14-17 | Heuristic fallback MoveTrain | 0M | **Stuck — LLM fails every turn** |

Total track: 57 segments, 78M invested. Started with 50M + earned 28M (8+20) = 78M. Every penny went to track.

---

## Haiku's Hand (while stuck)

- Card 134: Ham→Torino 29M, Fish→Bilbao 12M, Chocolate→Newcastle 21M
- Card 69: Copper→Milano 20M, Iron→Warszawa 8M, Bauxite→Newcastle 35M
- Card 127: Machinery→Manchester 18M, Wheat→Stockholm 46M, Oil→Kaliningrad 27M

The turn-12 eastward build (42,46)→(54,47) appears to target Warszawa (Iron, 8M) — the **lowest value demand** on any card. Meanwhile Bauxite→Newcastle (35M) and Wheat→Stockholm (46M) are ignored.

---

## Flash Timeline (for comparison)

| Turn | Action | Money After | Notes |
|------|--------|------------|-------|
| Start | — | 50M | — |
| 2-3 | Build Ruhr→Venezia | 19M | 31M build |
| 4-5 | Steel@Ruhr→Venezia | 23M | +19M delivery, -15M build |
| 6-7 | Re-plan, move to Frankfurt | 20M | |
| 8 | **Stockholm unreachable (45M build, 20M budget)** | 20M | Guardrail forces Beer pickup |
| 9 | **Guardrail drops Beer** | 20M | JIRA-24/25 pattern, 1 wasted turn |
| 9-12 | Build to Lyon, pickup Wheat | 4M | |
| 13-14 | Deliver Wheat@Luxembourg | 14M | +10M |
| 15-17 | Cars@Stuttgart→Ruhr→Bruxelles route | 7M | Active, recovering |

Flash recovered from the guardrail loop and is executing a viable plan. Haiku did not recover.

---

## Bug 1 (Critical): Bot spends 100% of delivery proceeds on speculative track

Haiku's pattern on both deliveries:
- Turn 8: Had 20M after earning, spent 19M on build, left with 1M
- Turn 12: Had 21M after earning, spent 20M on build, left with 1M

The bot treats every delivery as a building opportunity and spends to the floor. There is no financial discipline — no concept of keeping reserves for track usage fees, no evaluation of whether the build target justifies spending all available cash.

The turn-12 build is especially wasteful: 16 segments into eastern Europe mountains toward Warszawa (8M payout), when the bot's hand contains 35M and 46M demands in other directions.

**What should happen:** The build budget should account for whether the bot can actually *use* the track it builds. Spending 20M on track toward an 8M delivery is net negative. The pipeline should either cap builds that cost more than the target payout or prefer routes where the build investment pays off within 1-2 deliveries.

---

## Bug 2 (Critical): LLM planning fails silently at 0M — no recovery mechanism

From turn 13 onward, the audit shows "heuristic-fallback" every turn with "LLM planning failed — heuristic produced MoveTrain". The bot moves aimlessly with no loads and no money for 5+ consecutive turns.

The audit doesn't log the actual LLM error, so we can't see *why* planning fails. Likely causes:
- ContextBuilder marks every demand as infeasible because estimated build cost exceeds 0M budget
- The LLM receives a context where nothing is affordable and returns an invalid/empty plan
- PlanValidator rejects every plan because the bot can't afford any action

**At 0M the bot has exactly two viable strategies:**

1. **Find a delivery on existing track.** The bot has 57 segments of track. If any demand on its cards can be fulfilled using cities already connected to its network, the bot can move there, pick up, deliver, and earn money without spending anything. At 0M the bot can't build — it can only use what it already has.

2. **Discard hand and draw 3 new cards.** If no demand is deliverable on existing track, the rules allow discarding the entire hand and drawing 3 new cards. This costs nothing and gives the bot a chance at demands that match its existing network.

Neither strategy requires money. But the pipeline doesn't surface these options — it tries to plan a route that includes building, fails because budget is 0, and falls back to a heuristic that just moves the train randomly.

**What should happen:** When budget is 0M, the pipeline should:
1. Check if any demand is completable using only existing track (no build required)
2. If yes, plan a move→pickup→deliver route on existing track
3. If no, discard the hand and draw new cards
4. Never fall back to aimless MoveTrain — that accomplishes nothing

---

## Bug 6 (High): Bot never discards hand at ANY cash level — structural gap

The 0M discard case (Bug 2) is actually a specific instance of a broader problem: **the bot never strategically discards its hand, regardless of cash level.** Even with 80M and a terrible hand (all demands pointing to unbuilt peripheral regions), the bot will stubbornly build toward the cheapest demand rather than spend 1 turn discarding for 3 fresh cards.

### Why it never discards — same pattern as JIRA-29 (upgrades)

Discarding can only happen through 3 paths, all of which are too narrow:

**Path 1: LLM primary action.** The LLM must choose `DISCARD_HAND` instead of MOVE, DELIVER, PICKUP, BUILD. But the LLM always finds *something* operational to do — there's always a city to move toward or track to build. Discarding competes against actions with immediate visible progress, so it loses every time.

**Path 2: Heuristic fallback** (`ActionResolver.ts` line 906-918). Only discards when **every** demand has `supplyCost + deliveryCost > budget`. This is a raw affordability check — a demand that costs 15M to reach but pays only 8M over 6 turns is seen as "achievable" and blocks the discard. The heuristic doesn't evaluate strategic quality, only binary affordability.

**Path 3: Guardrail 7** (`GuardrailEnforcer.ts` line 63). Forces discard after **3 consecutive stuck turns**. This is a last-resort escape hatch, not strategic play. By the time this fires, the bot has already wasted 3 turns.

### When a human player would discard (but the bot doesn't)

- **2+ cards point to regions far from existing track** — even if technically affordable, the build investment dwarfs the payout
- **Best demand takes 8+ turns** to complete — spending 1 turn to redraw is almost certainly better
- **Just delivered and the replacement card is terrible** — the new card's demands are all peripheral/low-value
- **Holding demands for rare resources in unreachable cities** (see JIRA-28) — e.g., Hops→Cardiff when bot has no England track and no plans to go there
- **Hand quality is poor relative to network** — bot has 40+ segments of track in central Europe but all 3 cards point to Iberia, Scandinavia, and the Balkans

### What's missing: strategic discard evaluation

The pipeline needs a "hand quality" assessment that runs before or alongside the LLM decision:

```
handQuality = average(bestDemandScorePerCard)

if (handQuality < DISCARD_THRESHOLD) {
  // Compare: 1 lost turn (discard) vs estimated turns for best current demand
  if (bestDemandEstimatedTurns >= TURNS_THRESHOLD) {
    return { action: 'DISCARD_HAND' };
  }
}
```

This should consider:
- `scoreDemand()` already computes per-demand scores — use the best score per card
- If the best score across all 3 cards is below a threshold, the hand is bad
- If the best demand would take 8+ turns to complete (including build time), discarding saves time
- Weight the decision against turn number — early game has more value in discarding (more time to recover), late game the cost is higher

### Haiku's hand in this game illustrates the problem

At turn 12 (21M cash), Haiku held:
- Card 134: Ham→Torino 29M — requires Warszawa track (Ham source) + Torino already connected. ~15M build, good.
- Card 69: Iron→Warszawa 8M — terrible ROI (8M payout for eastern mountain build). Copper→Milano 20M moderate.
- Card 127: Wheat→Stockholm 46M — massive payout but requires Nordic track. Oil→Kaliningrad 27M same problem.

This is a mediocre hand — one decent demand (Ham→Torino) and two cards pointing to expensive unbuilt regions. A human might keep playing for Ham→Torino but would be thinking about discarding if that delivery doesn't open new corridors. The bot instead built 20M of mountain track toward the 8M Iron→Warszawa demand.

### Relationship to other JIRAs

- **JIRA-29** (bot never upgrades): Same structural pattern — action must be LLM's primary choice, competing against operations it can never beat
- **JIRA-28** (demand difficulty): Supply rarity awareness would improve the hand quality assessment — a hand full of rare-resource demands in unreachable cities is even worse than the raw score suggests
- **Bug 2 above** (0M recovery): The 0M discard is the extreme case; strategic discarding at higher cash levels would prevent reaching 0M in the first place

---

## Bug 3 (High): First delivery picked lowest-value demand (8M)

Haiku's turn 2 reasoning: "Chocolate→Torino (8M payout) is the only demand that doesn't hemorrhage capital."

The LLM chose the cheapest-to-reach delivery (8M) over higher-value options. This is the same class of bug as JIRA-26 — the scoring pipeline favors low immediate cost over route value. An 8M delivery barely covers the build cost, leaving the bot in a worse strategic position than a higher-payout route that costs more upfront but generates real profit.

---

## Bug 4 (Medium): Guardrail pickup-drop loop (Flash, turns 8-9)

Same pattern as JIRA-24/25. Flash's LLM planned a route to Stockholm (45M build) with only 20M. PlanExecutor rejected the route, guardrail forced a Beer pickup at Frankfurt, next turn guardrail dropped Beer as undeliverable. One wasted turn.

Flash recovered; this is a known issue tracked in JIRA-24/25.

---

## Bug 5 (Low): LLM plans unaffordable routes

Flash planned a Stockholm route requiring 45M build with only 20M available. The LLM should not propose routes where estimated build cost exceeds 2× available budget. This wastes an LLM call and triggers the guardrail cascade.

---

## Suggested Fixes

### Fix for Bug 1: Build budget proportional to expected return

Before spending on track, evaluate whether the build investment has a positive ROI within 1-2 deliveries. If spending 20M on track to reach an 8M delivery, the pipeline should prefer a different demand or build less.

Cap the build spend at `min(20M, targetPayout - minimumCashReserve)` to prevent the bot from spending more on track than it will earn.

### Fix for Bug 2: 0M recovery strategy

Add a 0M-specific decision path in the pipeline:

```
if (money === 0 && loads.length === 0) {
  // Step 1: Check if any demand is completable on existing track
  const deliverableOnNetwork = findDeliverableOnExistingTrack(hand, trackNetwork);
  if (deliverableOnNetwork) {
    return planMovePickupDeliver(deliverableOnNetwork);
  }

  // Step 2: Discard hand and draw new cards
  return { action: 'DiscardHand' };
}
```

This should run *before* the LLM planning step, since the LLM consistently fails at 0M anyway.

### Fix for Bug 6: Strategic hand discard evaluation

Add a hand quality assessment that runs before or alongside the LLM decision. Use the existing `scoreDemand()` output:

```
// Compute hand quality = average of best demand score per card
const bestScorePerCard = cards.map(card =>
  Math.max(...card.demands.map(d => scoreDemand(d)))
);
const handQuality = avg(bestScorePerCard);
const bestEstimatedTurns = Math.min(...demands.map(d => d.estimatedTurns));

// If hand quality is poor AND best demand is slow, discard
if (handQuality < DISCARD_THRESHOLD && bestEstimatedTurns >= 8) {
  return { action: 'DISCARD_HAND' };
}
```

Implementation options:
1. **Pre-LLM gate in AIStrategyEngine** — cheapest, catches obvious bad hands before burning an LLM call
2. **Enrich LLM context with hand quality score** — let the LLM decide, but give it the data ("HAND QUALITY: Poor — best demand takes 9 turns. Consider DISCARD_HAND.")
3. **Heuristic fallback enhancement** — expand the existing discard check (line 906-918) from raw affordability to strategic quality

Option 2 is preferred — it leverages the LLM's reasoning while giving it information it currently lacks.

### Fix for Bug 3: Weight demand scoring by payout

See JIRA-26 for the full proposal. The scoring formula should scale corridor bonuses relative to payout so that high-value demands aren't penalized for higher build costs.

---

## Summary

| # | Severity | Bug | Bot | Impact |
|---|----------|-----|-----|--------|
| 1 | Critical | Spends 100% of delivery proceeds on speculative track, leaves 0M | Haiku | Death spiral — no money for operations |
| 2 | Critical | LLM fails silently at 0M, no recovery — should find delivery on existing track or discard hand | Haiku | Permanent stuck state for 5+ turns |
| 3 | High | First delivery picked 8M payout over higher-value options (JIRA-26 class) | Haiku | Early economic disadvantage |
| 4 | Medium | Guardrail pickup-drop loop when route exceeds budget (JIRA-24/25) | Flash | 1 wasted turn |
| 5 | Low | LLM plans 45M route with 20M budget | Flash | Wasted LLM call, triggers guardrail |
| 6 | High | Bot never strategically discards hand at any cash level — same structural gap as JIRA-29 (upgrades) | All | Stubbornly plays bad hands for 8+ turns instead of spending 1 turn to redraw |
