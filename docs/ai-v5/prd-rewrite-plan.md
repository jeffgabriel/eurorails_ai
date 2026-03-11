# Rewrite AI Rules Engine Spec as Phased PRD

## Context

The current `docs/ai/eurorails-ai-rules-engine-spec.md` has major gaps that prevent an AI coding agent from implementing effectively. It also overstates what's working — the existing bot code is a **prototype that has never successfully played a full game**. In playtesting, the bot:

- Built toward the wrong city and wasted all its money (fixed with chain-based targeting, but fix is unproven at scale)
- Dropped a valuable 43M load because the delivery city wasn't on its network yet (patched, untested)
- Started at Wien for a Fish Aberdeen→Krakow delivery and went bankrupt in 3 turns (patched, untested)
- Has never completed more than 1 delivery in a game
- Has never played beyond ~10 turns without the game being abandoned

**The PRD must be honest**: the existing pipeline is a prototype. The code compiles, tests pass, and individual pieces work in isolation, but the overall behavior is broken. Phase 1's job is to make a bot that can actually play a full game — which means validating, fixing, and possibly reworking the existing code, not just documenting it.

## Deliverable

Complete rewrite of `docs/ai/eurorails-ai-rules-engine-spec.md` as a phased PRD. Preserve good reference content (game rules, archetype descriptions, anti-patterns). Add missing technical sections. Be honest about implementation quality.

## New Document Structure

```
# EuroRails AI Bot — Rules Engine PRD
## 1. Purpose and Scope
## 2. Core Game Rules Summary
   (Carry over existing sections 2.1–2.12 as-is — already accurate)
## 3. Architecture & Data Model
   3.1 Pipeline Overview (4-phase turn)
   3.2 File Map (what exists, with quality assessment)
   3.3 Key Interfaces (WorldSnapshot, FeasibleOption — actual TypeScript)
   3.4 Hex Grid & Pathfinding
   3.5 Multi-Source Dijkstra (computeBuildSegments)
   3.6 Victory Condition Tracking
   3.7 Multi-Action Turn Sequencing
## 4. Implementation Phases
   Overview table showing all 4 phases
## 5. Phase 1: MVP — One Bot Plays a Full Game
   5.1 Definition of Done
   5.2 Archetype: Backbone Builder (single archetype)
   5.3 Known Issues with Current Prototype
   5.4 Chain-Based Build Targeting (current approach + known gaps)
   5.5 Scoring Formulas (current constants — need validation)
   5.6 Critical Behaviors to Validate
   5.7 Integration Test Plan
   5.8 Acceptance Criteria
## 6. Phase 2: All Archetypes + Phase Detection
   6.1 Archetype Enum Rename
   6.2 Archetype Profiles (all 5 — carry over descriptions)
   6.3 Scoring Dimension Matrix
   6.4 ArchetypeProfile Data Structure
   6.5 Phase Detection Logic
   6.6 Phase-Based Weight Modifiers
   6.7 Archetype × Phase Matrix
## 7. Phase 3: Skill Levels + Competitive Play
   7.1 Skill Level Mechanics
   7.2 Opponent Modeling
   7.3 Multi-Delivery Optimization
   7.4 Demand Evaluation Deep Dive
   7.5 Victory-Aware Building
## 8. Phase 4: Events & Edge Cases
   8.1 Event Card System
   8.2 Mercy Rules
   8.3 Track Selling/Trading
## 9. Anti-Patterns and Guardrails
## 10. Strategy Reference (archetype deep dives — Phase 2 material)
## 11. Glossary
```

## Key Framing Decision: Prototype, Not Foundation

The file map should have a **quality column** that's honest:

| File | Purpose | Status | Quality |
|------|---------|--------|---------|
| `AIStrategyEngine.ts` | Pipeline orchestrator, 4-phase turn | Exists | Untested at scale — bot has never completed a full game |
| `WorldSnapshotService.ts` | Game state capture | Exists | Appears solid — single SQL query, tested |
| `OptionGenerator.ts` | Generate feasible options | Exists | Chain targeting added but unproven — original scatter approach caused wrong-city bugs |
| `Scorer.ts` | Score/rank options | Exists | Constants are guesses — SEGMENT_BONUS changed from 3→1, CHAIN_SCORE_FACTOR=20 untested at scale |
| `PlanValidator.ts` | Validate plan legality | Exists | Basic — no cumulative validation across phases |
| `TurnExecutor.ts` | Execute via game server | Exists | Transaction safety added after bugs — individual handlers appear solid |
| `computeBuildSegments.ts` | Dijkstra pathfinding | Exists | Works for building — target-aware selection may need tuning |
| `MapTopology.ts` | Hex grid, neighbors | Exists | Solid — well-tested utility |
| `BotTurnTrigger.ts` | Trigger bot turn | Exists | Housekeeping is best-effort — has caused pipeline issues before |

## Phase 1: What "MVP" Actually Means

**Definition of Done**: A single Backbone Builder bot plays a 2-player game (1 human + 1 bot) for 50+ turns without:
- Crashing or freezing
- Going bankrupt (money < 0)
- Getting stuck in a loop (same action repeated 5+ turns)
- Holding loads indefinitely (>10 turns without delivering)
- Building track that serves no demand

**And the bot must**:
- Complete at least 3 deliveries in 50 turns
- Upgrade its train at least once
- Earn at least 100M ECU
- Build a coherent (non-scattered) track network

### Known Issues That Must Be Fixed for Phase 1

1. **Multi-delivery sequencing is broken**: Bot completes first delivery but fails to find/execute second. The 4-phase turn (Phase 0→1→1.5→2) may have coordination issues between phases.

2. **Scoring constants are unvalidated guesses**: Every constant (SEGMENT_BONUS=1, CHAIN_SCORE_FACTOR=20, BUILD_BASE_SCORE=10, etc.) was set by intuition, not data. The bot's behavior is highly sensitive to these — changing SEGMENT_BONUS from 3→1 completely changed starting city selection. These need systematic tuning.

3. **Drop load logic is fragile**: The "protect loads with payment >= 20M" threshold is arbitrary. A more principled approach would evaluate whether the bot is actively building toward the delivery city.

4. **No state continuity between turns**: The bot re-evaluates everything from scratch each turn. It has no memory of what it was trying to do last turn. This causes oscillation — building toward City A one turn, City B the next, never completing either.

5. **Build direction can oscillate**: Chain ranking may produce different top-3 chains each turn if distances change slightly as track is built, causing the bot to switch targets.

6. **Upgrade timing has no strategy**: UpgradeTrain scores 2 (early) or 8+ (late), but there's no principled logic for WHEN to upgrade. The bot may upgrade too early (wasting money) or never (leaving speed on the table).

7. **DiscardHand is almost never chosen**: Score of 1 means the bot will almost never discard even with terrible cards. This may be correct or may trap the bot with uncompletable demands.

8. **Victory tracking not connected**: VictoryService exists (client + server) but the bot never checks or builds toward victory condition (7 connected major cities + 250M). For Phase 1, we defer victory DECLARATION but the bot should at least not actively work against victory.

### Phase 1 Approach: Validate Then Fix

