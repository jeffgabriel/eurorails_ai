# LLM-as-Strategy-Brain: Integration Specification v2

**Replacing both the OptionGenerator and Scorer with LLM + ActionResolver**
February 2026 | v2.0

---

## 1. The Problem This Solves

### 1.1 What failed

The current architecture has a 4-stage pipeline: WorldSnapshot → **OptionGenerator** → **Scorer** → TurnExecutor.

The Scorer was replaced by an LLM call in v1 of this spec. That worked — the LLM makes better strategic choices than hand-tuned heuristic multipliers. But testing revealed that **the OptionGenerator is now the primary source of defects**. It has been the root cause across all 5 implementation attempts:

- **P1**: BuildTrack options lacked segments — the key data TurnExecutor needs
- **P3**: Multi-source Dijkstra broke when start and target sets overlapped, producing zero-edge paths
- **P3.1**: The `cost > 0` fix for P3 was wrong — target nodes could never be discovered through actual traversal because they were pre-initialized at cost 0
- **P4**: Options were generated for unreachable cities, loads that weren't available, and track paths that didn't exist
- **Current**: LLM strategy brain works well, but keeps receiving malformed or incomplete options from the OptionGenerator

The OptionGenerator attempts to do two fundamentally different things simultaneously:

1. **Enumerate every possible action** the bot could take (creative/strategic)
2. **Validate and pre-compute** each action with pathfinding, cost calculation, and feasibility checking (mechanical/precise)

It fails at both because they're in tension. Enumeration requires imagination and completeness; validation requires precision and conservatism. Every bug has been at the boundary: an option that was enumerated but not properly validated, or a valid option that was never enumerated because the pathfinding failed.

### 1.2 The insight

The LLM is already good at #1 (deciding what to do). The existing shared services are already good at #2 (validating whether an action is legal). The OptionGenerator is a broken bridge between them.

**This spec eliminates the OptionGenerator entirely.** The LLM receives game state and decides what it wants to do. A new `ActionResolver` module translates that intent into concrete game actions using the existing shared services, then validates them. If the action is illegal, the LLM is told why and gets one retry.

### 1.3 What this changes from v1 of this spec

v1 replaced the Scorer with an LLM call but kept the OptionGenerator as-is. The LLM picked from a pre-generated menu of options. v2 eliminates the menu entirely — the LLM receives game state and expresses strategic intent, which is then resolved and validated by code that already exists and works.

---

## 2. Architecture

### 2.1 Old pipeline (being replaced)

```
AIStrategyEngine.takeTurn()
  ├─ WorldSnapshot.capture()
  ├─ OptionGenerator.generate()     ← REMOVING: complex, buggy, source of most defects
  ├─ Scorer / LLM.selectOption()    ← REMOVING: menu-based selection
  ├─ PlanValidator.validate()
  └─ TurnExecutor.execute()
```

### 2.2 New pipeline

```
AIStrategyEngine.takeTurn()
  │
  ├─ 1. WorldSnapshot.capture()              ← KEEP: unchanged
  │
  ├─ 2. ContextBuilder.build()               ← NEW: replaces OptionGenerator
  │     Computes decision-relevant context from the snapshot using
  │     existing shared services. Does NOT enumerate options.
  │     Output: structured game state description for the LLM.
  │
  ├─ 3. LLMStrategyBrain.decideAction()      ← CHANGED: no longer picks from menu
  │     Sends game context + archetype system prompt to Claude API.
  │     LLM returns strategic intent: what it wants to do and why.
  │     Output: LLMActionIntent (e.g., "build toward Zurich", "deliver Wine to Vienna")
  │
  ├─ 4. ActionResolver.resolve()             ← NEW: replaces PlanValidator
  │     Translates LLM intent into concrete game actions using shared services.
  │     Runs pathfinding, computes segments, checks feasibility.
  │     If illegal → sends error back to LLM for 1 retry.
  │     Output: TurnPlan (executable sequence of atomic actions)
  │
  ├─ 5. GuardrailEnforcer.check()            ← KEEP: post-validation safety net
  │     Hard rules override (never pass when delivery possible, etc.)
  │
  └─ 6. TurnExecutor.execute()               ← KEEP: unchanged
        Calls shared human-player functions.
        If execution fails → PassTurn fallback. Turn always completes.
```

### 2.3 What's kept, what's removed, what's new

| Module | Status | Notes |
|---|---|---|
| `WorldSnapshot` | **KEEP** | Unchanged. Captures immutable game state. |
| `OptionGenerator` | **REMOVE** | Source of most defects across all attempts. |
| `Scorer` | **REMOVE** | Already replaced by LLM in v1. |
| `PlanValidator` | **REMOVE** | Validation logic absorbed into ActionResolver. |
| `TurnExecutor` | **KEEP** | Unchanged. Calls shared human-player functions. |
| `AIStrategyEngine` | **MODIFY** | Orchestrator rewired for new pipeline. |
| `ContextBuilder` | **NEW** | Computes game context for the LLM prompt. |
| `LLMStrategyBrain` | **MODIFY** | No longer selects from a menu; receives open-ended context. |
| `ActionResolver` | **NEW** | Translates LLM intent → concrete game actions. |
| `GuardrailEnforcer` | **KEEP** | Unchanged. Hard rules safety net. |
| `BotTurnTrigger` | **KEEP** | Unchanged. Turn scheduling and lifecycle. |
| All shared services | **KEEP** | `PlayerService`, `TrackBuildingService`, `TrackNetworkService`, `LoadService`, `DemandDeckService`, `trackUsageFees`, `InitialBuildService` — all unchanged. |

