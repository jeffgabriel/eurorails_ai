# Trip Candidate Menu — Spec (Easy Skill Level)

## 1. Goal

For **Easy skill bots only** (Haiku): replace the flat per-card OPTIONS list in the trip-planning prompt with a small, pattern-generated candidate menu, so Haiku picks among pre-validated trips rather than doing spatial chain reasoning manually. Each candidate carries a pattern label, a length tag, and truthful net/turns from the simulator. Medium and Hard bots continue to use the existing OPTIONS-based prompt unchanged. Medium has a separate spec (`docs/strategic-trip-planning-medium-design.md`) that exercises Sonnet through strategic context injection rather than pre-computed candidates. Hard (Opus) skill level is design-deferred.

## 2. Pipeline (per turn, pre-LLM)

0. If `skillLevel !== Easy`, skip the menu and proceed with the existing OPTIONS-based prompt. All steps below apply to Easy only.
1. Classify game phase from `(turn, deliveries, citiesConnected)`.
2. Build the demand-row grid from current hand + carried load.
3. Run pattern detectors P1–P6 against the row grid → candidate set.
4. Simulate each candidate via `RouteDetourEstimator.simulateTrip` → `(net, turns, feasible)`.
5. Score = `net − 5 × turns`. Sort. Take top **K=3**.
6. If best score `< DISCARD_THRESHOLD[phase]` and bot is not mid-trip, append a DISCARD candidate.
7. Inject menu + phase line into the user prompt; system prompt is unchanged byte-stable cacheable content.

## 3. Patterns

A "demand row" is a `(cardId, loadType, supplyCity, deliveryCity, payment)` tuple. One card produces multiple rows (one per supply city for the chosen resource). The carried load (if any) appears as a row with `supplyCity = null`.

| ID | Trigger | Candidate shape |
|---|---|---|
| **P1** | Two rows from different cards have the same `loadType` | Pickup N copies at the shared supply (capped to train capacity); deliver to each card's `deliveryCity` |
| **P2** | Two rows from different cards have the same `supplyCity` (different loads) | One stop at the shared supply; pickup all distinct loads; deliver each in optimized order |
| **P3** | Two rows from different cards have the same `deliveryCity` (different loads) | Pickup each at its own supply; one delivery stop unloads both |
| **P4** | Two rows' `deliveryCity`s are **co-regional** (see Appendix C) — same peripheral region OR within `DENSE_REGION_NEIGHBOR_HOPS` (default 3) of each other in dense Europe | Sequential deliveries with minimal extra travel between |
| **P5** | Two rows' `supplyCity`s are co-regional by the same rule | One pickup detour collects both loads before delivery legs |
| **P6** | Row A's `deliveryCity` equals (or is on the shortest path to) row B's `supplyCity` | Transit city: deliver A and pickup B at the same stop |

Carried-load rows participate in P3, P4, P6 naturally. The carry-delivery may appear at any position in the resulting candidate's stop sequence (not just first).

Single-card candidates (one row, one PICKUP + one DELIVER) are always emitted as a baseline floor — one per card.

## 4. Scoring

```
score = net − 5 × turns
```

OCPT (opportunity cost per turn) = **5 across all game phases**. `net = totalPayout − totalBuildCost − usageFees` from the simulator.

Length tag thresholds still vary by phase (the LLM benefits from a phase-relative sense of "short" vs "long"):

| Phase | `[short]` | `[medium]` | `[long]` |
|---|---|---|---|
| EARLY | ≤4 turns | 5–7 | ≥8 |
| MID | ≤6 turns | 7–10 | ≥11 |
| LATE | ≤8 turns | 9–13 | ≥14 |

Candidates that fail simulation (`feasible: false`) are dropped before ranking.

## 5. Phase classifier

```ts
export function classifyPhase(state: {
  turn: number;
  deliveriesCompleted: number;
  citiesConnected: number;
}): 'early' | 'mid' | 'late' {
  if (state.citiesConnected >= 5 || state.turn >= 60) return 'late';
  if (state.turn < 25 || state.deliveriesCompleted < 3 || state.citiesConnected < 2) return 'early';
  return 'mid';
}
```

