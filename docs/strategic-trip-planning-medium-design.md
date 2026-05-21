# Strategic Trip Planning — Spec (Medium Skill Level)

## 1. Goal

For **Medium (Sonnet) skill bots only**: exercise the model's strategic reasoning instead of pre-computing decisions for it. Inject multi-turn context (victory pathing, capital projection, hand staleness, opponent race state) so Sonnet picks trips by reasoning over the full game state, not just the current hand. Demand structured counterfactual reasoning. Allow Sonnet to propose trips outside helper-generated options.

Easy bots use the candidate-menu spec (`docs/trip-candidate-menu-easy-design.md`); their pre-computed pattern menu is a Haiku-shaped solution that constrains stronger models. Hard (Opus) skill level is **out of scope for this spec** — design deferred.

## 2. Pipeline (per turn, pre-LLM)

0. If `skillLevel !== Medium`, do not apply this spec. Easy routes through its own spec; Hard continues to use the legacy `TRIP_PLANNING_SYSTEM_SUFFIX` composition unchanged.
1. Build the strategic context blocks (§3).
2. Inject the context blocks into the user prompt; existing OPTIONS rendering remains unchanged.
3. Existing `TripPlanner.planTrip` control flow (retry, validation, affordability, fallback, post-LLM enrichment) runs as today — no skill-conditional branches outside prompt construction.

## 3. Strategic context blocks (user prompt)

Each block is a named section inserted between CURRENT PLAN and OPTIONS in `buildTripPlanningContext`. None of the existing sections are modified.

### 3.1 VICTORY TARGETS

The 3–4 cheapest unconnected major cities, each annotated with cost-to-connect and a hand-affinity count (how many cards in current hand have a delivery within 3 hops of that city).

```
VICTORY TARGETS (3 connected, 4 to go for win):
  Munchen      ~10M to connect   1 hand card delivers nearby
  Wien         ~12M to connect   2 hand cards deliver nearby
  Marseille    ~18M to connect   1 hand card (Ham, 37M payout)
  Praha        ~14M to connect   1 hand card (Wood, 18M payout)
```

Computed from `context.unconnectedMajorCities` + `context.demands` + hop-distance lookup.

### 3.2 CAPITAL projection

Cash position + recent income velocity + projected turns to 250M.

```
CAPITAL: 87M cash (target 250M, gap 163M).
  Recent income: 12M/turn (last 5 deliveries).
  At current rate: ~14 turns to victory cash threshold.
```

Income velocity = `sum(recent_payouts) / turns_elapsed_during_those_payouts`. Tracked in `BotMemoryState.recentDeliveries`.

### 3.3 HAND STALENESS

Per-card turns-held; stale cards flagged.

```
HAND STALENESS:
  Card 5  held  3 turns
  Card 12 held 12 turns  [STALE]
  Card 18 held  1 turn
```

Stale threshold lives in constants (default 10 turns). Sonnet uses this to weigh discard-vs-play.

### 3.4 OPPONENTS race state

Per-opponent: cities connected and projected turns-to-win at their current velocity.

```
OPPONENTS:
  Player Bot-2: 5/7 cities, 180M cash, ~6 turns from win  [LEADING]
  Player Bot-3: 3/7 cities, 90M cash,  ~25 turns from win
```

Lets Sonnet reason about race dynamics — when an opponent is close to winning, conservative trips are wrong; speculative high-payout trips become correct.

## 4. Required reasoning structure

The existing `TRIP_PLAN_SCHEMA` field `reasoning: string` is upgraded for Medium to a structured object. Easy bots' schema is unchanged.

```ts
reasoning: {
  chosen: string;            // identifier or short label of the chosen trip
  chosenOver: string[];      // alternatives explicitly considered
  chosenOverWhy: string;     // 1–2 sentences, must cite NET / turns / strategic context
  riskIfWrong: string;       // what could go wrong; what state recovers from it
  followUpTrip: string;      // sketch of the most likely next trip after this one
}
```

Forces counterfactual evaluation. Validation: if any field is missing or `chosenOver` is empty when ≥2 viable options exist, retry with feedback.

## 5. Soft latitude — `propose` field

Schema extension: optional top-level `propose` field carrying a candidate trip not derived from any helper.

```ts
propose?: {
  stops: RouteStop[];
  rationale: string;
}
```

Post-LLM flow:

1. If `propose` is present, run `simulateTrip` on its `stops`.
2. Compare its score to the best status-quo candidate (the trip the LLM also emitted in `stops`).
3. If `propose` score > status-quo score, accept `propose` as the route.
4. If `propose` is infeasible or scores worse, log the rejection (don't retry — the LLM already emitted a valid status-quo trip alongside).

This rewards the LLM for finding wins the helper logic missed without punishing it when it doesn't.

## 6. System prompt — extended (Medium only)

The existing `TRIP_PLANNING_SYSTEM_SUFFIX` (action grammar, capacity rules, Cardiff×2 worked example, trip rules, scoring formula, geographic strategy, upgrade options, response format) is preserved byte-for-byte for Medium.

Two appended blocks:

- `TRIP_REASONING_STRUCTURE`: documents the structured `reasoning` schema from §4 and the rule that `chosenOver` must be non-empty when alternatives exist.
- `TRIP_PROPOSE_LATITUDE`: documents the optional `propose` field from §5 and the simulator-validation contract.

Composition:

```ts
const MEDIUM_SYSTEM = [
  TRIP_PLANNING_SYSTEM_SUFFIX,
  TRIP_REASONING_STRUCTURE,
  TRIP_PROPOSE_LATITUDE,
].join('\n\n');
```

Easy uses its own composition from the Easy spec. Hard continues to use today's `TRIP_PLANNING_SYSTEM_SUFFIX` directly.

## 7. Code surface

| Path | Change |
|---|---|
| `src/server/services/ai/context/StrategicContextBuilder.ts` | New (~200 LOC) — builds the §3 context blocks from `WorldSnapshot` + `BotMemoryState` + `GameContext` |
| `src/shared/types/GameTypes.ts` | Extend `BotMemoryState` with `recentDeliveries` (rolling window for income velocity) and `cardAcquisitionTurn` per card (for staleness) |
| `src/server/services/ai/TripPlanner.ts` | Skill gate: invoke `StrategicContextBuilder.build()` when `skillLevel === Medium`; pass result through to user-prompt builder. No other control-flow change. |
| `src/server/services/ai/prompts/systemPrompts.ts` | Append `TRIP_REASONING_STRUCTURE` + `TRIP_PROPOSE_LATITUDE` blocks; user-prompt builder renders §3 blocks for Medium between CURRENT PLAN and OPTIONS |
| `src/server/services/ai/schemas.ts` | Extend `TRIP_PLAN_SCHEMA` for Medium with structured `reasoning` object + optional `propose` field |
| `src/server/services/ai/RouteValidator.ts` | No change — still validates emitted `stops` |
| `src/server/services/ai/RouteDetourEstimator.ts` | No change — `simulateTrip` consumed for `propose` validation |

The existing `TripPlanner.planTrip` retry loop, parse-error recovery, affordability check, fallback to `planRoute`, `RouteEnrichmentAdvisor` post-LLM enrichment, and skill-tiered effort/temperature/maxTokens all remain unchanged.

## 8. Constants (`StrategicConstants.ts`)

```ts
export const HAND_STALE_THRESHOLD_TURNS = 10;

export const VICTORY_TARGETS_COUNT = 4;
export const VICTORY_TARGET_HAND_AFFINITY_HOPS = 3;

export const RECENT_DELIVERIES_WINDOW = 5;  // for income-velocity calc

export const PROPOSE_MIN_SCORE_DELTA = 0;  // accept any improvement; tunable
```

## 9. Open questions

1. **`propose` retry budget.** Currently no retry on rejected `propose`. If acceptance rate is high (>30%), consider a single retry with feedback. Profile first.
2. **Schema extension cost.** Medium now has a different schema than Easy. Consider whether a single union schema (with `reasoning` polymorphic) is cleaner than two parallel schemas.
3. **Multi-trip horizon.** Pre-computing a "best follow-up trip" for each candidate adds a second pass of trip search per turn. Worth the compute? Defer until we measure whether structured reasoning + strategic context closes the gap on its own.

## 10. Suggested experiment sequence

1. Land §3 (strategic context blocks) + §4 (structured reasoning) at Medium. Measure win-turn distribution.
2. Land §5 (`propose` latitude). Measure `propose` acceptance rate and whether it shifts win-turn distribution.
3. If gap to <80 turns remains, decide whether to introduce multi-trip horizon, design Hard spec, or both.