### 2.4 Existing code inventory

**Files being REMOVED** (stop calling, eventually delete):

- `src/server/services/ai/OptionGenerator.ts` — the problematic enumeration + feasibility module. Contains `computeBuildSegments()` and `buildInitialTrackSegments()` which should be **extracted** to a standalone utility before deletion (see section 3.2).
- `src/server/services/ai/Scorer.ts` — already replaced by LLM in v1.
- `src/server/services/ai/PlanValidator.ts` — validation absorbed into ActionResolver.

**Files being MODIFIED:**

- `src/server/services/ai/AIStrategyEngine.ts` — rewire `takeTurn()` to new pipeline. The retry loop, PassTurn fallback, and StrategyAudit emission are kept.
- `src/server/services/ai/LLMStrategyBrain.ts` — change from menu-selection to open-ended intent. System prompts and API integration stay.

**Files being CREATED:**

- `src/server/services/ai/ContextBuilder.ts` — new module.
- `src/server/services/ai/ActionResolver.ts` — new module.

**Files already extracted (no extraction needed):**

- `src/server/services/ai/computeBuildSegments.ts` — already exists as a standalone module with `computeBuildSegments()` and `estimateBuildCost()`. This IS the "BuildPathfinder" referenced in this spec. No extraction from OptionGenerator needed — it was already done.

**Files UNCHANGED:**

- `src/server/services/ai/WorldSnapshot.ts`
- `src/server/services/ai/GuardrailEnforcer.ts`
- `src/server/services/ai/BotTurnTrigger.ts`
- All shared services: `PlayerService`, `TrackService`, `TrackBuildingService`, `TrackNetworkService`, `LoadService`, `DemandDeckService`, `InitialBuildService`
- All shared utilities: `trackUsageFees`, `buildTrackNetwork` (standalone function in TrackNetworkService.ts)
- Client: `StrategyInspectorModal` (UI changes only, not structural)

---

## 3. ContextBuilder: Replacing OptionGenerator's Useful Parts

The OptionGenerator did two things: enumerate options (being removed) and compute context (worth keeping). The `ContextBuilder` keeps the computation, drops the enumeration.

### 3.1 What it computes

All of these use **existing shared services** — no new pathfinding or validation code.

```typescript
// src/server/services/ai/ContextBuilder.ts

interface GameContext {
  // Bot state
  position: { city?: string; row: number; col: number } | null;
  money: number;
  trainType: string;
  speed: number;
  capacity: number;
  loads: string[];
  connectedMajorCities: string[];
  totalMajorCities: number;
  trackSummary: string;    // "22 mileposts: Lyon–Paris, Lyon–Marseille, Marseille–Bordeaux"
  turnBuildCost: number;   // how much already spent building this turn

  // Demand cards with pre-computed reachability
  demands: DemandContext[];

  // What's immediately possible (simple checks, not full enumeration)
  canDeliver: DeliveryOpportunity[];
  reachableCities: string[];
  canUpgrade: boolean;
  canBuild: boolean;
  isInitialBuild: boolean;

  // Opponent data (skill-level filtered)
  opponents: OpponentContext[];

  // Game metadata
  phase: string;
  turnNumber: number;
}

interface DemandContext {
  cardIndex: number;
  loadType: string;
  supplyCity: string;
  deliveryCity: string;
  payout: number;
  isSupplyReachable: boolean;
  isDeliveryReachable: boolean;
  estimatedTrackCostToSupply: number;   // 0 if already reachable
  estimatedTrackCostToDelivery: number;
  isLoadAvailable: boolean;
  isLoadOnTrain: boolean;
  ferryRequired: boolean;
}

interface DeliveryOpportunity {
  loadType: string;
  deliveryCity: string;
  payout: number;
  cardIndex: number;
}

interface OpponentContext {
  name: string;
  money: number;
  trainType: string;
  position: string;
  loads: string[];
  trackCoverage: string;
  recentBuildDirection?: string;   // Hard only
}
```

### 3.2 How it uses existing code

| Context Field | Existing Service | Call |
|---|---|---|
| `reachableCities` | **New: BFS from bot position** | `getReachableMileposts()` returns ALL network nodes, not distance-limited. ContextBuilder must implement a BFS/Dijkstra from the bot's current position with a depth limit of `speed` mileposts to get cities reachable this turn. |
| `connectedMajorCities` | `TrackNetworkService` | `.isConnected(network, cityA, cityB)` — requires pre-built network via `buildTrackNetwork(segments)`. Check connectivity between each pair of major city mileposts. |
| `isSupplyReachable` | `TrackNetworkService` | `.findPath(network, botPosition, supplyCity)` — requires pre-built network |
| `estimatedTrackCost` | **Extract from OptionGenerator** | `BuildPathfinder.estimateCost(frontier, target)` — see below |
| `isLoadAvailable` | `LoadService` (partial) + **new runtime check** | `.isLoadAvailableAtCity(loadType, city)` only checks static config (whether a city *produces* that load type). It does NOT check whether any copies are currently available (vs. on other trains). ContextBuilder must also check load chip counts from the game state to determine actual runtime availability. Note: the signature is `(loadType, city)`, not `(city, loadType, gameId)`. |
| `canDeliver` | Simple array logic | bot at city + load on train + demand on card |
| `canUpgrade` | Simple lookup | money >= 20M + valid upgrade from current train type |
| `trackSummary` | New formatting code | Extract city names from segments, identify corridors |
| `opponents` | `WorldSnapshot` | Already captured in snapshot |
| `phase` | New but simple | Conditionals on money / deliveries / cities per rules engine spec 3.7 |

