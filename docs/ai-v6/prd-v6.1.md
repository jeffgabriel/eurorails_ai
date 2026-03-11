# PRD v6.1: LLM-Driven Strategy — Enriched Context, Reduced Heuristics

**Shifting decision authority from heuristics to the LLM**
February 2026

**Parent:** [prd-aiLLM.md](./prd-aiLLM.md) (v6.0 — LLM-as-Strategy-Brain)

---

## 1. Problem Statement

v6.0 replaced the Scorer with an LLM for Phase 1+2 decisions but left significant strategic decisions in heuristic code:

| Decision | Currently Decided By | Problem |
|---|---|---|
| Starting hub (initialBuild) | `evaluateHubScore` — picks hub with best single chain score | Bot started in Bilbao instead of central Europe; one delivery then stuck |
| Initial build direction | `rankDemandChains` → `Scorer` heuristic | Heuristic can't reason about track reusability or geographic centrality |
| Which chains to pursue | `rankDemandChains` ROI formula | Doesn't consider multi-chain synergy (chains that share track) |
| When to discard | `calculateDiscardScore` hardcoded thresholds | Required 3 manual patches to stop death-spiral discarding |
| When to upgrade | `calculateUpgradeScore` hardcoded formula | No awareness of archetype strategy or game context |
| Build option ranking | `CHAIN_SCORE_FACTOR` × `chainScore` + `SEGMENT_BONUS` | LLM sees options pre-ranked by heuristic; can only reorder within what's generated |

Each heuristic fix creates new edge cases. The LLM has the strategic reasoning to handle these decisions — it just doesn't have enough context.

### Root Cause: The LLM Is Flying Blind

The LLM currently receives:
- **Your status** (cash, position, loads, train type, connected cities, track corridors)
- **Your demand cards** (with source cities and payments)
- **Movement options** (city, mileposts, fees, delivery annotations)
- **Build options** (target, segments, cost, chain value)

The LLM does **not** receive:
- **Geographic context** — no sense of European geography or city centrality
- **Chain analysis** — no comparison of demand chains by ROI, shared track, or achievability
- **Budget feasibility** — no estimate of whether a chain is completable with current cash
- **Network reuse** — no indication of which builds serve multiple future demands
- **InitialBuild decisions** — the LLM is completely skipped during the first 2 build turns

---

## 2. Design Principle

> **The LLM picks strategy. Heuristics check feasibility. Guardrails prevent catastrophe.**

| Layer | Responsibility | Examples |
|---|---|---|
| **LLM** | Strategic decisions: which chain, where to build, when to upgrade, commit vs pivot | "Build toward Ruhr because 3 of my 9 demands pass through central Europe" |
| **OptionGenerator** | Generate mechanically feasible options with pre-computed costs | Pathfinding, terrain costs, ferry costs, budget limits |
| **Scorer** | Fallback ranking only (when LLM unavailable or fails) | Phase 0/1.5 load actions stay heuristic |
| **GuardrailEnforcer** | Hard safety: bankruptcy prevention, delivery-move override | Cash floor 5M, force delivery when available |
| **PlanValidator** | Structural validity: contiguous segments, budget compliance | Reject non-contiguous builds, over-budget plans |

---

## 3. Changes

### 3.1 Enable LLM During InitialBuild

**Current:** `AIStrategyEngine.takeTurn()` line 134 gates LLM behind `snapshot.gameStatus === 'active'`. During `initialBuild`, only the heuristic Scorer ranks build options.

**Change:** Call the LLM during `initialBuild` too. The LLM should pick the initial build direction based on geographic reasoning, not just ROI math.

**Implementation:**
- Remove the `gameStatus === 'active'` gate on the LLM call
- During initialBuild, movement options are empty (no train placed yet) — the LLM only picks a build option
- Add an `INITIAL BUILD` context section to the prompt explaining: "This is your initial build phase. You have 2 turns to build track before your train is placed. Choose a starting direction that serves multiple demand chains and positions you centrally."

**Files:** `AIStrategyEngine.ts` (gate removal), `GameStateSerializer.ts` (initialBuild context)

---

### 3.2 Add Geographic Context to Prompt

**Current:** The LLM sees city names but has no spatial sense. It doesn't know Madrid is peripheral or that Berlin is central.

**Change:** Add a `GEOGRAPHY` section to the serialized prompt with:

```
GEOGRAPHY (for spatial reasoning):
Major cities: Berlin (central), Paris (west-central), Ruhr (central),
  Holland (northwest), Wien (east), Milano (south-central),
  Madrid (far southwest), Istanbul (far southeast)
Central corridor: Ruhr–Berlin–Wien is the high-traffic backbone of Europe.
Your network currently reaches: [list of regions/cities near your track]
```

This is static knowledge (hardcoded once) — the LLM already knows European geography from training, but explicitly listing major city positions relative to the board anchors its spatial reasoning to the game map.

**Files:** `GameStateSerializer.ts` (new `buildGeographySection`)

---

### 3.3 Add Chain Analysis to Prompt

**Current:** The LLM sees individual build options like `[B0] BUILD: toward Bilbao (10 segments, 13M). Enables Sheep→Toulouse (11M).` It has no way to compare chains or see shared track opportunities.

**Change:** Add a `DEMAND CHAIN ANALYSIS` section computed from `rankDemandChains` output:

```
DEMAND CHAIN ANALYSIS (your 9 demands ranked by achievability):
Best chains:
1. Sheep@Bilbao → Toulouse (11M) — build cost ~13M, 2 turns. Peripheral — no other demands nearby.
2. Cars@Stuttgart → Holland (10M) — build cost ~8M, 1 turn. CENTRAL — shares track with chains 3, 5, 7.
3. Coal@Essen → Berlin (25M) — build cost ~12M, 2 turns. Shares 6 mileposts with chain 2.
Unachievable with current budget:
- Machinery → Istanbul (62M) — needs ~45M track, you have 50M.
```

Key data per chain:
- Pickup city, delivery city, payment
- Estimated build cost (from `rankDemandChains` terrain-aware calculation)
- Estimated total turns (build + travel)
- **Shared track indicator** — how many mileposts overlap with other top chains
- **Budget feasibility** — achievable / tight / unachievable

**Files:** `GameStateSerializer.ts` (new `buildChainAnalysisSection`), `OptionGenerator.ts` (expose `rankDemandChains` results)

---

### 3.4 Add Network Reuse Indicator to Build Options

**Current:** Build options show target, segments, cost, and chain value. No indication of reusability.

**Change:** Annotate each build option with how many other demand chains it serves:

```
[B0] BUILD: toward Stuttgart (8 segments, 8M). Enables Cars→Holland (10M).
     Also serves 2 other demands (Coal→Berlin, Hops→Wien). REUSABLE.
[B1] BUILD: toward Bilbao (10 segments, 13M). Enables Sheep→Toulouse (11M).
     Dead-end — no other demands nearby.
```

The "serves N other demands" count is computed by checking how many other ranked chains have pickup or delivery cities within a threshold distance of the build option's segments.

**Files:** `GameStateSerializer.ts` (enhance `describeBuildOption`), `OptionGenerator.ts` (compute overlap count)

---

### 3.5 Demote Heuristic Scoring to Fallback-Only

**Current:** `buildOrderedCandidates` puts the LLM's choice first, then Scorer-ranked fallbacks. But `evaluateHubScore` and `rankDemandChains` pre-filter which options the LLM even sees.

**Change:**
- Generate **more** build options (top 5 chains instead of top 3) so the LLM has more to choose from
- The Scorer's `calculateBuildTrackScore` remains as fallback ranking only — it does not pre-filter
- `evaluateHubScore` still picks the starting hub for pathfinding (needed for Dijkstra start positions), but the LLM makes the final strategic choice
- Remove `CHAIN_SCORE_FACTOR` from influencing which option the LLM sees first — present options in geographic order or alphabetically, not pre-ranked by heuristic score

**Files:** `OptionGenerator.ts` (increase chain count), `Scorer.ts` (document as fallback-only), `GameStateSerializer.ts` (neutral option ordering)

---

### 3.6 Add System Prompt Rules for Geographic Strategy

**Current:** System prompt has 9 critical rules focused on delivery mechanics and discard prevention. No guidance on geographic positioning.

**Change:** Add rules 10-12:

```
10. STARTING LOCATION: In the first 2 build turns, prefer starting from central Europe
    (Ruhr, Berlin, Paris, Holland) over peripheral cities (Madrid, Istanbul, Lisboa).
    Central starts give access to more demand chains and reusable track corridors.
11. TRACK REUSE: When choosing between build options, prefer directions that serve
    MULTIPLE demand chains over a single high-payment chain. Shared track is the
    most valuable asset in the game.
12. BUDGET AWARENESS: Before committing to a chain, verify you can afford both the
    build cost AND have 5M+ remaining. A half-built route to nowhere is worse than
    a cheap completed delivery.
```

**Files:** `prompts/systemPrompts.ts` (add rules to `COMMON_SYSTEM_SUFFIX`)

---

## 4. What Stays the Same

- **Phase 0/1.5 load actions** — still heuristic via Scorer (deliver/pickup/drop are deterministic)
- **PlanValidator** — structural validation unchanged
- **TurnExecutor** — execution pipeline unchanged
- **GuardrailEnforcer** — hard safety rules unchanged (bankruptcy, delivery-move override, discard protection)
- **ResponseParser** — JSON parsing unchanged
- **Provider adapters** — Anthropic/Google adapters unchanged
- **BotMemory** — state tracking unchanged
- **Strategy Inspector** — still shows LLM reasoning (now richer)

---

## 5. Implementation Order

### Wave 1: Quick Wins (prompt enrichment, no architecture changes)

| Task | Change | Risk |
|---|---|---|
| **5.1** Add geographic context section | New `buildGeographySection` in GameStateSerializer | Low — additive, no behavior change |
| **5.2** Add system prompt rules 10-12 | Append to `COMMON_SYSTEM_SUFFIX` | Low — guidance only |
| **5.3** Enable LLM during initialBuild | Remove `active` gate, add initialBuild context | Medium — LLM now drives initial placement |

### Wave 2: Chain Analysis (requires exposing OptionGenerator internals)

| Task | Change | Risk |
|---|---|---|
| **5.4** Expose chain rankings to serializer | `rankDemandChains` returns results that GameStateSerializer can format | Medium — interface change |
| **5.5** Add chain analysis section to prompt | New `buildChainAnalysisSection` with shared-track computation | Medium — new computation |
| **5.6** Add network reuse indicator to build options | Annotate build options with overlap count | Low — annotation only |

### Wave 3: Reduce Heuristic Influence

| Task | Change | Risk |
|---|---|---|
| **5.7** Generate more build options (top 5 chains) | Increase `chains.slice(0, 3)` to `chains.slice(0, 5)` | Low — more options for LLM |
| **5.8** Present options in neutral order | Remove pre-ranking bias from serialized prompt | Medium — LLM must rank from scratch |
| **5.9** Document Scorer as fallback-only | Code comments + reduce CHAIN_SCORE_FACTOR influence | Low — documentation + minor tuning |

---

## 6. Success Criteria

| Metric | Current (v6.0) | Target (v6.1) |
|---|---|---|
| Bot starts in central Europe | ~30% (depends on card draw) | >70% |
| First delivery within 6 active turns | ~50% | >80% |
| Bot stuck (3+ consecutive PassTurns) | Frequent after 1st delivery | Rare (< 10% of games) |
| Multiple deliveries in first 15 turns | 0-1 | 2+ |
| LLM reasoning mentions geography/reuse | Never | Regularly |
| Guardrail override rate | ~20% of turns | <10% (LLM makes better choices with better context) |

---

## 7. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Longer prompts → higher token cost | Chain analysis section is ~200 tokens. Geography section is ~100 tokens. Total increase <15%. |
| LLM makes worse choices during initialBuild than heuristic | Keep heuristic as fallback. If LLM choice fails PlanValidator, fall back to Scorer-ranked option. |
| More options overwhelm the LLM | Cap at 5 build options shown. Chain analysis pre-summarizes the landscape. |
| Geographic section becomes stale if board layout changes | Geography is derived from `getMajorCityGroups()`, not hardcoded. Regenerated each turn. |

---

## 8. Future Considerations (Out of Scope for v6.1)

- **Multi-turn planning**: LLM outputs a 3-turn plan, not just this turn's choice. Would require plan persistence and re-evaluation.
- **Opponent modeling**: LLM predicts opponent next moves based on their track direction and card probabilities.
- **Dynamic chain re-ranking**: After each delivery, LLM explicitly re-evaluates remaining chains against new cards and budget.
- **Bot-vs-bot testing harness**: Automated games with metrics collection for tuning.
