# JIRA-142: Initial Build Phase — Dedicated LLM Prompt

## Summary

Create a special-purpose LLM prompt for the first two turns of the game (the "initial build" phase). The current pipeline sends the full general-purpose prompt — including upgrades, discards, victory rules, mid/late-game strategy — which is irrelevant noise during initial build. A slim, focused prompt should produce better opening decisions.

## Goal

A single LLM call at game start that outputs:
1. A **starting major city** to build from (and later place the train at)
2. A **full route plan** — ideally a **double delivery** (pickup A → deliver A → pickup B → deliver B)
3. A **build direction** for the first two 20M track-building turns

The route plan persists as the bot's `activeRoute` and is not re-evaluated until a strategic event requires it (e.g., first delivery completed + new demand card drawn). No second LLM call on turn 2 — the existing BuildAdvisor/computeBuildSegments continues building toward the route plan's first target.

---

## The Demand Matrix Problem

Each player holds **3 demand cards** with **3 demands per card** (pick one to fulfill per card) = **9 possible demands**. Each demand requires a load type that can be supplied from **2-4 different cities**. The bot must choose:

1. Which demand from each card to pursue (3 × 3 × 3 = 27 card combinations)
2. Which supply city to use for each chosen demand (2-4 options each)
3. Which major city to start building from (8 options)
4. Whether two demands chain into a double delivery

The raw combinatorial space is too large for the LLM to navigate from first principles. We precompute and present a structured view.

---

## Precomputed Context (3 layers)

### Layer 1: All 9 demands with all supply options

For each of the 9 demands across all 3 cards, enumerate every supply city with its best starting major city and total build cost. Filter out unaffordable and ferry-required options (but note them as filtered).

```
CARD 1 (pick one demand):
  1a. Coal → Berlin (15M payout)
      From Wroclaw, start Berlin: ~8M total build, no ferry
      From Krakow, start Berlin: ~10M total build, no ferry
      From Cardiff: FILTERED (ferry required)
  1b. Cheese → Milano (12M payout)
      From Bern, start Milano: ~7M total build, no ferry
      From Holland, start Holland: ~14M total build, no ferry
      From Kobenhavn: FILTERED (ferry required)
  1c. Imports → Wien (18M payout)
      From Hamburg, start Berlin: ~12M total build, no ferry
      From Antwerpen, start Ruhr: ~15M total build, no ferry

CARD 2 (pick one demand):
  2a. Beer → Wien (12M payout)
      From Praha, start Wien: ~6M total build, no ferry
      From München, start Wien: ~5M total build, no ferry
      From Frankfurt, start Ruhr: ~14M total build, no ferry
      From Dublin: FILTERED (ferry required)
  2b. Cars → Paris (20M payout)
      From Stuttgart, start Ruhr: ~10M total build, no ferry
      From München, start Paris: ~16M total build, no ferry
      From Torino, start Milano: ~12M total build, no ferry
      From Manchester: FILTERED (ferry required)
  2c. Steel → Hamburg (9M payout)
      From Ruhr, start Ruhr: ~4M total build, no ferry
      From Luxembourg, start Ruhr: ~8M total build, no ferry

CARD 3 (pick one demand):
  3a. Wine → London (28M payout)
      From Frankfurt, start Ruhr: FILTERED (ferry to London)
  3b. Marble → Berlin (11M payout)
      From Firenze, start Milano: ~18M total build, no ferry
  3c. Machinery → Wien (14M payout)
      From Bremen, start Berlin: ~10M total build, no ferry
      From Nantes, start Paris: ~20M total build, no ferry
```

This gives the LLM the full picture: every option, every supply city, every cost — without requiring it to know game geography.

### Layer 2: Precomputed double-delivery pairings

For each cross-card demand pair (card 1 × card 2, card 1 × card 3, card 2 × card 3), evaluate the best supply-city combination where:
- Both share a common starting city (or nearby starting cities)
- Delivery of demand A is near supply of demand B (good chaining)
- Total build cost fits within 40M budget
- No ferry crossings (unless both deliveries justify it)

Rank top 3-4 candidates by combined efficiency: `(total payout - total build cost) / estimated turns`.

```
DOUBLE-DELIVERY CANDIDATES (ranked by efficiency):
  #1: Start Berlin — Cards 1a + 2a
      Coal from Wroclaw → Berlin (15M), then Beer from Praha → Wien (12M)
      Total build: ~18M | Total payout: 27M | Est. turns to complete: 8
      Chain quality: Good — Berlin is near Praha (short travel between deliveries)

  #2: Start Ruhr — Cards 2c + 1a
      Steel from Ruhr → Hamburg (9M), then Coal from Wroclaw → Berlin (15M)
      Total build: ~12M | Total payout: 24M | Est. turns to complete: 7
      Chain quality: Excellent — Hamburg is on the way to Wroclaw

  #3: Start Wien — Cards 2a + 1c
      Beer from München → Wien (12M), then Imports from Hamburg → Wien (18M)
      Total build: ~17M | Total payout: 30M | Est. turns to complete: 10
      Chain quality: Fair — Wien delivery then long trip to Hamburg for pickup

SINGLE-DELIVERY FALLBACK (if no good pairing):
  Best: Steel from Ruhr → Hamburg (9M), start Ruhr, ~4M build, 3 turns
```

### Layer 3: Triple-delivery candidates (rare, optional)

If a three-card chain exists where all three chosen demands chain geographically from a common starting city within budget, surface it. This is rare but valuable when it occurs.