## 6. Prompt structure

### 6.1 System prompt — composed from shared + skill-specific blocks

The existing `TRIP_PLANNING_SYSTEM_SUFFIX` is decomposed into named, exported blocks. No content is rewritten; existing strings are split and re-assembled.

| Block | Source today | Used by |
|---|---|---|
| `TRIP_ACTION_GRAMMAR` | DELIVER-requires-PICKUP rules + capacity rules + Cardiff×2 Hops worked example | All skills |
| `TRIP_RULES_SHARED` | Carried loads / existing track / running cash / 2–6 stops cap / supply-delivery reference rules | All skills |
| `TRIP_UPGRADE_BLOCK` | UPGRADE OPTIONS section | All skills |
| `TRIP_RESPONSE_FORMAT` | JSON RESPONSE FORMAT block | All skills |
| `TRIP_SCORING_LEGACY` | Naked `(payout − build − fees) / turns` line + capital-velocity hint | **Medium/Hard only** (until separate spec lands) |
| `TRIP_GEO_LEGACY` | "Bias toward the core cluster (Paris — Ruhr — Holland — Berlin — Wien)…" | **Medium/Hard only** (until separate spec lands) |
| `TRIP_SCORING_PHASE` | New — phase-aware formula from §4 + score column reference | **Easy only** |
| `TRIP_PHASE_POSTURE` | New — posture rules from §4 (EARLY prefer [short]; MID balanced; LATE tolerate [long]) | **Easy only** |
| `TRIP_PATTERN_DOCS` | New — P1–P6 labels reference + reasoning rule (cite pattern + tag + posture) | **Easy only** |

Composition by skill (in `getTripPlanningPrompt`):

```ts
const EASY_SYSTEM = [
  TRIP_ACTION_GRAMMAR,
  TRIP_SCORING_PHASE,       // replaces SCORING_LEGACY
  TRIP_PATTERN_DOCS,
  TRIP_PHASE_POSTURE,
  TRIP_RULES_SHARED,
  // GEO_LEGACY omitted — phase posture supersedes core-cluster bias
  TRIP_UPGRADE_BLOCK,
  TRIP_RESPONSE_FORMAT,
].join('\n\n');

const MEDIUM_HARD_SYSTEM = [
  TRIP_ACTION_GRAMMAR,
  TRIP_SCORING_LEGACY,      // unchanged from today
  TRIP_RULES_SHARED,
  TRIP_GEO_LEGACY,          // unchanged from today
  TRIP_UPGRADE_BLOCK,
  TRIP_RESPONSE_FORMAT,
].join('\n\n');
```

Both compositions are byte-stable per skill, so prompt caching keys cleanly. Medium/Hard bots see byte-for-byte the same system prompt as today; only Easy bots see the menu-aware variant.

The new Easy-only blocks contain:

```
You receive a pre-computed CANDIDATE MENU each turn. Each entry is validated by
the simulator. Choose ONE candidate (or DISCARD).

Pattern labels:
- P1 same-load duplicates  - one pickup stop fills two demand cards
- P2 shared supply city    - one stop yields two loads
- P3 shared delivery city  - one delivery stop unloads two
- P4 neighbor deliveries   - delivery cities within ~3 mileposts
- P5 neighbor supplies     - supply cities within ~3 mileposts
- P6 transit city          - one card's delivery is the next card's supply

Length tag reflects phase-aware turn cost. Posture by phase:
- EARLY  prefer [short]; choose [medium] only if NET clearly justifies extra turns;
         avoid [long] unless it is the only positive-NET candidate.
- MID    balanced; choose by score.
- LATE   tolerate [long] for high-NET finalizers.

Reasoning must reference pattern label, length tag, and phase posture.
Do not echo the score number.

DISCARD appears only when no current candidate meaningfully advances victory.
```

### 6.2 User prompt — single fork at the OPTIONS / CANDIDATE MENU section