### 3.3 BuildPathfinder — Already Extracted

The Dijkstra pathfinding logic already exists as a standalone module at `src/server/services/ai/computeBuildSegments.ts` with tests at `src/server/__tests__/computeBuildSegments.test.ts`. **No extraction from OptionGenerator is needed.**

Key functions available:

- **`computeBuildSegments(startNodes, targetNodes, budget, gridPoints, existingSegments, ...)`** — Multi-source Dijkstra from the bot's track frontier toward a target city within a budget. Returns `TrackSegment[]`. KEY FIX from P3.1: `cost > 0` check prevents start=target overlap matches.
- **`estimateBuildCost(fromPositions, toPositions, gridPoints)`** — Estimates cost to connect frontier to target. Returns 0 if already connected.
- **`buildInitialTrackSegments(majorCityPositions, demandTargets, budget, gridPoints)`** — Cold-start: builds from closest major city toward demand targets when bot has no track.

These are the functions the ActionResolver's BUILD resolution should call directly. The spec's `BuildPathfinder` class is just a reference name for this existing module.

### 3.4 What ContextBuilder does NOT do

- Does not enumerate all possible BuildTrack destinations
- Does not generate PickupAndDeliver option combinations
- Does not score or rank anything
- Does not compute concrete track segments (ActionResolver does this)
- Does not check multi-step feasibility chains

---

## 4. LLM Prompt Design (Updated for Open-Ended Decisions)

### 4.1 System Prompts

System prompts are **unchanged from v1**. Each archetype (Backbone Builder, Freight Optimizer, Trunk Sprinter, Continental Connector, Opportunist, Blocker) gets its personality prompt defining philosophy, play style, and weaknesses. See v1 spec section 3.1 for the full text of each.

### 4.2 Common System Prompt Suffix (Updated for intent-based responses)

```text
GAME RULES REFERENCE:
- Victory: 250M+ ECU cash AND track connecting 7 of 8 major cities
- Turn actions (in order): Move train → Pick up/deliver loads → Build track → End turn
- OR instead of building: Upgrade train (20M) | Discard hand (draw 3 new cards, ends turn)
- Demand cards: 3 cards, 3 demands each, only 1 per card can be fulfilled
- Track building: up to 20M per turn. Terrain costs: Clear 1M, Mountain 2M, Alpine 5M
- Ferry penalty: Lose all remaining movement, start next turn at half speed
- Track usage fee: 4M to use opponent's track per opponent per turn
- Loads: Globally limited (3-4 copies). If all on trains, no one can pick up.
- First track must start from a major city.

AVAILABLE ACTIONS:
- DELIVER: Deliver a load you're carrying at a demand city you're currently at
- MOVE: Move your train along existing track (up to speed limit)
- PICKUP: Pick up a load at a supply city you're at (if available and you have capacity)
- BUILD: Build new track extending your network (up to 20M this turn)
- UPGRADE: Buy a better train for 20M (no track building this turn)
- DISCARD_HAND: Discard all 3 demand cards, draw 3 new ones, end turn immediately
- PASS: End turn without acting

You can combine actions in a single turn (e.g., MOVE to a city, DELIVER a load, then BUILD).
You CANNOT combine UPGRADE (20M) with BUILD, or DISCARD_HAND with anything.

RESPONSE FORMAT — respond with ONLY this JSON, no markdown fences:
For a single action:
{
  "action": "<ACTION_TYPE>",
  "details": {
    // BUILD: { "toward": "<city name>", "purpose": "<why>" }
    // MOVE: { "to": "<city name>" }
    // DELIVER: { "load": "<load type>", "at": "<city name>" }
    // PICKUP: { "load": "<load type>", "at": "<city name>" }
    // UPGRADE: { "to": "<train type>" }
    // DISCARD_HAND or PASS: {} (empty)
  },
  "reasoning": "<1-2 sentences in character>",
  "planHorizon": "<what this sets up for next 2-3 turns>"
}

For multiple actions in one turn:
{
  "actions": [
    { "action": "MOVE", "details": { "to": "Vienna" } },
    { "action": "DELIVER", "details": { "load": "Wine", "at": "Vienna" } },
    { "action": "BUILD", "details": { "toward": "Budapest", "purpose": "Extend east" } }
  ],
  "reasoning": "...",
  "planHorizon": "..."
}
```

### 4.3 User Prompt Template

```text
TURN {turnNumber} — GAME PHASE: {phase}

YOUR STATUS:
- Cash: {money}M ECU (minimum reserve: 5M)
- Train: {trainType} (speed {speed}, capacity {capacity}, carrying {loads or "nothing"})
- Position: {positionDescription}
- Major cities connected: {connectedCount}/8 ({cityNames})
- Track network: {trackSummary}
- Build budget remaining this turn: {20 - turnBuildCost}M

YOUR DEMAND CARDS:
Card 1 (pick at most one):
  a) {load} from {supply} → {delivery} ({payout}M) — {reachabilityNote}
  b) ...
  c) ...
Card 2 (pick at most one):
  a) ...
  b) ...
  c) ...
Card 3 (pick at most one):
  a) ...
  b) ...
  c) ...

{immediateOpportunities}

CITIES REACHABLE THIS TURN (within speed {speed} on existing track):
{reachableCitiesList}

{upgradeOptions}
{buildConstraints}

{opponentSection}
```