```
TRIPLE-DELIVERY CANDIDATE (if found):
  Start Ruhr — Cards 2c + 1a + 3c
      Steel from Ruhr → Hamburg (9M) → Coal from Wroclaw → Berlin (15M) → Machinery from Bremen → Wien (14M)
      Total build: ~22M | Total payout: 38M | Est. turns: 14
```

If no triple is found within 40M budget, this section is omitted.

---

## Behavioral Specification

### What the prompt MUST instruct

1. **Evaluate the precomputed candidates.** The system has already found the best pairings — review them for soundness and pick one (or propose a variation using Layer 1 data).

2. **Explicitly search for a double delivery.** The ideal opening is: pickup load A near starting city → deliver A → pickup load B near delivery A → deliver B. Prefer double-delivery candidates over single-delivery unless the single is dramatically more efficient.

3. **Choose a starting major city.** The LLM picks which of the 8 major cities to build from. The precomputed candidates already suggest starting cities — the LLM confirms or overrides.

4. **Budget awareness.** The bot has 50M cash and can spend up to 20M/turn across 2 building turns = **40M total track budget**. The system will validate the plan's math and reject+retry if the plan exceeds 40M.

5. **No bad-hand bailout.** Starting hands are often suboptimal — the bot cannot discard during initial build. The prompt should NOT offer discard as an option. Instead: "Pick the best available option even if none are ideal."

### What the prompt MUST NOT include

- Victory conditions / 250M cash / 7-city connection rules
- Train upgrade options or advice
- Discard hand mechanics
- Track usage fees (no opponents' track exists yet)
- Movement rules (no movement during initial build)
- Mid-game or late-game strategy
- Event card rules
- Load drop mechanics
- Multi-action turn composition (MOVE + PICKUP + DELIVER combos)

### Expected LLM output format

```json
{
  "startingCity": "Berlin",
  "route": [
    { "action": "PICKUP", "load": "Coal", "city": "Wroclaw", "cardId": 1 },
    { "action": "DELIVER", "load": "Coal", "city": "Berlin", "payment": 15, "cardId": 1 },
    { "action": "PICKUP", "load": "Beer", "city": "Praha", "cardId": 2 },
    { "action": "DELIVER", "load": "Beer", "city": "Wien", "payment": 12, "cardId": 2 }
  ],
  "buildPriority": "Build toward Wroclaw first (supply for first pickup), then extend toward Praha/Wien",
  "reasoning": "Candidate #1 is the best opening. Both demands chain through central Europe from Berlin. Coal pickup at Wroclaw is close, delivers at Berlin (our start). Then Beer from Praha to Wien extends eastward. 18M total build is well within 40M budget."
}
```

### Validation & retry loop

The system validates the LLM's plan before accepting it:

1. **Budget check**: Estimated build cost from `startingCity` through the route must not exceed 40M. If it does → reject with error message showing the overage, retry.
2. **Madrid block**: If `startingCity` is Madrid → reject, retry.
3. **City existence**: All cities in the route must exist on the board.
4. **Load availability**: Loads referenced must actually be available at the named supply cities.
5. **Demand match**: Each DELIVER must correspond to one of the bot's 3 demand cards (matched by `cardId`).
6. **One demand per card**: Cannot pick two demands from the same card.
7. **Ferry warning** (soft): If the route requires ferry and is a single delivery, append a warning on retry: "Single-delivery routes through ferries are inefficient for the opening. Choose a non-ferry route if possible."

Max retries: 2 (same as existing pipeline). On total failure: fall back to heuristic (pick cheapest demand, closest major city).

---

## What changes at a high level

| Component | Change |
|-----------|--------|
| `systemPrompts.ts` | New `getInitialBuildPrompt()` — slim, focused, no mid/late-game content |
| `ContextBuilder.ts` | New `serializeInitialBuildContext()` — Layer 1 (all 9 demands × all supply options) + Layer 2 (double-delivery pairings) + Layer 3 (triple if found) |
| `ContextBuilder.ts` | New `computeInitialBuildCandidates()` — cross-card pairing logic with chaining quality scoring |
| Decision gate in pipeline | When `isInitialBuild`, use new prompt + serializer instead of TripPlanner |
| `startingCity` persistence | Store LLM's chosen `startingCity` in `BotMemory` for `autoPlaceBot` on turn 3 |
| Validation | New budget validator specific to initial build (40M cap, ferry soft-block, Madrid hard-block, one-demand-per-card) |

---

## Implementation notes

1. **Precomputation is critical.** The LLM cannot reliably reason about hex grid distances or terrain costs. All build costs, ferry flags, and chaining quality must be computed and presented as numbers. The LLM's job is to evaluate trade-offs between precomputed options.

2. **No second LLM call on turn 2.** The first call's `buildPriority` + `route` gives enough direction. The existing BuildAdvisor / `computeBuildSegments` determines what to build on turn 2 given the route plan.

3. **Token budget.** This prompt is much slimmer than the general-purpose prompt. Recommended: 4096 max tokens, low temperature (0.2).

4. **Existing infrastructure to reuse:**
   - `estimateInitialBuildCost()` already computes build cost from nearest major city — needs modification to return which major city and to accept a specific supply city
   - `computeCorridors()` already detects shared delivery areas — can inform Layer 2 pairing
   - `isFerryOnRoute()` already detects ferry requirements
   - `LoadService.getSourceCitiesForLoad()` already enumerates supply cities per load type