The existing `buildTripPlanningContext` builder is preserved in full. Every section it produces today — UPGRADE STATUS suppression rule, CURRENT STATE, VICTORY PROGRESS, NETWORK TOPOLOGY, CURRENT PLAN, AVAILABLE PICKUPS, IMMEDIATE DELIVERIES, UPGRADE AVAILABLE — applies to all skill levels unchanged.

The one fork point: the OPTIONS section is replaced for Easy with a GAME PHASE line + CANDIDATE MENU. Medium and Hard continue to see the OPTIONS section exactly as today.

Easy-only block, inserted in place of OPTIONS:

```
GAME PHASE: <PHASE> (turn=<n>, deliveries=<n>, cities=<n>/7)

CANDIDATE MENU (top 3 by score; OCPT=5):

  T1 [<pattern label>; <length tag>]: payout <m>M, build <m>M, <n> turns, NET <m>M
    1. PICKUP <load> at <supplyCity>
    2. DELIVER <load> at <deliveryCity> (card <id>, +<m>M)
    [...]

  T2 [<...>]: <...>

  T3 [<...>]: <...>
```

The menu replaces the per-card OPTIONS rendering when present. OPTIONS remains visible as a fallback when no candidates pass simulation (rare).

### 6.3 Surrounding control flow — shared across all skill levels

The skill fork is at prompt construction (§6.1, §6.2) only. Everything else in `TripPlanner.planTrip` and downstream remains shared and unchanged for all skill levels:

- Pre-LLM short-circuits: `no_actionable_options`, `keep_current_plan`
- Skill-tiered effort / temperature / maxTokens (already varies by skill today via `TRIP_EFFORT`, `TEMPERATURE_BY_SKILL`, `TRIP_MAX_TOKENS`)
- `thinking: adaptive` toggle (already off for Easy, on for Medium/Hard)
- Retry loop with error-feedback prompt (`MAX_RETRIES = 2`)
- JSON parse-error recovery via `ResponseParser.recoverTruncatedJson`
- Schema validation (`TRIP_PLAN_SCHEMA`)
- Validation pipeline: `RouteOptimizer.orderStopsByProximity` → `RouteValidator.validate` → pruned-route handling
- Affordability check (`computeUpgradeCost` + cash-vs-totalCost gate)
- Upgrade label normalization (PascalCase → snake_case enum)
- Score & rank validated candidates (`scoreCandidates`, chain-aware turn estimation, geographic distance penalty, JIRA-187 usage-fee folding)
- Fallback to `LLMStrategyBrain.planRoute` on total LLM failure
- LlmAttempt logging
- Post-LLM enrichment via `RouteEnrichmentAdvisor` (still fires for all skills)

No new conditional branches in any of the above — the menu is computed by `TripCandidateMenu.build()` and passed into the user-prompt builder; downstream code consumes the LLM's emitted `stops[]` identically regardless of which prompt produced it.

## 7. Carry-load handling

The carried-load delivery becomes one demand row in the row grid (`supplyCity = null` indicates "already on train"). Pattern detectors P3, P4, P6 fire normally against it. Candidate generation permutes the carry-delivery slot at any position in any chain, subject to capacity.

A "drop and abandon" candidate is generated only when omitting the carry-delivery enables a chain whose score beats the best carry-included candidate by ≥30. The sunk cost of the prior pickup turn is real.

## 8. Discard candidate

Appended to the menu when `bestScore < DISCARD_THRESHOLD[phase]` and bot is not mid-trip (no carried loads, no remaining active-route stops):

```
T<k> [DISCARD]: replace all 3 demand cards with fresh draws (next turn).
  Best current candidate: NET <m>M, <n> turns, score <s>.
```

The LLM may override (e.g., a card connects a target major city even at low score). Pre-LLM hard-gate forces discard when `bestScore < DISCARD_THRESHOLD[phase] − 20`.

## 9. Worked example