### 4.4 Reachability Notes for Demands

Each demand gets a contextual annotation based on ContextBuilder data:

| Situation | Note |
|---|---|
| Load on train + at delivery city | `"DELIVERABLE NOW for {payout}M"` |
| Load on train + delivery reachable | `"{load} ON YOUR TRAIN. {delivery} reachable ({distance} mileposts away)"` |
| Load on train + delivery not reachable | `"{load} ON YOUR TRAIN. {delivery} not reachable (~{cost}M track needed)"` |
| Supply reachable + delivery reachable | `"Supply at {supply} (reachable). Delivery reachable."` |
| Supply reachable + delivery not reachable | `"Supply at {supply} (reachable). Delivery needs ~{cost}M track."` |
| Supply not reachable | `"Supply not reachable (~{cost}M track needed)."` |
| Load unavailable | `"UNAVAILABLE — all {load} copies on other trains."` |
| Ferry required | Append `"Requires ferry crossing (movement penalty)."` |

### 4.5 Immediate Opportunities Section

When the bot can take an obvious high-value action right now, call it out explicitly:

```text
IMMEDIATE OPPORTUNITIES:
- You can DELIVER Wine at Vienna for 48M (Card 1a) — you're at Vienna with Wine!
- You can PICKUP Coal at Newcastle (reachable, 2 copies available, you have capacity)
```

Or if there are none:

```text
IMMEDIATE OPPORTUNITIES:
- No deliveries completable this turn.
- No loads available for pickup at reachable cities matching your demands.
```

This guides the LLM toward high-value immediate actions without the OptionGenerator's full enumeration.

### 4.6 Example: Fully Rendered User Prompt

```text
TURN 14 — GAME PHASE: Early Game

YOUR STATUS:
- Cash: 87M ECU (minimum reserve: 5M)
- Train: Freight (speed 9, capacity 2, carrying Wine)
- Position: Lyon (major city)
- Major cities connected: 2/8 (Paris, Marseille)
- Track network: 22 mileposts covering Lyon–Paris, Lyon–Marseille, Marseille–Bordeaux
- Build budget remaining this turn: 20M

YOUR DEMAND CARDS:
Card 1 (pick at most one):
  a) Wine from Bordeaux → Vienna (48M) — Wine ON YOUR TRAIN. Vienna not reachable (~15M track needed via Zurich)
  b) Steel from Essen → Barcelona (52M) — supply not reachable (~25M track). Delivery not reachable (~14M track)
  c) Cheese from Bern → London (28M) — supply not reachable (~8M track). Delivery requires ferry crossing.
Card 2 (pick at most one):
  a) Oranges from Valencia → Hamburg (38M) — supply not reachable (~18M track). Delivery not reachable.
  b) Machinery from Milano → Moscow (62M) — supply not reachable (~10M track). Delivery very far (~45M+ track)
  c) Fruit from Sevilla → Berlin (34M) — supply not reachable (~20M track). Delivery not reachable.
Card 3 (pick at most one):
  a) Coal from Newcastle → Roma (44M) — supply requires ferry. Delivery not reachable (~20M track).
  b) Oil from Ploiesti → Paris (50M) — supply very far east (~40M+ track). Delivery reachable!
  c) Hops from Cardiff → Wien (26M) — supply requires ferry. Delivery not reachable.

IMMEDIATE OPPORTUNITIES:
- No deliveries completable this turn (Wine → Vienna requires track to Vienna).
- No loads available for pickup at reachable cities matching your demands.

CITIES REACHABLE THIS TURN (within speed 9 on existing track):
Paris, Marseille, Bordeaux, and mileposts between them.

YOU CAN UPGRADE: Fast Freight (speed 12, capacity 2) for 20M, or Heavy Freight (speed 9, capacity 3) for 20M.

OPPONENTS:
- Alice: 95M, Fast Freight, at Berlin, carrying Coal. Track covers Hamburg–Berlin–Wien.
- Bot-3: 72M, Freight, at Essen, carrying Steel. Track covers Essen–Ruhr–Frankfurt.
```

### 4.7 Example LLM Response

```json
{
  "action": "BUILD",
  "details": {
    "toward": "Zurich",
    "purpose": "Extend backbone east toward Vienna for Wine delivery (48M)"
  },
  "reasoning": "Wine to Vienna is my best demand at 48M and I'm already carrying it. Zurich is on my backbone corridor and gets me closer to Wien while also opening southern routes.",
  "planHorizon": "Reach Zurich in 1-2 more build turns, then deliver Wine→Vienna."
}
```

### 4.8 Multi-Action Response Example

```json
{
  "actions": [
    { "action": "MOVE", "details": { "to": "Marseille" } },
    { "action": "PICKUP", "details": { "load": "Oranges", "at": "Marseille" } },
    { "action": "BUILD", "details": { "toward": "Toulouse", "purpose": "Extend toward Barcelona" } }
  ],
  "reasoning": "Picking up Oranges at Marseille while building toward Barcelona. Combined deliveries from the south.",
  "planHorizon": "Complete Oranges→Hamburg by heading north through my backbone."
}
```

---

## 5. ActionResolver: Translating Intent to Executable Actions

This is the new module that replaces both the OptionGenerator's enumeration and PlanValidator's validation. It's dramatically simpler because it only handles **one specific action** rather than enumerating all possible actions.

### 5.1 Core Design

