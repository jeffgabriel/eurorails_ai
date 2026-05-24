# PRD: Bot Strategic Intelligence — Financial Discipline, Demand Evaluation, and Recovery

**JIRAs:** 25 (remainder), 26, 28, 29, 30
**JIRA-27:** Already shipped (commit `1378c7f`). Excluded from this project.
**Predecessor:** Compounds project `025751be` (Bot Safety Nets) — fixed guardrail loops, pickup feasibility, dead-end segments.

---

## Problem Statement

The bot plays like a beginner who can see the board but can't think ahead. It spends every penny on track without checking if the investment pays off, picks the cheapest supply city instead of the most valuable route, never upgrades its train, never discards a bad hand, and has no recovery plan when it goes broke. These aren't edge cases — they happen every game and are the primary reason bots lose.

A competent human player does five things the bot cannot:

1. **Checks the math before building.** "This route costs 32M and I have 30M. I can't finish it — pick something else."
2. **Evaluates the whole route, not just the nearest supply city.** "Manchester is closer, but Stuttgart→Nantes passes through Paris and pays 20 points more."
3. **Upgrades the train when the economics make sense.** "I just delivered, I have 80M, I'm still on a Freight. Time to upgrade."
4. **Discards a bad hand.** "All three cards point to places I haven't built to. One turn to redraw beats eight turns chasing bad demands."
5. **Adapts when broke.** "I have 0M. What can I deliver on existing track? Nothing? Discard and redraw."

---

## Scope: What's Already Done

| JIRA | Bug | Status | Where |
|------|-----|--------|-------|
| 25-2 | Guardrail pickup-drop loop | Done | Compounds `025751be` BE-001 |
| 25-3 | Dead-end ocean segments | Done | Compounds `025751be` BE-003 |
| 25-5 | Pickup without feasibility check | Done | Compounds `025751be` BE-002 |
| 27 | Reduce thinking effort | Done | Commit `1378c7f` |
| 30-4 | Guardrail loop (Flash) | Done | = 25-2 |

---

## Behaviors to Implement

### Behavior 1: Build Budget Verification

**Source:** JIRA-25 Bugs 1+4, JIRA-30 Bug 1

**Current behavior:** The bot spends its full 20M build allowance every turn without checking whether the total multi-turn cost fits within its cash. Flash spent 30M across 3 turns building toward Oslo, ended up 2M short, and went permanently bankrupt. Haiku earned 21M from a delivery and immediately blew 20M on mountain track toward an 8M demand.

**Required behavior:** Before committing to a build target, verify the total estimated track cost is achievable with current or projected funds. If the bot can't afford to finish the route — and no imminent delivery will bridge the gap — pick a different target or build less.

**Rules:**
- If `estimatedTrackCost > bot.money` AND no in-progress delivery will cover the shortfall, the build target is **unaffordable** — do not build toward it
- A build target IS affordable if the bot is carrying a load whose delivery payout, combined with current cash, covers the remaining build cost. Example: bot has 10M, needs 25M of track, but is carrying Wheat for a 20M delivery en route — projected funds after delivery = 30M, so the build is viable
- Never spend more on track than the target delivery's payout (negative ROI builds are waste)
- After building, the bot should retain enough cash to pay track usage fees on its next move (minimum ~4M reserve for opponent track traversal)
- This is NOT a hard cash reserve cap (user veto — see CLAUDE.md). It's route selection intelligence: pick achievable routes, not artificially limit spending

**Acceptance:**
- Bot does not build toward demands where `estimatedTrackCost > bot.money + projectedDeliveryIncome`
- Bot DOES build toward demands that exceed current cash when an imminent delivery will fund the remainder
- Bot does not build toward demands where `trackCost > payout` (negative ROI)
- Bot does not drain to 0M on speculative builds when alternative demands exist

---

### Behavior 2: Evaluate All Supply Cities Per Demand

**Source:** JIRA-26 Bug 1

**Current behavior:** `findBestSupplyCity` picks the supply city closest to the bot's track. For Cars, it picks Manchester (4 hexes from London) over Stuttgart (8 hexes from Wien). The scoring never sees the Stuttgart→Nantes corridor (8 cities, 2 victory majors, score 45.8) because Manchester was locked in first (4 cities, 1 victory major, score 25.6).

**Required behavior:** For each demand, evaluate all supply cities and pick the one that maximizes the final demand score — not the one closest to existing track.

**Rules:**
- `computeDemandContext` should loop over all supply cities for the load type
- For each supply city, compute the full context (track cost, corridor value, ROI, score)
- Return the demand context with the highest `demandScore`
- The extra computation is bounded (max 4 supply cities per load type)

**Acceptance:**
- When multiple supply cities exist, the one producing the highest demand score is selected
- A supply city that costs more to reach but creates a better corridor can win over a cheaper one
- Existing tests pass; new tests cover multi-supply-city comparison

---

### Behavior 3: Scale Corridor Bonus by Payout

**Source:** JIRA-26 Bug 2