**State:** turn 35, deliveries=5, cities=3/7 → MID, OCPT=5.
Bot at Berlin, Fast Freight (cap 2, speed 12), 35M cash. Existing track: Berlin↔Frankfurt↔Bruxelles↔Cardiff.
Hand: cards 6, 7, 10.

**Pattern detection:**
- P1 fires on Hops (card 7 demands Hops→Ruhr; card 10 demands Hops→Holland; supply = Cardiff).
- No other pattern fires across this hand.

**Simulation & scoring:**

| Candidate | Pattern | Tag | Payout | Build | Turns | Net | Score |
|---|---|---|---|---|---|---|---|
| T1 | P1 Hops×2 | medium | 32M | 6M | 7 | 26M | **−9** |
| T2 | single Hops c7 | short | 16M | 3M | 5 | 13M | **−12** |
| T3 | single Cattle c6 | long | 7M | 14M | 9 | −7M | **−52** |

**User prompt menu:**

```
GAME PHASE: MID (turn=35, deliveries=5, cities=3/7)

CANDIDATE MENU (top 3 by score; OCPT=5):

  T1 [P1 Hops×2; medium]: payout 32M, build 6M, 7 turns, NET 26M
    1. PICKUP Hops at Cardiff
    2. PICKUP Hops at Cardiff
    3. DELIVER Hops at Ruhr (card 7, +16M)
    4. DELIVER Hops at Holland (card 10, +16M)

  T2 [single; short]: payout 16M, build 3M, 5 turns, NET 13M
    1. PICKUP Hops at Cardiff
    2. DELIVER Hops at Ruhr (card 7, +16M)

  T3 [single; long]: payout 7M, build 14M, 9 turns, NET −7M
    1. PICKUP Cattle at Bern
    2. DELIVER Cattle at Paris (card 6, +7M)
```

T1 wins; LLM emits a TRIP_PLAN with T1's stop sequence.

## 10. Code surface

| Path | Change |
|---|---|
| `src/server/services/ai/context/PhaseConstants.ts` | New module — see §11 |
| `src/server/services/ai/TripCandidateMenu.ts` | New (~250 LOC) — phase classifier, pattern detectors, simulator integration, scoring, top-K selection, discard gating |
| `src/server/services/ai/TripPlanner.ts` | Skill gate: only invoke `TripCandidateMenu.build()` when `skillLevel === Easy`; pass menu through to prompt builder. No other change to the planTrip control flow. |
| `src/server/services/ai/prompts/systemPrompts.ts` | **Refactor:** decompose `TRIP_PLANNING_SYSTEM_SUFFIX` into the named blocks listed in §6.1 (no string content rewrites — split + re-export). Add new Easy-only blocks (`TRIP_SCORING_PHASE`, `TRIP_PATTERN_DOCS`, `TRIP_PHASE_POSTURE`). `getTripPlanningPrompt` branches on skill to compose `EASY_SYSTEM` vs `MEDIUM_HARD_SYSTEM`. User-prompt builder renders the GAME PHASE + CANDIDATE MENU block in place of OPTIONS for Easy; Medium/Hard path unchanged. |
| `src/server/services/ai/CityRegions.ts` | New (~40 LOC) — peripheral region tables (Appendix B) + `getRegion(city)` + `coRegional(a, b)` |
| `src/server/services/ai/RouteDetourEstimator.ts` | No change — `simulateTrip` consumed as-is |
| `src/server/services/ai/RouteValidator.ts` | No change — still validates LLM-emitted stops |

## 11. Constants (`PhaseConstants.ts`)

```ts
export const OCPT = 5;  // commitment cost per turn — flat across phases

export const LENGTH_TAG_THRESHOLDS = {
  early: { short: 4, medium: 7 },
  mid:   { short: 6, medium: 10 },
  late:  { short: 8, medium: 13 },
} as const;

export const DISCARD_THRESHOLD = { early: -60, mid: -40, late: -25 } as const;

export const DENSE_REGION_NEIGHBOR_HOPS = 3;  // applies only between cities not co-regional via Appendix C
export const TOP_K = 3;
export const DROP_AND_ABANDON_MARGIN = 30;
```

