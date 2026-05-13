# JIRA-126: Holistic Turn Validation and Multi-Stop Trip Planning

_Analysis of game `eb69a74e` (Flash vs Haiku). Flash makes individually rational decisions that compose into strategically absurd turns — traversing the continent multiple times, chasing peripheral deliveries while ignoring victory conditions, and violating the build-OR-upgrade rule. The root cause is that no component ever reviews the composed turn as a whole._

## Summary

Two problems, one fix surface:

1. **No holistic turn review exists.** The turn is composed through a chain of if-conditions across multiple components. Each step is locally reasonable, but nobody checks whether the full turn makes sense. This produces rules violations (build + upgrade on same turn) and strategic blunders (zig-zagging across the map).
2. **The planning unit is a single delivery, not a trip.** The bot scores deliveries independently and executes them serially. A human looks at 3 demand cards and plans one efficient loop. The bot plans delivery #1, executes it, then plans delivery #2 from scratch — often in the opposite direction.

These are combined into a two-layer architecture: a **Trip Planner** that composes better plans, and a **Turn Validator** that catches when the plan is still wrong.

## The Evidence

### Rules Violation: Build + Upgrade on Same Turn

**Game `eb69a74e`, T62-63 — Flash**

The game analysis shows Flash spending 30M at T62 on "Zurich | Includes superfreight upgrade." The rules are explicit:

> A player may spend up to ECU 20 million per turn to: 1. Build track, OR 2. Upgrade their train.

Build and upgrade are mutually exclusive. The only exception is **crossgrading** (Fast Freight <-> Heavy Freight for 5M), which explicitly permits up to 15M of building alongside. A full 20M upgrade consumes the entire Phase B budget.

**This means the turn executor has no hard gate enforcing the build-OR-upgrade constraint.** Any turn plan that includes both should be rejected before execution.

### Strategic Absurdity: Serial Single-Delivery Planning

**Game `eb69a74e` — Flash**

| Turns | What Flash Did | What a Human Would Do |
|-------|---------------|----------------------|
| T49-55 | Detoured to Wroclaw for Coal, then dropped Coal at Holland to pick up Cheese. Two separate "plans" composed into pure waste. | Skip the Coal — it's 2x2 turns out of the way for a low-value load. Pick up Cheese directly. |
| T110-120 | Built to Stockholm (far north, 33M), delivered Tobacco (63M), then tried to build to London (far west, 60M never completed). | Recognize that Stockholm is a dead-end spur. Build toward London or another major city instead — victory requires city connections, not one big payout. |
| T84-89 | Continued Oil route to Frankfurt (23M) despite drawing 33M Tobacco->Krakow opportunity. Re-eval dismissed it: "current route has highest score (6.0)." | Abandon the 23M Oil route for the 33M Tobacco — remaining Oil value is less than Tobacco value. |

**Pattern:** The bot never asks "given everything I'm carrying, everything on my cards, and where I am — what's the best *trip* I can take?" It asks "what's the single best delivery?" and repeats.

### The Frankenstein Problem

The current turn composition pipeline spans multiple components (TurnComposer, PlanExecutor, AIStrategyEngine, LLMStrategyBrain) with accumulated if-conditions that are individually correct but collectively opaque. The human who built this system reports they "no longer understand all the if conditions." This is the core maintainability issue — adding more conditions to fix edge cases makes the system harder to reason about and more likely to produce emergent misbehavior.

## Proposed Architecture: Two Layers

### Layer 1: Trip Planner (replaces serial single-delivery scoring)

**When:** Before turn composition begins, after drawing cards / receiving re-eval trigger.

**What it does:** Looks at all 3 demand cards + current cargo + current position + network topology and generates 2-3 candidate **multi-stop trips** — not single deliveries.

A trip is an ordered sequence of stops — pickups and deliveries interleaved in whatever order is most efficient. The sequence is flexible: `[pickup(A) -> pickup(B) -> deliver(B) -> pickup(C) -> deliver(A) -> deliver(C)]` is just as valid as `[pickup(A) -> deliver(A) -> pickup(B) -> deliver(B)]`. The LLM should reason about geographic proximity to find the best ordering. Scored by:

```
trip_score = total_net_value / estimated_turns_to_complete
```

Where:
- `total_net_value` = sum of delivery payouts - estimated track build costs - estimated track usage fees
- `estimated_turns_to_complete` = movement turns + build turns + ferry stops

**Key design constraints:**
- Generate 2-3 candidates, not one. The LLM picks the best, but having alternatives prevents tunnel vision.
- Score per-turn, not total. A 63M delivery that takes 10 turns (6.3M/turn) loses to a 30M delivery that takes 3 turns (10M/turn).
- Cargo slots are a budget, not a target. Don't fill all 3 slots if the 3rd requires a detour. Only plan a pickup if it's on or near the planned route.
- The trip planner does NOT compose individual turn actions — it produces a **route plan** (ordered list of stops with estimated costs). Turn composition remains the job of TurnComposer/PlanExecutor.

**This is one LLM call** that replaces the current "score each delivery independently" pattern. The prompt includes:
- Current position and cargo
- All 3 demand cards with payouts
- Available loads at nearby cities (within ~15 mileposts)
- Network topology summary (which major cities are connected, rough distances)
- Victory progress (cities connected, cities needed, cash position)

### Layer 2: Turn Validator (reviews composed turn before execution)

**When:** After Phase A (operations) is composed AND after Phase B (build/upgrade) is composed, but before execution of each phase.

**What it does:** Two categories of checks.

#### Hard Gates (reject and re-plan)

These are rules violations that must never execute:

| Check | Rule | Catches |
|-------|------|---------|
| Build + upgrade mutual exclusion | Phase B cannot contain both track builds and a train upgrade | T62 violation |
| 20M Phase B cap | Total Phase B spend <= 20M | Overspend |
| Major city build limit | Max 2 track sections from a major city milepost per turn | Building violations |
| City entry limits | Medium cities: 3 players max. Small cities: 2 players max | Entry violations |
| Ferry stop rule | Must stop at ferry port, next turn starts at opposite port at half rate | Ferry violations |
| Same-card double delivery | No two deliveries from same cardIndex (JIRA-123) | Card conflicts |
| Cash sufficiency | Cannot build/upgrade/use opponent track without sufficient cash | Credit violations |

On hard gate failure: reject the composed phase, return the specific violation, and trigger re-composition with the constraint.

#### Soft Flags (warn and optionally re-plan)

These are strategic sanity checks — not rules violations, but likely mistakes:

| Check | Heuristic | Catches |
|-------|-----------|---------|
| Backtrack detection | Phase A movement retraces >50% of previous turn's path | Zig-zagging |
| Low-value detour | Pickup adds >2 turns of detour for <15M payout | T49-55 Coal detour |

On soft flag: log the flag, increment a counter. If >=2 soft flags fire on the same turn, trigger re-planning with the flags as constraints. If only 1 fires, log it but execute (to avoid over-correcting on marginal cases).

### How the Layers Interact

```
[Draw cards / Re-eval trigger]
        |
        v
  Layer 1: Trip Planner
  - Generates 2-3 candidate trips
  - Selects best trip by score/turn
  - Outputs: route plan (ordered stops + estimated costs)
        |
        v
  TurnComposer (existing)
  - Composes Phase A actions from route plan
  - Composes Phase B actions (build toward next stop or victory city)
        |
        v
  Layer 2: Turn Validator
  - Hard gates: reject if rules violated -> re-compose
  - Soft flags: warn if strategically suspect -> re-plan if >= 2 flags
        |
        v
  Execute turn
```

**Critical design rule:** Layer 2 does NOT fix the plan. If it rejects, it kicks back to Layer 1 (for strategic issues) or TurnComposer (for rules issues) with the specific constraint that was violated. This keeps each layer's responsibility clean and prevents Layer 2 from becoming its own Frankenstein.