**Current behavior:** The corridor bonus is absolute: `networkCities × 3 + victoryMajorCities × 10`. A 21M delivery with 7 corridor cities and 2 victory majors (bonus: +41) beats a 51M delivery with 4 corridor cities and 1 victory major (bonus: +22), despite the 51M delivery being obviously better.

**Required behavior:** Corridor value should be a multiplier on economic value, not a flat addition. Good geography amplifies a good delivery — it shouldn't rescue a bad one.

**Rules:**
- Replace the absolute corridor bonus with a payout-relative multiplier
- The formula should ensure that a 30M payout advantage cannot be overcome by 3 extra corridor cities alone
- Victory major cities should still carry significant weight (they're the win condition)
- Early-game corridor value matters more than late-game (when track network is mostly built)

**Acceptance:**
- A 51M delivery with modest corridor beats a 21M delivery with great corridor
- Corridor value still differentiates between equally-priced demands
- Victory major city proximity remains a strong factor
- All existing scoring tests pass

---

### Behavior 4: Supply Rarity Awareness

**Source:** JIRA-28 Phase 1

**Current behavior:** The bot treats all loads as equally easy to find. Flowers (only from Holland) and Beer (from 4 central cities) get scored identically if the payout matches. The bot doesn't recognize that being near Cardiff with a Hops demand is a rare opportunity.

**Required behavior:** Each demand should include supply rarity information. When the bot is near a rare supply source, that demand should get a scoring boost.

**Rules:**
- Tag each demand with supply count and rarity: `UNIQUE SOURCE` (1 city), `LIMITED` (2 cities), `COMMON` (3-4 cities)
- When a rare supply city is on or near the bot's network (within ~3 hexes of track), apply an opportunity bonus to that demand's score
- When a rare supply city is far from the network, slightly penalize the demand (harder to fulfill)
- Include rarity tags and all source cities in the LLM context so it can reason about opportunities
- Add strategic guidance to the system prompt about rare supply opportunities

**Acceptance:**
- Each demand in LLM context shows supply count and rarity tag
- `scoreDemand` includes an opportunity bonus for rare loads near the bot's network
- System prompt includes supply rarity and detour opportunity guidance
- New tests cover: on-network rare source boost, off-network rare source penalty, common load unaffected

---

### Behavior 5: Train Upgrade in TurnComposer Phase B

**Source:** JIRA-29

**Current behavior:** Upgrades can only happen if the LLM chooses UPGRADE as its primary action. Since MOVE→DELIVER has immediate payoff and UPGRADE has deferred payoff, the LLM never picks it. TurnComposer Phase B only calls `tryAppendBuild()` — it never evaluates upgrade as an alternative.

**Required behavior:** After Phase A (operations) completes, Phase B should evaluate upgrade vs build and pick the better option.

**Rules:**
- Only consider upgrading when: bot can afford it (20M upgrade / 5M crossgrade), bot is not already Superfreight, bot has made at least 1 delivery, cash after upgrade ≥ 10M
- Prefer upgrade over build when: no high-value build target exists (tryAppendBuild returned null or < 5M of track), OR cash ≥ 60M (can upgrade and still build next turn), OR bot is still on Freight after turn 15
- Speed upgrade ROI: if average route is > 15 mileposts, Fast Freight saves ~1 turn per delivery
- Capacity upgrade ROI: if bot frequently has 3+ viable pickup opportunities, Heavy Freight earns an extra load per route
- Enrich the LLM context with specific upgrade path info: "Freight → Fast Freight (12 speed, 2 cargo) for 20M — you have 85M, upgrade leaves 65M"

**Acceptance:**
- TurnComposer Phase B evaluates upgrade as alternative to build
- Upgrade is preferred when no high-value build target exists and cash threshold is met
- Upgrade is never chosen before first delivery or when it would leave bot with < 10M
- LLM context shows specific upgrade path with stat changes and cost
- Bot upgrades at least once in a typical 30+ turn game
- All existing TurnComposer tests pass

---

### Behavior 6: Strategic Hand Discard

**Source:** JIRA-30 Bug 6, JIRA-28 Phase 3

**Current behavior:** The bot never discards its hand strategically. The only discard paths are: (a) LLM picks DISCARD as primary action (never happens — operational actions always win), (b) heuristic fallback when ALL demands are unaffordable (binary check, not quality assessment), (c) Guardrail 7 after 3 consecutive stuck turns (emergency escape, not strategy).

**Required behavior:** The bot should evaluate hand quality and discard when the hand is objectively poor relative to its network position.

**Rules:**
- Compute hand quality: average of best `demandScore` per card
- If hand quality is below a threshold AND the best demand would take 8+ estimated turns to complete, discard
- Track how many turns each demand card has been held; flag as `STALE` after 12 turns
- Include hand quality assessment and staleness in LLM context: "HAND QUALITY: Poor — best demand takes 9 turns. Consider DISCARD_HAND."
- Implement as LLM context enrichment (preferred) — let the LLM decide with better data, rather than hard-coding a gate

**Observability:**
- Hand quality score and per-card staleness must be visible in the DebugOverlay's bot turn section (alongside existing demand ranking data)
- Hand quality must be logged to `bot_turn_audits.details` JSONB so it's queryable after games
- Console logging: `[Hand Quality] score=X.X (threshold=Y.Y), stale cards: N, best demand: Z turns` on every turn evaluation

**Acceptance:**
- LLM context includes hand quality score and staleness indicators
- Hand quality score and staleness are visible in DebugOverlay per bot turn
- Hand quality is persisted in `bot_turn_audits.details` JSONB
- Bot discards hand when holding 3 poor-quality cards for extended periods
- Bot does not discard when at least one demand is achievable in ≤ 4 turns
- Heuristic fallback discard check is expanded from binary affordability to quality-based

---

### Behavior 7: Zero-Money Recovery

**Source:** JIRA-25 Bug 6, JIRA-30 Bug 2

**Current behavior:** At 0M with no loads, the LLM fails every turn (all demands flagged as infeasible → invalid plan → heuristic fallback → aimless MoveTrain). The bot moves randomly for 5+ turns with no recovery path.

**Required behavior:** When the bot has 0M, it should pursue the only two strategies that don't require money: deliver on existing track, or discard hand.

**Rules:**
- Add a pre-LLM gate: if `money === 0 && loads.length === 0`, bypass normal planning
- Step 1: Check if any demand is completable using only existing track (supply AND delivery both on network)
- Step 2: If yes, plan a move→pickup→deliver route using only owned track
- Step 3: If no completable demand exists, discard hand to draw 3 new cards
- Never fall back to aimless MoveTrain at 0M — that accomplishes nothing
- This gate runs before the LLM call, saving a wasted API call that consistently fails at 0M

**Acceptance:**
- At 0M with no loads, bot checks for deliveries on existing track first
- If a delivery exists on existing track, bot plans move→pickup→deliver without building
- If no delivery exists on existing track, bot discards hand
- Bot never does aimless MoveTrain at 0M for consecutive turns
- The 0M recovery bypasses the LLM (saves API cost on a guaranteed failure)

---

## Behaviors NOT in Scope

| Item | Why excluded |
|------|-------------|
| JIRA-27 (reduce thinking effort) | Already shipped |
| JIRA-28 Phase 2 (geographic clusters) | Nice-to-have — can layer on after rarity scoring lands |
| Cash reserve enforcement / hard budget caps | User veto (see CLAUDE.md). Fix the decision, not the spending. |
| LLM plans unaffordable routes (JIRA-30 Bug 5) | Addressed indirectly by Behavior 1 (build budget verification) and enriched context |

---

## Dependency Order

```
Behavior 2 (all supply cities)  ─┐
Behavior 3 (corridor rebalance) ─┼─→ Behavior 4 (supply rarity) ─→ Behavior 6 (hand discard)
Behavior 1 (build budget)       ─┘
Behavior 5 (train upgrades)     ─── independent
Behavior 7 (0M recovery)        ─── independent (but benefits from Behavior 6)
```

- Behaviors 1, 2, 3, 5, 7 are independent of each other
- Behavior 4 (rarity) builds on the improved scoring from Behaviors 2+3
- Behavior 6 (hand discard) needs the demand scores from Behavior 4 to assess hand quality

---

## Key Files

| File | Behaviors |
|------|-----------|
| `src/server/services/ai/ContextBuilder.ts` | 1, 2, 3, 4, 6 |
| `src/server/services/ai/TurnComposer.ts` | 5 |
| `src/server/services/ai/ActionResolver.ts` | 6, 7 |
| `src/server/services/ai/AIStrategyEngine.ts` | 7 |
| `src/server/services/ai/prompts/systemPrompts.ts` | 4, 5, 6 |
| `src/shared/types/GameTypes.ts` | 4, 6 (new context fields) |
| `src/client/components/DebugOverlay.ts` | 6 (hand quality display) |

---

## Test Coverage

Each behavior needs:
- Unit tests for the new/modified function
- Integration-level test confirming the behavior fires in a realistic game context
- Regression tests ensuring existing scoring/planning still works

Critical test scenarios:
- Bot with 30M facing a 32M build target picks a different demand (Behavior 1)
- Cars demand scored with Stuttgart (score 45.8) beats Manchester (score 25.6) (Behavior 2)
- 51M delivery beats 21M delivery despite fewer corridor cities (Behavior 3)
- Flowers demand near Holland gets rarity boost over Beer demand near Frankfurt (Behavior 4)
- Bot on Freight with 80M and no urgent build target upgrades to Fast Freight (Behavior 5)
- Bot holding 3 stale cards with 8+ turn estimates discards hand (Behavior 6)
- Bot at 0M with Wheat deliverable on existing track plans move→pickup→deliver (Behavior 7)
- Bot at 0M with no deliverable demand discards hand instead of aimless MoveTrain (Behavior 7)