The PRD should instruct the implementing agent to:
1. **Set up an automated test harness**: Run bot vs bot games for 100 turns, log every decision, detect failure modes (bankruptcy, loops, stuck states)
2. **Fix issues in priority order**: Multi-delivery sequencing first (it's the core game loop), then scoring tuning, then edge cases
3. **Tune constants empirically**: Run 10+ automated games, analyze decision logs, adjust constants based on observed behavior — not intuition

### What to Defer from Phase 1

| Feature | Defer to | Rationale |
|---------|----------|-----------|
| Phase detection | Phase 2 | Bot can use simple heuristics (initialBuild vs active) |
| Victory-aware building | Phase 3 | Focus on basic competence first |
| Bot declaring victory | Phase 3 | Game engine detects victory |
| Multiple archetypes | Phase 2 | One archetype working well > 5 archetypes working poorly |
| Skill levels | Phase 3 | MVP uses single difficulty |
| Opponent awareness | Phase 3 | Not needed for 1v1 testing |
| Event cards | Phase 4 | Not in game engine |
| Mercy rules | Phase 3 | Fix the bot so it doesn't need mercy |

## Section 3: Architecture (New Content)

### 3.1 Pipeline Overview
Document the 4-phase turn:
- Phase 0: Deliver/pickup/drop at current position (before movement)
- Phase 1: Move toward demand city (3 retries)
- Phase 1.5: Deliver/pickup/drop at new position (after movement)
- Phase 2: Build track or upgrade (3 retries, PassTurn fallback)
- Snapshot refreshes between phases
- `executeLoadActions()` runs deliveries first, then drops, then pickups

### 3.3 Key Interfaces
Include actual TypeScript from GameTypes.ts:
- WorldSnapshot (full interface)
- FeasibleOption (full interface with all optional fields)
- TrackSegment, BotConfig, ResolvedDemand

### 3.4 Hex Grid
- Even rows: neighbors offset left — NW:(row-1,col-1), NE:(row-1,col)
- Odd rows: neighbors offset right — NW:(row-1,col), NE:(row-1,col+1)
- 6 neighbors per hex, water terrain filtered out
- Grid loaded from configuration/gridPoints.json, cached in memory

### 3.5 computeBuildSegments
- Multi-source Dijkstra from all track endpoints (or major cities if no track)
- Budget-constrained (20M/turn)
- Target-aware: prioritizes paths toward specified GridCoord[] targets
- Right-of-way: skips edges owned by opponents
- Intra-city rule: no edges between outposts of same major city

### 3.6 Victory Tracking
- VictoryService (client) uses BFS on track graph + implicit major city edges
- 8 major cities: Paris, Holland, Milano, Ruhr, Berlin, London, Wien, Madrid
- Need 7 connected via continuous track
- Plus 250M cash (net of debt)
- Bot does NOT currently use this — Phase 3

### 3.7 Multi-Action Turn Sequencing
- AIStrategyEngine runs 4 phases per turn (not single-action)
- TurnExecutor handles ONE action per call
- AIStrategyEngine orchestrates the sequence
- Snapshot refreshes between phases to reflect state changes

## Section 5.5: Scoring Formulas (Current — Need Validation)

Document with caveat that these are unvalidated:
- BuildTrack: `BASE(10) + segments×1 - cost×0.5 + chainScore×20 + cityBonus(5)`
- MoveTrain: `BASE(15) + distanceBonus + payoffBonus - usageFee`
- DeliverLoad: `100 + payment×2` (highest priority — immediate income)
- PickupLoad: `50 + payment×0.5` (or 25 aspirational)
- DropLoad: `5 ± contextual` (protect high-value loads ≥20M payment)
- UpgradeTrain: `2` (early) → `8 + bonuses` (late)
- DiscardHand: `1`
- PassTurn: `0`
- Infeasible: `-Infinity`

**Note in PRD**: These constants were set by intuition. Small changes (e.g., SEGMENT_BONUS 3→1) completely change bot behavior. Phase 1 must include empirical tuning.

## Archetype Naming

The spec defines new archetype names that don't match the current `BotArchetype` enum:

| Spec Name | Current Enum Value | Phase 2 Rename |
|-----------|-------------------|----------------|
| Backbone Builder | Balanced | BackboneBuilder |
| Freight Optimizer | (new) | FreightOptimizer |
| Trunk Sprinter | Aggressive | TrunkSprinter |
| Continental Connector | Defensive | ContinentalConnector |
| Opportunist | Opportunistic | Opportunist |
| Blocker (Phase 2 addition) | BuilderFirst | Blocker |

Phase 2 will rename the enum. Phase 1 uses "Balanced" (Backbone Builder) only.

## Existing Content to Preserve

Move to appropriate phases:
- Game rules (section 2/3) → Keep as section 2 (already accurate)
- Archetype descriptions (4.1–4.6) → Phase 2 reference (section 10)
- Scoring multiplier table (section 11) → Phase 2 reference
- Anti-patterns (section 9) → Keep as section 9, tag by phase
- Demand evaluation (section 7) → Phase 3 reference
- Aberdeen-Krakow anti-pattern → Phase 1 (design rationale for chain targeting)

## Verification
1. Cross-reference file paths against actual code
2. Verify scoring formulas match Scorer.ts (note: these change frequently)
3. Confirm all 11 original gaps are addressed
4. Read through for internal consistency
5. Ensure the tone is honest about quality — prototype, not finished product