---

## Appendix A — Demand cards 1–10

| Card | Demand 1 | Demand 2 | Demand 3 |
|---|---|---|---|
| 1 | Cheese → Berlin (10M) | Bauxite → Manchester (31M) | Labor → Luxembourg (22M) |
| 2 | Fish → Holland (23M) | Ham → Marseille (37M) | Cars → Leipzig (8M) |
| 3 | Oranges → London (34M) | Chocolate → Munchen (7M) | Iron → Lyon (21M) |
| 4 | Copper → Madrid (46M) | Cheese → Napoli (23M) | Sheep → Nantes (15M) |
| 5 | Potatoes → Milano (24M) | Wood → Praha (18M) | Tobacco → Newcastle (51M) |
| 6 | Cattle → Paris (7M) | Coal → Roma (29M) | Cheese → Oslo (14M) |
| 7 | Hops → Ruhr (16M) | Tobacco → Stockholm (63M) | Imports → Porto (36M) |
| 8 | Flowers → Wien (18M) | Oil → Torino (24M) | Sheep → Sarajevo (44M) |
| 9 | Bauxite → Berlin (14M) | Potatoes → Zurich (20M) | Beer → Sevilla (48M) |
| 10 | Hops → Holland (16M) | Fish → Warszawa (38M) | Sheep → Stuttgart (30M) |

## Appendix B — City regions for P4 / P5 co-regional check

**Peripheral regions** — cost of reaching the region dominates intra-region travel. Any two cities in the same peripheral region are treated as neighbors regardless of hop distance, so a trip that goes to the region picks up multiple loads on principle.

| Region | Cities |
|---|---|
| IBERIA | Lisboa, Porto, Sevilla, Valencia, Madrid, Barcelona, Bilbao |
| UK_IE | Aberdeen, Glasgow, Newcastle, Manchester, Birmingham, London, Cardiff, Belfast, Dublin, Cork |
| SCANDINAVIA | Oslo, Stockholm, Goteborg, Kobenhavn, Arhus |

**Dense Europe** — every city not listed above. P4 / P5 fire only when hop distance ≤ `DENSE_REGION_NEIGHBOR_HOPS` (default 3).

City-region map lives in a new `src/server/services/ai/CityRegions.ts` module: `getRegion(city: string): RegionId | 'dense'`, plus a `coRegional(a, b): boolean` helper that handles the peripheral-vs-dense rule.

## Appendix C — Supply mappings (30 resources)

| Resource | Supply cities |
|---|---|
| Bauxite | Budapest, Marseille |
| Beer | Dublin, Frankfurt, Munchen, Praha |
| Cars | Manchester, Munchen, Stuttgart, Torino |
| Cattle | Bern, Nantes |
| Cheese | Arhus, Bern, Holland, Kobenhavn |
| China | Birmingham, Leipzig |
| Chocolate | Bruxelles, Zurich |
| Coal | Cardiff, Krakow, Wroclaw |
| Copper | Beograd, Wroclaw |
| Cork | Lisboa, Sevilla |
| Fish | Aberdeen, Oslo, Porto |
| Flowers | Holland |
| Ham | Warszawa |
| Hops | Cardiff |
| Imports | Antwerpen, Hamburg |
| Iron | Birmingham, Kaliningrad, Stockholm |
| Labor | Beograd, Sarajevo, Zagreb |
| Machinery | Barcelona, Bremen, Goteborg, Nantes |
| Marble | Firenze |
| Oil | Aberdeen, Beograd, Newcastle, Oslo |
| Oranges | Sevilla, Valencia |
| Potatoes | Belfast, Lodz, Szczecin |
| Sheep | Bilbao, Cork, Glasgow |
| Steel | Birmingham, Luxembourg, Ruhr |
| Tobacco | Napoli |
| Tourists | London, Ruhr |
| Wheat | Lyon, Toulouse |
| Wine | Bordeaux, Frankfurt, Porto, Wien |
| Wood | Oslo, Sarajevo, Stockholm |