## Implementation Considerations

### What Changes

| Component | Change | Risk |
|-----------|--------|------|
| New: `TripPlanner` | New service. Generates multi-stop trip candidates, scores them. One LLM call per planning cycle. | Medium — new LLM prompt needs tuning |
| New: `TurnValidator` | New service. Hard gates + soft flags. Pure logic, no LLM calls. | Low — deterministic checks |
| `AIStrategyEngine` | Calls TripPlanner instead of single-delivery scoring for route selection | Medium — integration point |
| `TurnComposer` | Receives route plan from TripPlanner instead of single delivery target. Phase B composition adds hard gate checks before returning. | Medium — refactor of existing logic |
| `LLMStrategyBrain` | Trip planning prompt replaces individual delivery scoring prompt. Re-eval prompt updated to evaluate against current trip, not single delivery. | Medium — prompt engineering |
| `PlanExecutor` | Minor — consumes route plan format instead of single-stop route | Low |

### What Doesn't Change

- Movement/pathfinding logic
- Track building cost calculations
- Demand card management
- Load pickup/delivery mechanics
- Ferry handling
- Event card processing

### LLM Cost Impact

- Trip Planner adds 1 LLM call per planning cycle (replaces multiple single-delivery scoring calls, so net call count may decrease)
- Turn Validator is pure logic — zero LLM calls
- Re-eval calls remain but with better context (trip-aware instead of single-delivery-aware)

## Logging Requirements

Both new components must log to all three existing layers: DecisionLogger (console), GameLogger (NDJSON), and socket events (debug panel). The goal is full visibility into what the Trip Planner considered, what the Turn Validator caught, and why.

### Layer 1: Trip Planner Logging

#### DecisionLogger (console)

Log a new phase `"Trip Planning"` via `logPhase()` containing:
- **Trigger reason**: what caused the planning cycle (new cards drawn, delivery completed, re-eval fired)
- **Candidate trips**: each candidate as a `LoggedOption` with:
  - `action`: human-readable stop sequence (e.g., `"pickup(Coal@Ruhr) -> pickup(Marble@Firenze) -> deliver(Marble@Hamburg) -> deliver(Coal@Frankfurt)"`)
  - `score`: the `trip_score` (net value / estimated turns)
  - `reason`: breakdown showing `total_net_value`, `estimated_turns`, and per-stop contributions
- **Chosen trip**: which candidate was selected and why
- **LLM metadata**: model, latency, token usage (via existing `LLMPhaseFields`)

#### GameLogger (NDJSON)

Add a `tripPlanning` object to `GameTurnLogEntry`:

```typescript
tripPlanning: {
  trigger: string;                    // 'new_cards' | 'delivery_completed' | 'reeval'
  candidates: Array<{
    stops: string[];                  // ['pickup(Coal@Ruhr)', 'deliver(Coal@Frankfurt)', ...]
    score: number;                    // trip_score
    netValue: number;                 // total payout - build costs - usage fees
    estimatedTurns: number;
    buildCostEstimate: number;
    usageFeeEstimate: number;
  }>;
  chosen: number;                     // index into candidates
  llmLatencyMs: number;
  llmTokens: { input: number; output: number };
  llmReasoning: string;              // raw LLM reasoning for the choice
}
```

#### Socket Events (debug panel)

Emit trip planning data as part of the existing `bot:turn-complete` payload. The debug overlay should render:
- **Trip Candidates panel**: collapsible list of 2-3 candidates, each showing the stop sequence, score, and cost breakdown. Highlight the chosen trip.
- **Trip Reasoning**: the LLM's reasoning text for why it picked this trip over alternatives.

### Layer 2: Turn Validator Logging

#### DecisionLogger (console)