```typescript
// src/server/services/ai/ActionResolver.ts

interface ResolvedAction {
  success: boolean;
  plan?: TurnPlan;
  error?: string;       // human-readable error for LLM retry
}

class ActionResolver {
  constructor(
    private snapshot: WorldSnapshot,
    private trackNetworkService: TrackNetworkService,
    private trackBuildingService: TrackBuildingService,
    private loadService: LoadService,
    private buildPathfinder: BuildPathfinder,
  ) {}

  async resolve(intent: LLMActionIntent): Promise<ResolvedAction> {
    if (intent.actions) {
      return this.resolveMultiAction(intent.actions);
    }
    return this.resolveSingleAction(intent);
  }
}
```

### 5.2 BUILD Resolution

The most complex resolver because it bridges "build toward Zurich" (intent) with "build these specific hex segments" (executable). Uses the `BuildPathfinder` extracted from OptionGenerator.

```typescript
private async resolveBuild(details: { toward: string }): Promise<ResolvedAction> {
  const targetCity = details.toward;

  const targetMilepost = this.findCityMilepost(targetCity);
  if (!targetMilepost) {
    return { success: false, error: `City "${targetCity}" not found on the map.` };
  }

  const remainingBudget = 20 - this.snapshot.turnBuildCost;
  if (remainingBudget <= 0) {
    return { success: false, error: `No build budget remaining this turn (already spent ${this.snapshot.turnBuildCost}M of 20M limit).` };
  }

  // Use extracted BuildPathfinder (was OptionGenerator.computeBuildSegments)
  const frontier = this.getTrackFrontier();

  if (frontier.length === 0) {
    // Cold start: no track yet. Use initial build logic.
    const segments = BuildPathfinder.buildInitialTrackFromMajorCity(
      this.snapshot.majorCities, [targetMilepost], remainingBudget, this.snapshot.hexGrid
    );
    if (!segments || segments.length === 0) {
      return { success: false, error: `Cannot build: no track yet and no valid starting major city found. First track must start from a major city.` };
    }
    return { success: true, plan: { type: 'BuildTrack', segments } };
  }

  const segments = BuildPathfinder.computeBuildSegments(
    frontier, targetMilepost, remainingBudget, this.snapshot.hexGrid
  );

  if (!segments || segments.length === 0) {
    return { success: false, error: `Cannot build toward ${targetCity}: no valid path from your track frontier within ${remainingBudget}M budget. Try a closer destination or build in that general direction.` };
  }

  // Validate each segment using TrackBuildingService helpers.
  // NOTE: addPlayerTrack() has NO dryRun option — it mutates state.
  // TrackBuildOptions only has { turnBudget?: number }.
  // For validation, use the service's public helpers directly:
  //   - isValidConnection(from, to) for adjacency/water checks
  //   - calculateNewSegmentCost(from, to) for cost within budget
  //   - City connection limit checks (medium city max 3 players, etc.)
  // Do NOT call addPlayerTrack() during resolution — only during execution.
  for (const seg of segments) {
    if (!this.trackBuildingService.isValidConnection(seg.from, seg.to)) {
      return { success: false, error: `Segment ${this.describeMilepost(seg.from)}→${this.describeMilepost(seg.to)} is not a valid connection.` };
    }
  }

  return { success: true, plan: { type: 'BuildTrack', segments } };
}
```

### 5.3 MOVE Resolution

```typescript
private async resolveMove(details: { to: string }): Promise<ResolvedAction> {
  const targetMilepost = this.findCityMilepost(details.to);
  if (!targetMilepost) {
    return { success: false, error: `City "${details.to}" not found.` };
  }

  // Use existing TrackNetworkService pathfinding.
  // NOTE: findPath requires (network, from, to) — the network must be built
  // from the bot's track segments first using buildTrackNetwork().
  const network = buildTrackNetwork(this.snapshot.botTrackSegments);
  const path = this.trackNetworkService.findPath(network, this.snapshot.botPosition, targetMilepost);
  if (!path) {
    return { success: false, error: `${details.to} is not connected to your track network. You need to BUILD track to reach it.` };
  }

  if (path.length - 1 > this.snapshot.remainingMovement) {
    return { success: false, error: `${details.to} is ${path.length - 1} mileposts away but you only have ${this.snapshot.remainingMovement} movement points this turn.` };
  }

  // Use existing trackUsageFees utility.
  // NOTE: Must pass majorCityGroups and ferryEdges for correct fee
  // calculation through major city red areas and across ferries.
  // Return type is TrackUsageComputation { isValid, path, ownersUsed: Set<string> }.
  // There is no `totalFee` field — compute it as 4M × ownersUsed.size.
  const fees = computeTrackUsageForMove({
    allTracks: this.snapshot.allPlayerTracks,
    from: this.snapshot.botPosition,
    to: targetMilepost,
    currentPlayerId: this.snapshot.playerId,
    majorCityGroups: this.snapshot.majorCityGroups,
    ferryEdges: this.snapshot.ferryEdges,
  });

  if (!fees.isValid) {
    return { success: false, error: `No valid path to ${details.to} on the union track graph.` };
  }

  const totalFee = fees.ownersUsed.size * 4; // 4M per opponent whose track is used
  if (this.snapshot.money - totalFee < 5) {
    return { success: false, error: `Moving to ${details.to} costs ${totalFee}M in track fees, leaving ${this.snapshot.money - totalFee}M (below 5M minimum).` };
  }

  return { success: true, plan: { type: 'MoveTrain', path, fees, totalFee } };
}
```

### 5.4 DELIVER Resolution