Log a new phase `"Turn Validation"` via `logPhase()` containing:
- **Phase validated**: `"Phase A"` or `"Phase B"`
- **Hard gates checked**: list of gate names with pass/fail status
- **Hard gate violations** (if any): gate name, rule text, specific violation detail (e.g., `"Build + upgrade mutual exclusion: Phase B contains track build (8M to Zurich) AND superfreight upgrade (20M). Total: 28M."`)
- **Soft flags checked**: list of flag names with triggered/clear status
- **Soft flag details** (if triggered): flag name, heuristic values (e.g., `"Low-value detour: Coal pickup at Wroclaw adds 4 turns of detour for 15M payout. Threshold: >2 turns for <15M."`)
- **Outcome**: `"passed"` | `"hard_reject (re-composing)"` | `"soft_warn (re-planning)"` | `"soft_warn (executing anyway)"`
- **Re-plan count**: how many times this turn has been re-composed due to validator rejection (to detect loops)

#### GameLogger (NDJSON)

Add a `turnValidation` object to `GameTurnLogEntry`:

```typescript
turnValidation: {
  phaseA: {
    hardGates: Array<{ gate: string; passed: boolean; detail?: string }>;
    softFlags: Array<{ flag: string; triggered: boolean; detail?: string }>;
    outcome: 'passed' | 'hard_reject' | 'soft_warn_replan' | 'soft_warn_execute';
  };
  phaseB: {
    hardGates: Array<{ gate: string; passed: boolean; detail?: string }>;
    softFlags: Array<{ flag: string; triggered: boolean; detail?: string }>;
    outcome: 'passed' | 'hard_reject' | 'soft_warn_replan' | 'soft_warn_execute';
  };
  replanCount: number;
}
```

#### Socket Events (debug panel)

Emit validation data as part of `bot:turn-complete`. The debug overlay should render:
- **Validation Status badge**: green checkmark for clean pass, yellow warning for soft flags, red X for hard gate rejection
- **Hard Gate Violations panel** (if any): collapsible, showing each violation with the rule and specifics. This should be visually prominent — red background or border — since these are rules violations.
- **Soft Flag Warnings panel** (if any): collapsible, showing each triggered flag with heuristic detail
- **Re-plan indicator**: if the turn was re-composed, show the count and what triggered each re-plan

### Console Logging Prefixes

Follow existing convention:
- `[TripPlanner {gameId}]` — trip planning progress and decisions
- `[TurnValidator {gameId}]` — validation checks and outcomes

### What This Enables

With this logging in place, during a game you can:
1. **Watch the debug panel** to see which trips the bot considered and why it picked one
2. **See immediately** when a hard gate fires (red badge) — no more discovering rules violations after the fact in post-game analysis
3. **Track soft flag frequency** across games via NDJSON to tune thresholds
4. **Diagnose "stupid" decisions** by comparing the trip candidates — if the better trip was generated but not chosen, it's a scoring problem; if it was never generated, it's a prompt problem

## Success Metrics

- **Zero rules violations** in any game (hard gates)
- **Reduction in wasted turns** (turns where movement retraces previous path or cargo is picked up and dropped without delivery) — target: <5% of turns, down from ~10-15% observed in `eb69a74e`
- **Higher score-per-turn** for deliveries (trip scoring should produce more efficient routes)
- **Fewer human "that's stupid" whispers** per game

## Design Decisions (Resolved)

1. **Trip Planner generates 2-3 candidate trips** per planning cycle.
2. **Trip Planner runs on planning triggers only** (new cards drawn, delivery completed, re-eval fires) — not every turn. This avoids unnecessary latency on turns where the current trip is still valid.
3. **No victory bonus in trip scoring.** Most games naturally connect 5+ major cities through delivery routes. The final 1-2 cities are handled by JIRA-125's endgame victory build logic, which is already implemented and will remain the owner of victory-condition building.
4. **Soft flag thresholds are not model-specific.** One set of thresholds for all models — keeps the system simple and testable.
5. **JIRA-125 retains ownership of victory build logic.** The Trip Planner focuses purely on delivery efficiency. Victory-condition building stays in TurnComposer's victory build tier (JIRA-125).