```typescript
private async resolveDeliver(details: { load: string; at: string }): Promise<ResolvedAction> {
  if (!this.isAtCity(details.at)) {
    return { success: false, error: `You are not at ${details.at}. MOVE there first.` };
  }
  if (!this.snapshot.loads.includes(details.load)) {
    return { success: false, error: `You are not carrying ${details.load}. Your loads: ${this.snapshot.loads.join(', ') || 'empty'}.` };
  }
  const demand = this.findMatchingDemand(details.load, details.at);
  if (!demand) {
    return { success: false, error: `No demand card matches ${details.load} → ${details.at}. Check your cards.` };
  }
  return { success: true, plan: { type: 'DeliverLoad', load: details.load, city: details.at, cardId: demand.cardId, payout: demand.payout } };
}
```

### 5.5 PICKUP Resolution

```typescript
private async resolvePickup(details: { load: string; at: string }): Promise<ResolvedAction> {
  if (!this.isAtCity(details.at)) {
    return { success: false, error: `You are not at ${details.at}. MOVE there first.` };
  }
  if (this.snapshot.loads.length >= this.snapshot.trainCapacity) {
    return { success: false, error: `Train is full (${this.snapshot.loads.length}/${this.snapshot.trainCapacity}). Deliver a load first.` };
  }
  // NOTE: isLoadAvailableAtCity(loadType, city) only checks static config
  // (whether the city produces that load type). It does NOT check runtime
  // availability (whether copies are on other trains). We need both checks.
  const cityProducesLoad = this.loadService.isLoadAvailableAtCity(details.load, details.at);
  if (!cityProducesLoad) {
    return { success: false, error: `${details.at} doesn't supply ${details.load}.` };
  }
  // Runtime check: are any copies of this load available (not on trains)?
  const runtimeAvailable = this.isLoadRuntimeAvailable(details.load, this.snapshot);
  if (!runtimeAvailable) {
    return { success: false, error: `${details.load} not available — all copies are on other trains.` };
  }
  return { success: true, plan: { type: 'PickupLoad', load: details.load, city: details.at } };
}
```

### 5.6 UPGRADE Resolution

```typescript
private async resolveUpgrade(details: { to: string }): Promise<ResolvedAction> {
  const valid = this.getValidUpgrades(this.snapshot.trainType);
  if (!valid.includes(details.to)) {
    return { success: false, error: `Cannot upgrade from ${this.snapshot.trainType} to ${details.to}. Valid: ${valid.join(', ')}.` };
  }
  const cost = this.isCrossgrade(details.to) ? 5 : 20;
  if (this.snapshot.money < cost) {
    return { success: false, error: `Upgrade costs ${cost}M but you have ${this.snapshot.money}M.` };
  }
  if (this.snapshot.isInitialBuild) {
    return { success: false, error: `Cannot upgrade during initial build phase.` };
  }
  return { success: true, plan: { type: 'UpgradeTrain', targetTrain: details.to, cost } };
}
```

### 5.7 Multi-Action Resolution

```typescript
private async resolveMultiAction(actions: LLMAction[]): Promise<ResolvedAction> {
  const plans: TurnPlan[] = [];
  let workingSnapshot = this.snapshot.clone();

  for (const action of actions) {
    const resolver = new ActionResolver(workingSnapshot, ...this.services);
    const result = await resolver.resolveSingleAction(action);

    if (!result.success) {
      return { success: false, error: `Step ${plans.length + 1} failed: ${result.error}` };
    }
    plans.push(result.plan!);
    workingSnapshot = this.applyPlanToSnapshot(workingSnapshot, result.plan!);
  }

  // Validate combination legality
  const types = plans.map(p => p.type);
  if (types.includes('UpgradeTrain') && types.includes('BuildTrack')) {
    const upgrade = plans.find(p => p.type === 'UpgradeTrain')!;
    if (upgrade.cost === 20) {
      return { success: false, error: "Cannot upgrade (20M) and build in the same turn." };
    }
  }
  if (types.includes('DiscardHand') && types.length > 1) {
    return { success: false, error: "Discard Hand ends the turn immediately. Cannot combine with other actions." };
  }

  return { success: true, plan: { type: 'MultiAction', steps: plans } };
}
```

### 5.8 The Retry Loop

```typescript
// In LLMStrategyBrain.decideAction()

const intent = await this.callLLM(systemPrompt, userPrompt);
const result = await this.actionResolver.resolve(intent);

if (!result.success) {
  // One retry with error feedback
  const retryPrompt = userPrompt
    + `\n\nYOUR PREVIOUS CHOICE FAILED VALIDATION:\n"${intent.action}" failed: ${result.error}\nPlease choose a different action.`;

  const retryIntent = await this.callLLM(systemPrompt, retryPrompt);
  const retryResult = await this.actionResolver.resolve(retryIntent);

  if (!retryResult.success) {
    // Both failed — heuristic fallback
    return this.heuristicFallback();
  }
  return retryResult;
}
return result;
```

### 5.9 Heuristic Fallback

When the LLM fails twice, the fallback uses ContextBuilder data directly:

```typescript
private heuristicFallback(context: GameContext): ResolvedAction {
  // 1. Deliver if possible (highest priority)
  if (context.canDeliver.length > 0) {
    const best = context.canDeliver.sort((a, b) => b.payout - a.payout)[0];
    return { success: true, plan: { type: 'DeliverLoad', ...best } };
  }

  // 2. Build toward best reachable demand's supply/delivery city
  if (context.canBuild) {
    const bestDemand = context.demands
      .filter(d => d.isLoadAvailable && d.payout > 0)
      .sort((a, b) => b.payout - a.payout)[0];
    if (bestDemand) {
      const target = bestDemand.isLoadOnTrain
        ? bestDemand.deliveryCity
        : bestDemand.supplyCity;
      // Attempt to resolve a BUILD toward the best target
      return this.resolveBuild({ toward: target });
    }
  }

  // 3. Pass turn
  return { success: true, plan: { type: 'PassTurn' } };
}
```

---

## 6. Existing Code Reuse Map

This table maps every shared service call to the new pipeline, with **actual method signatures verified against the codebase**. Where the ActionResolver can reuse human-player code paths, it does. Where gaps exist (no dryRun, no runtime load availability, no speed-limited reachability), they are called out.

| Shared Service | Method | Actual Signature | Used By (ActionResolver / Pipeline) |
|---|---|---|---|
| `TrackNetworkService` | `.findPath()` | `.findPath(network: TrackNetwork, from: Milepost, to: Milepost): Milepost[] \| null` — requires pre-built network | MOVE resolution — pathfinding |
| `TrackNetworkService` | `.getReachableMileposts()` | `.getReachableMileposts(network): Set<Milepost>` — returns ALL network nodes, NOT distance-limited | **Not directly usable for "reachable this turn."** ContextBuilder must implement BFS with speed-limit depth. |
| `TrackNetworkService` | `.isConnected()` | `.isConnected(network: TrackNetwork, from: Milepost, to: Milepost): boolean` — BFS connectivity check | ContextBuilder — major city count |
| `TrackBuildingService` | `.isValidConnection()` | `.isValidConnection(from: Milepost, to: Milepost): boolean` — adjacency + water checks | BUILD resolution — segment validation. **No dryRun mode exists.** |
| `TrackBuildingService` | `.addPlayerTrack()` | `.addPlayerTrack(playerId, gameId, from, to, options?: { turnBudget? }): Result<TrackNetwork, TrackBuildError>` — mutates state | TurnExecutor only (execution, not validation) |
| `LoadService` | `.isLoadAvailableAtCity()` | `.isLoadAvailableAtCity(loadType: string, city: string): boolean` — static config only, does NOT check runtime availability | ContextBuilder + PICKUP resolution. **Must supplement with runtime load chip count check.** |
| `LoadService` | `.getAvailableLoadsForCity()` | `.getAvailableLoadsForCity(city: string): string[]` — returns all load types a city produces | ContextBuilder — pickup opportunities |
| `trackUsageFees` | `computeTrackUsageForMove()` | `(args: { allTracks, from, to, currentPlayerId, majorCityGroups?, ferryEdges? }): TrackUsageComputation` — returns `{ isValid, path, ownersUsed: Set<string> }`. No `totalFee` field; compute as `4 * ownersUsed.size`. | MOVE resolution — fee calculation |
| `PlayerService` | `.moveTrainForUser()` | Static async, takes `{ gameId, playerId, ... }` | TurnExecutor (unchanged) |
| `PlayerService` | `.deliverLoadForUser()` | Static async | TurnExecutor (unchanged) |
| `PlayerService` | N/A | **No `pickupLoadForUser` exists.** TurnExecutor.handlePickupLoad does raw SQL (`UPDATE players SET loads = array_append(loads, $1)`). | TurnExecutor handles pickup via direct DB query |
| `PlayerService` | `.purchaseTrainType()` | Static async | TurnExecutor (unchanged) |
| `TrackService` | `.saveTrackState()` | `static async saveTrackState(gameId, playerId, trackState)` | TurnExecutor (unchanged) |
| `DemandDeckService` | `.drawCard()` / `.discardCard()` | `.drawCard(): DemandCard \| null`, `.discardCard(cardId: number): void` | TurnExecutor (unchanged) |
| `InitialBuildService` | `.advanceTurn()` | `static async advanceTurn(gameId: string): Promise<void>` | BotTurnTrigger (unchanged) |
| `buildTrackNetwork()` | Standalone function | `buildTrackNetwork(segments: TrackSegment[]): StringTrackNetwork` — converts segments to graph | ContextBuilder + MOVE resolution — must build network before calling findPath/isConnected |

---

## 7. Skill Level Implementation

Unchanged from v1. Skill levels control what information the LLM receives:

| Aspect | Easy | Medium | Hard |
|---|---|---|---|
| Model | claude-haiku-4-5-20251001 | claude-sonnet-4-20250514 | claude-sonnet-4-20250514 |
| Demand detail | "reachable" / "not reachable" | Estimated track costs | Full cost + ferry + reuse analysis |
| Opponent info | None | Position + cash | Full (loads, track, build direction) |
| Last turn summary | No | No | Yes |
| Temperature | 0.5 | 0.3 | 0.3 |
| Estimated latency | 0.5-1s | 1-2s | 2-4s |
| Estimated cost/turn | ~$0.001 | ~$0.005 | ~$0.01 |

---

## 8. Prompt Caching

The system prompt (archetype personality + game rules + response format) is identical every turn. Use Anthropic's prompt caching:

```typescript
body: JSON.stringify({
  model: this.getModel(),
  max_tokens: 300,
  temperature: this.getTemperature(),
  system: [{
    type: 'text',
    text: systemPrompt,
    cache_control: { type: 'ephemeral' }
  }],
  messages: [{ role: 'user', content: userPrompt }],
}),
```

System prompt is ~800 tokens. With caching, processed once and reused for the game session (~60 turns). Reduces per-turn input cost by ~40%.

---

## 9. Strategy Inspector Integration (Updated)

The Strategy Inspector no longer shows ranked options (since there are no pre-generated options). Instead:

```
TURN 14 — Early Game | Backbone Builder (Hard)

Selected Action: BUILD toward Zurich (10M, 8 segments)

Reasoning: "Wine to Vienna is my best demand at 48M and I'm already
carrying it. Zurich is on my backbone corridor."

Plan Horizon: "Reach Zurich in 1-2 build turns, then deliver Wine→Vienna."

Execution:
  ✅ Built 8 mileposts: Lyon → Genève corridor (10M)
  Track network: 30 mileposts

Model: claude-sonnet-4-20250514 | 1.8s | 923 in / 87 out
Guardrail override: No
Resolved on: First attempt
```

With retry:

```
Attempt 1: BUILD toward Wien — REJECTED
  "No valid path within 20M budget. Wien too far from frontier."
Attempt 2: BUILD toward Zurich — ✅ Resolved
```

---

## 10. Cost and Latency

### Per-Turn

| Skill | Model | Input Tokens | Output Tokens | Cost/Turn |
|---|---|---|---|---|
| Easy | Haiku | ~400 | ~80 | ~$0.0004 |
| Medium | Sonnet | ~800 | ~100 | ~$0.003 |
| Hard | Sonnet | ~1200 | ~120 | ~$0.005 |

Add ~50% for retry turns (estimated 10-15% of turns need a retry).

### Per-Game (60 turns, 3 bots)

| Configuration | Estimated Cost |
|---|---|
| 1 Easy bot | $0.03 |
| 1 Medium bot | $0.20 |
| 1 Hard bot | $0.35 |
| 1 of each | $0.58 |
| 5 Hard bots | $1.75 |

---

## 11. Migration Path

### Phase 1: Extract + Build Core (2-3 days)

1. **Extract `BuildPathfinder`** from OptionGenerator — pull out `computeBuildSegments()`, `buildInitialTrackSegments()`, `estimateCost()` into standalone module
2. **Create `ContextBuilder`** — implement using existing shared services. Produces `GameContext` for prompt serialization.
3. **Create `ActionResolver`** — implement all 7 action resolvers (BUILD, MOVE, DELIVER, PICKUP, UPGRADE, DISCARD_HAND, PASS). Each is 20-40 lines using shared services.
4. **Update `LLMStrategyBrain`** — change from menu selection to open-ended intent + retry loop
5. **Rewire `AIStrategyEngine.takeTurn()`** — new pipeline: WorldSnapshot → ContextBuilder → LLM → ActionResolver → GuardrailEnforcer → TurnExecutor
6. **Keep OptionGenerator code** (don't delete yet) but stop calling it
7. **Test**: Play 5 games. Do turns complete? Does the ActionResolver produce clear errors on illegal intents? Does the retry loop work?

### Phase 2: Multi-Action + Skill Levels (2-3 days)

1. Implement multi-action resolution
2. Implement skill-level information filtering in ContextBuilder
3. Switch Easy to Haiku
4. Add opponent direction analysis for Hard
5. Add last turn summary for Hard
6. **Test**: All 5 archetypes play visibly differently. Easy bots are noticeably weaker.

### Phase 3: Inspector + Cleanup (1-2 days)

1. Update Strategy Inspector for new format
2. Add prompt caching
3. **Delete** OptionGenerator, Scorer, PlanValidator (now unused)
4. Tune system prompts based on observed play
5. **Test**: Full playtest matrix

### Total: 5-8 days

---

## 12. What We're Giving Up (And Why That's Okay)

### No more exhaustive option ranking

The old pipeline scored ALL feasible options and the Inspector showed them ranked. Now it shows only what the LLM chose and why.

**Why that's okay:** The ranked list was misleading — it showed options that passed OptionGenerator's broken feasibility checks but failed during execution. The LLM's reasoning is more useful for understanding bot behavior than numerical scores across 12 dimensions.

### No more guaranteed-complete enumeration

The OptionGenerator tried to find every possible action. The LLM might not consider a niche option.

**Why that's okay:** The OptionGenerator frequently failed to enumerate valid options (Dijkstra bugs, missing segments, cold-start problems). A missed niche opportunity is a much smaller failure than a malformed option that crashes the TurnExecutor. The `IMMEDIATE OPPORTUNITIES` section in the prompt catches the most important cases (deliveries, pickups at current location).

### No more deterministic replay

With heuristic scoring, the same game state always produced the same decision. With an LLM at temperature 0.3, there's slight variation.

**Why that's okay:** Variation makes bots feel more human. A bot that occasionally makes a surprising-but-reasonable choice is more engaging to play against.

---

## 13. Key Difference from Old OptionGenerator Bugs

The fundamental architectural improvement: **ActionResolver pathfinds to ONE target per call, not all possible targets simultaneously.**

The OptionGenerator's worst bugs all stemmed from multi-source, multi-target Dijkstra: start from ALL frontier nodes, find paths to ALL possible destination cities, within a budget, while computing segments for each. This multi-target search caused overlapping start/target sets, zero-cost matches, incorrect distance initialization, and paths with no edges.

ActionResolver's BUILD resolution calls `BuildPathfinder.computeBuildSegments(frontier, ONE_TARGET, budget)`. One target. The Dijkstra runs once with a clear start set and a single clear goal. If it fails, the error message tells the LLM to pick a different target. The pathfinding complexity that caused P3 and P3.1 is structurally eliminated.