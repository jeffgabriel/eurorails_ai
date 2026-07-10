# JIRA-256 — Phase 4: wire bot into existing event-card enforcement via shared predicates (technical)

Companion to `jira-256-phase4BotEventCardAwareness-behavioral.md`.

This is the umbrella technical plan for Phase 4. **It subsumes JIRA-251** (Rail Strike vertical slice). The pattern JIRA-251 sketched — snapshot enrichment → planner consultation → guardrail backstop → server-rejection visibility — is correct and adopted here; this ticket extends it to all 20 event cards AND adds the load-bearing decision JIRA-251 didn't have:

> **Single source of truth for restriction logic.** The bot consumes the same predicate functions the human enforcement path uses.

## Core insight: do not reimplement the rules

The server-side event-card mechanics are already complete, normalised, and merged from main. `ActiveEffectManager` produces a runtime `ActiveEffect[]` where each effect carries a typed `restrictions` block:

```ts
ActiveEffect.restrictions = {
  movement:        MovementRestriction[];        // half_rate | blocked_terrain | no_movement_on_player_rail
  build:           BuildRestriction[];           // blocked_terrain | no_build_for_player
  pickupDelivery:  PickupDeliveryRestriction[];  // no_pickup_delivery_in_zone
}
```

(See `src/shared/types/EventCard.ts:161–204`.)

`PlayerService` already enforces these on the human path:

| Restriction site | Lives at | Throws on violation |
|---|---|---|
| `getPickupDeliveryRestrictions` consulted in `deliverLoadForUser` | `playerService.ts:1108–1126` | bare `Error("Delivery blocked by active event (Strike): ...")` |
| `getMovementRestrictions` (`blocked_terrain` branch) in `moveTrainForUser` | `playerService.ts:1442–1463` | bare `Error("Movement blocked by active event (Snow): ...")` |
| `no_movement_on_player_rail` in `moveTrainForUser` | downstream of `1442` (after track-usage computation) | bare `Error` |
| `getPickupDeliveryRestrictions` in `pickupLoadForPlayer` | `playerService.ts:2609–2627` | bare `Error("Pickup blocked by active event (Strike): ...")` |
| `getBuildRestrictions` in `buildTrackForPlayer` | `playerService.ts:2766–2794` | bare `Error("Build blocked by active event (Snow / Rail Strike): ...")` |
| Flood-river rebuild block in `buildTrackForPlayer` | `playerService.ts:2796–2815` | bare `Error("Build blocked: cannot rebuild track across the X river ...")` |

These are **five separate inline blocks**, each building a `Set` from `restriction.zone` and walking the array inline. Every block is the same pattern with the same code repeated. The functions `getRiverEdgeKeys` and `segmentCrossesRiver` are *already* exported from `trackService.ts:36`, `:56` and consumed by both `PlayerService` and `AreaOfEffectService` — proving the codebase's pattern is exported, pure helper functions.

If the bot writes its own filter helpers that walk the same restriction unions, **the rules drift the moment a server-side block changes**. That's the trap this ticket explicitly avoids.

## Reuse strategy: one predicate module, three call sites

### Step 1 — extract: `src/server/services/restrictionPredicates.ts` (new module)

Pure functions, no I/O, no DB. Each predicate takes the restriction array(s) plus the candidate action's identifying data, returns a discriminated `{ blocked: true; restriction } | { blocked: false }`. Avoids boolean-blindness (carries the violating restriction so callers can build error messages or `GateViolation` entries).

```ts
// src/server/services/restrictionPredicates.ts

import type { ActiveEffect, MovementRestriction, BuildRestriction, PickupDeliveryRestriction, TrackSegment } from '...';
import { EventCardType } from '../../shared/types/EventCard';
import { getRiverEdgeKeys, segmentCrossesRiver } from './trackService';

export function isPickupDeliveryBlocked(
  restrictions: PickupDeliveryRestriction[],
  cityKey: string | null
): { blocked: true; restriction: PickupDeliveryRestriction } | { blocked: false };

export function isMovementBlockedAtDest(
  restrictions: MovementRestriction[],
  destKey: string
): { blocked: true; restriction: MovementRestriction } | { blocked: false };

export function isMovementOnOwnRailBlocked(
  restrictions: MovementRestriction[],
  segmentOwnerId: string,
  playerId: string
): boolean;

export function isMovementHalfRate(
  restrictions: MovementRestriction[],
  destKey: string
): boolean;

export function isBuildBlockedAtMilepost(
  restrictions: BuildRestriction[],
  segDestKey: string,
  playerId: string
): { blocked: true; reason: 'blocked_terrain' | 'no_build_for_player'; restriction: BuildRestriction } | { blocked: false };

export function isFloodRebuildBlocked(
  activeEffects: ActiveEffect[],
  segment: TrackSegment
): { blocked: true; river: string } | { blocked: false };

export function isBotInPendingLostTurns(
  activeEffects: ActiveEffect[],
  playerId: string
): boolean;
```

Also extract the existing `PlayerService.getCityMilepointKey:154` from `private static` to an exported function in the same module (or a co-located `cityMilepostHelpers.ts` — implementer's call). Pickup/delivery callers all need it.

### Step 2 — refactor PlayerService: inline blocks become predicate calls

Five replacements, each mechanical:

| Line | Today | After |
|---|---|---|
| `playerService.ts:1108–1126` | inline pickupDelivery check | `const verdict = isPickupDeliveryBlocked(deliveryRestrictions, cityKey); if (verdict.blocked) throw new ActionRestrictionError('COASTAL_STRIKE_BLOCKED', ...)` |
| `playerService.ts:1442–1463` | inline movement `blocked_terrain` | `const verdict = isMovementBlockedAtDest(movementRestrictions, destKey); if (verdict.blocked) throw new ActionRestrictionError('SNOW_BLOCKED_TERRAIN', ...)` |
| `playerService.ts:` (downstream of 1442, `no_movement_on_player_rail` check) | inline | `if (isMovementOnOwnRailBlocked(movementRestrictions, segmentOwnerId, playerId)) throw new ActionRestrictionError('RAIL_STRIKE_BLOCKED', ...)` |
| `playerService.ts:2609–2627` | inline pickupDelivery check | `const verdict = isPickupDeliveryBlocked(pickupRestrictions, cityKey); if (verdict.blocked) throw new ActionRestrictionError('COASTAL_STRIKE_BLOCKED', ...)` |
| `playerService.ts:2766–2794` | inline build check | `const verdict = isBuildBlockedAtMilepost(buildRestrictions, destKey, playerId); if (verdict.blocked) throw new ActionRestrictionError(verdict.reason === 'no_build_for_player' ? 'RAIL_STRIKE_BLOCKED' : 'SNOW_BLOCKED', ...)` |
| `playerService.ts:2796–2815` | inline Flood rebuild block | `const verdict = isFloodRebuildBlocked(activeEffects, seg); if (verdict.blocked) throw new ActionRestrictionError('FLOOD_BRIDGE_REBUILD_BLOCKED', ...)` |

`ActionRestrictionError` is a new class in `playerService.ts`:

```ts
export type ActionRestrictionErrorCode =
  | 'RAIL_STRIKE_BLOCKED'
  | 'COASTAL_STRIKE_BLOCKED'
  | 'SNOW_BLOCKED_TERRAIN'
  | 'SNOW_HALF_RATE_EXCEEDED'  // half-rate enforced in bot, not server
  | 'BUILD_BLOCKED'
  | 'LOST_TURN'
  | 'FLOOD_BRIDGE_REBUILD_BLOCKED'
  | 'OTHER';

export class ActionRestrictionError extends Error {
  constructor(public readonly code: ActionRestrictionErrorCode, message: string) {
    super(message);
    this.name = 'ActionRestrictionError';
  }
}
```

**Acceptance check that locks this in:** `grep -nE 'restriction\.type ===' src/server/services/playerService.ts` MUST return **zero matches** after the refactor. All restriction-type discrimination must live in `restrictionPredicates.ts`.

### Step 3 — bot consumes the same predicates

Three call sites, all pure-functional (no DB hits because they take `ActiveEffect[]` from the snapshot):

**Snapshot enrichment** (`src/server/services/ai/WorldSnapshotService.ts:capture`):

```ts
const activeEffects = await activeEffectManager.getActiveEffects(gameId);
return { ...existing, activeEffects };
```

Extend `WorldSnapshot` in `src/shared/types/GameTypes.ts:357` with `activeEffects: ActiveEffect[]` (empty array, never null — `anti-patterns-boolean-blindness`).

**Planner consultation:**

- `MovementPhasePlanner.ts` — during Phase A1/A2/A3 candidate generation, for each candidate destination call `isMovementBlockedAtDest(restrictions, destKey)` and `isMovementOnOwnRailBlocked(restrictions, segmentOwnerId, botPlayerId)`. Skip any candidate where either returns blocked. Cap the candidate's movement budget if `isMovementHalfRate(restrictions, destKey)` returns true for any segment in the path (per-train-type half rates: Freight/Heavy → 5; Fast/Super → 6 — values from existing `getTrainSpeed` shared util).
- `BuildPhasePlanner.ts` — during Phase B candidate generation, for each candidate segment call `isBuildBlockedAtMilepost(restrictions, segDestKey, botPlayerId)` and `isFloodRebuildBlocked(activeEffects, seg)`. Skip blocked segments. If `no_build_for_player.targetPlayerId === botPlayerId`, skip Phase B entirely.
- `routeHelpers.ts` (pickup/deliver decisions) — for each candidate city, compute `cityKey = getCityMilepointKey(city)` then call `isPickupDeliveryBlocked(restrictions, cityKey)`. Skip blocked candidates.
- **Lost-turn pre-empt** — in `AIStrategyEngine.takeTurn` or `TurnExecutor.execute` (whichever runs first per the existing flow), before any candidate generation: if `isBotInPendingLostTurns(activeEffects, botPlayerId)` returns true, emit a single `PassTurn` action with `reasoning` citing the source `cardId` and exit the turn. Server consumes the lost turn via `ActiveEffectManager.consumeLostTurn`.

**Guardrail backstop** (`GuardrailEnforcer.checkPlan`):

Four new gates. Each iterates the plan's actions and calls the same predicates. Same rule, third call site:

```ts
// pseudocode
for (const action of plan.actions) {
  if (action.type === 'MoveTrain') {
    const v1 = isMovementBlockedAtDest(restrictions.movement, action.destKey);
    if (v1.blocked) violations.push({ code: 'MOVEMENT_RESTRICTION_VIOLATION', ... });
    if (isMovementOnOwnRailBlocked(restrictions.movement, action.segmentOwnerId, botPlayerId))
      violations.push({ code: 'MOVEMENT_RESTRICTION_VIOLATION', ... });
  }
  if (action.type === 'BuildTrack') {
    for (const seg of action.segments) {
      const v = isBuildBlockedAtMilepost(restrictions.build, seg.destKey, botPlayerId);
      if (v.blocked) violations.push({ code: 'BUILD_RESTRICTION_VIOLATION', ... });
      if (isFloodRebuildBlocked(activeEffects, seg).blocked)
        violations.push({ code: 'BUILD_RESTRICTION_VIOLATION', ... });
    }
  }
  if (action.type === 'PickupLoad' || action.type === 'DeliverLoad') {
    const v = isPickupDeliveryBlocked(restrictions.pickupDelivery, getCityMilepointKey(action.city));
    if (v.blocked) violations.push({ code: 'PICKUP_DELIVERY_RESTRICTION_VIOLATION', ... });
  }
  if (action.type !== 'PassTurn' && isBotInPendingLostTurns(activeEffects, botPlayerId)) {
    violations.push({ code: 'LOST_TURN_PENDING', ... });
  }
}
```

`GateViolation.code` is a closed union, extending the existing G1/G3/G8 set with: `'MOVEMENT_RESTRICTION_VIOLATION' | 'BUILD_RESTRICTION_VIOLATION' | 'PICKUP_DELIVERY_RESTRICTION_VIOLATION' | 'LOST_TURN_PENDING'`.

### Step 4 — mid-turn re-snapshot ("play like a human")

When the bot finishes an action that drew an event card, the world has changed. The bot must adapt the **remainder** of the turn, not the next turn.

Today `PlayerService` action methods return a result object that doesn't expose how many cards were drawn during the action (they're internal to `deliverLoadForUser`'s draw loop, `playerService.ts:1159–1168`). Two-part change:

1. `PlayerService` action methods extend their return value with `cardsDrawnDuringAction: number`. Existing call sites can ignore this field; bot's `TurnExecutor` reads it.
2. `TurnExecutor.execute` after each successful action checks `if (result.cardsDrawnDuringAction > 0)` and re-invokes `WorldSnapshotService.capture` then re-invokes `MovementPhasePlanner` (and `BuildPhasePlanner` if applicable) against the bot's current position and remaining movement budget.

Loop-prevention guard: at most one re-snapshot per executed action. A single action can draw at most a handful of cards; in practice never more than two. This is a hard bound, not a heuristic — write it as `if (result.cardsDrawnDuringAction > 0 && !this._reSnapshottedThisAction) { ... }`.

### Step 4.5 — Flood-visualization fix (folded in from human-UX scope)

`TrackService.removeSegmentsCrossingRiver` (`trackService.ts:225`) does the DB delete during Flood processing but emits zero socket events. The client UI does not refresh affected track until something else triggers a snapshot pull. The bot is unaffected (snapshot always queries fresh) but humans see stale track until they refresh.

**One-line fix in `EventCardService.processFlood`** (`EventCardService.ts:~381`, right after the `removeSegmentsCrossingRiver` call returns):

```ts
const removalResults = await TrackService.removeSegmentsCrossingRiver(/* ... */);
// NEW — broadcast the track change so client renderers reflect erased bridges
for (const result of removalResults) {
  emitTrackUpdated(gameId, { playerId: result.playerId, reason: 'flood' });
}
```

`emitTrackUpdated` is a thin wrapper around the existing `emitToGame(gameId, 'track:updated', ...)` pattern used in `TurnExecutor.ts:346`. The client's existing `track:updated` subscriber (in `GameScene.ts` — verify the subscription site lands during implementation) re-renders the affected player's track from the DB.

This is a tiny scope expansion (~10 LOC + one new socket emitter helper) folded in here because the Phase 4 work already touches the Flood path and we want humans + bot to both behave correctly in one PR.

### Step 4.7 — Eager Flood-rebuild policy (network shape preservation)

**Decision (carried from behavioral doc):** when a Flood card discards, the bot unconditionally rebuilds every segment it lost to that Flood, blocking all other Phase B building until the rebuild list is empty. This sidesteps a known underlying scoring bug rather than fixing it (see "Underlying bug we are NOT fixing here" below).

#### Underlying bug we are NOT fixing here

`buildTrackNetwork(segments)` at `TrackNetworkService.ts:267` constructs `nodes` as the union of all milepost endpoints across all segments — it does NOT compute connected components. `isCityOnNetwork(city, network, ...)` at `DemandEngine.ts:289` is a `network.nodes.has(key)` check. Consequence: after a Flood severs the bot's network, a city in the orphaned component still reports `isCityOnNetwork === true`. The cost-gate at `DemandEngine.ts:562` then scores delivery to that city as `0` (free), but execution can't reach it without rebuilding.

Filed as known debt. This project mitigates the Flood case via eager rebuild; structural fix (connectivity-aware `isCityReachableFromBot` predicate) is out of scope.

#### Server-side: persist lost segments

Add a JSONB column to `player_tracks`:

```sql
-- migration 039 (next available)
ALTER TABLE player_tracks
ADD COLUMN pending_flood_rebuilds JSONB NOT NULL DEFAULT '[]';
```

Format: `TrackSegment[]` — same shape as the existing `segments` column entries.

`TrackService.removeSegmentsCrossingRiver` (`trackService.ts:225`) is extended: instead of just filtering segments out of the `segments` column, it also appends the removed segments to `pending_flood_rebuilds` for each affected player. Single transaction; same `FOR UPDATE` lock already in place.

`PlayerService.buildTrackForPlayer` (`playerService.ts:~2818`) is extended: after a successful build, if any of the newly-built segments match entries in `pending_flood_rebuilds`, remove the matching entries from the column. Matching key: `(from.row, from.col, to.row, to.col)` equality in either direction.

#### Snapshot enrichment

`WorldSnapshot.bot` gains:

```ts
interface BotState {
  // ... existing
  pendingFloodRebuilds: TrackSegment[];  // empty array when none pending
}
```

`WorldSnapshotService.capture` reads `pending_flood_rebuilds` and includes it in the bot state. Single additional column read; no separate query.

#### Bot planner consumption

`BuildPhasePlanner` gains a pre-step at the top of candidate generation:

```ts
// pseudocode
if (snapshot.bot.pendingFloodRebuilds.length > 0) {
  // Filter rebuilds: only those NOT currently blocked by an active Flood
  const rebuildable = snapshot.bot.pendingFloodRebuilds.filter(seg =>
    !isFloodRebuildBlocked(snapshot.activeEffects, seg).blocked
  );

  if (rebuildable.length > 0) {
    // BLOCK all other building. Emit BuildTrack actions for as many rebuilds as
    // fit in the ECU 20M turn build budget, prioritizing in stored order (FIFO).
    return composeRebuildOnlyPhaseB(rebuildable, ECU_20M_BUILD_BUDGET);
  }

  // All pending rebuilds are still Flood-blocked — bot does no building this turn,
  // OR proceeds with normal candidate generation? See note below.
}

// Normal candidate generation continues only if pendingFloodRebuilds is empty.
return composeNormalPhaseB(snapshot, ...);
```

**Open implementation question (call during build):** when ALL `pendingFloodRebuilds` are still Flood-blocked (i.e., the originating Flood card hasn't discarded yet, OR a new Flood on the same river hit before rebuilds could complete), the bot has rebuilds queued but can't act on them. Two options for that turn:

- (a) Skip Phase B entirely (the most conservative interpretation of "block all other building")
- (b) Allow normal Phase B building (since none of the pending rebuilds are actionable)

Spec recommends **(b)** — the "blocking" rule applies to *actionable* rebuilds. When everything is still Flood-blocked there's nothing to block against; let normal building proceed so the bot doesn't waste its turn. Implementer can override during code review if the user prefers strict (a).

#### Movement, pickup, deliver unaffected

The block applies only to Phase B (building). The bot continues moving, picking up, and delivering normally while pending rebuilds exist — including during the period after Flood draw and before discard, where the bot is routing around the missing bridge.

#### Acceptance

- **Pre-Flood network shape preserved across Flood + rebuild cycle.** After Flood draws + 2-3 turns of post-discard play, `bot.existingSegments` set-equals the pre-Flood `bot.existingSegments` set.
- **Cash deduction matches expected rebuild cost.** Sum of `pendingFloodRebuilds[*].cost` (each segment retaining its original `cost` field) is deducted from the bot's cash over the rebuild period.
- **Block enforced.** While `pendingFloodRebuilds` is non-empty and at least one entry is rebuildable, the bot emits NO BuildTrack actions for non-rebuild segments. Asserted via unit test on `BuildPhasePlanner`.

This is technically still under R3 (planner consultation — build) but worth calling out because it introduces new server-side state (the JSONB column), a new snapshot field, and a new planner pre-step. Filed as new requirement R11 below.

### Step 5 — rejection-reason plumbing

The bot's per-turn log currently records `success: false` with no rejection reason. After the refactor, every server-side rejection comes back as a typed `ActionRestrictionError`. Three sites change:

1. `TurnExecutor.handleMoveTrain` / `handleBuildTrack` / `handlePickupLoad` / `handleDeliverLoad`: catch `ActionRestrictionError` specifically, populate `ExecutionResult.rejectionReason = { code: err.code, message: err.message }`. Other errors continue to propagate as today.
2. `ExecutionResult` type extended:
   ```ts
   interface ExecutionResult {
     success: boolean;
     cardsDrawnDuringAction: number;
     rejectionReason?: { code: ActionRestrictionErrorCode; message: string };
     // ... existing fields
   }
   ```
3. `GameLogger.appendTurn` (at `src/server/services/ai/GameLogger.ts:196`) — `GameTurnLogEntry` gains `actions[i].rejectionReason?: { code, message }`. NDJSON serialiser is unchanged structurally; the new field flows through.

## Architecture diagram (with shared-predicate markers ★)

```
ActiveEffectManager.getActiveEffects(gameId)
        │
        ▼
WorldSnapshotService.capture
        │     ★ snapshot.activeEffects: ActiveEffect[]
        ▼
[Lost-turn pre-empt]  ★ isBotInPendingLostTurns
        │     if true → PassTurn, exit turn
        ▼
MovementPhasePlanner / BuildPhasePlanner / routeHelpers (pickup-deliver)
        │     ★ calls restrictionPredicates.* during candidate filtering
        ▼
TurnPlan
        │
        ▼
GuardrailEnforcer.checkPlan
        │     ★ calls SAME restrictionPredicates.* — third call site
        │     emits typed GateViolation codes
        ▼
TurnExecutor.execute  for each action:
        │     PlayerService.<action>ForUser
        │         ★ inline blocks REPLACED with restrictionPredicates.* calls
        │         throws ActionRestrictionError(code, message) on violation
        │     catch ActionRestrictionError →
        │         ExecutionResult.rejectionReason = { code, message }
        │     if result.cardsDrawnDuringAction > 0 (max once per action):
        │         re-snapshot → re-plan remainder
        ▼
GameLogger.appendTurn  → NDJSON entry includes rejectionReason
```

All four ★ sites call the same pure-function predicates in `restrictionPredicates.ts`. The game-rule logic exists in exactly one place; the call sites are responsible only for *what to do* when a predicate returns blocked (skip candidate, emit violation, throw error).

## Why this shape

| Decision | Rationale |
|---|---|
| Pure-function module, not a class | Matches existing pattern (`trackService.ts` exports `getRiverEdgeKeys` / `segmentCrossesRiver` as functions). Avoids unnecessary DI. Aligns with `anti-patterns-over-abstraction`. |
| Discriminated `{ blocked: true; restriction } \| { blocked: false }` return | Carries the violating restriction so callers can format error messages and `GateViolation` entries without re-walking. Avoids `anti-patterns-boolean-blindness`. |
| Bot consumes ActiveEffect via snapshot, not via event-bus subscription | Single point-in-time perception read per turn. `gaming-game-state-perception` pattern. The bot stays a passive consumer of state. |
| Half-rate enforced **bot-side only** | Server explicitly does not enforce — `playerService.ts:1462` comment says "half_rate: does not block movement, only caps speed — enforcement is client-side movement cap." Bot mirrors this: caps movement budget in `MovementPhasePlanner`. |
| `no_movement_on_player_rail` checked POST-track-usage | Mirrors the server's order — `PlayerService.moveTrainForUser` checks `blocked_terrain` immediately at line 1442, then computes which segments are own track, then checks rail-strike against ownership. Bot's predicate `isMovementOnOwnRailBlocked(restrictions, segmentOwnerId, playerId)` takes ownership as a parameter so the planner can call it after computing per-segment ownership. |
| Mid-turn re-snapshot bounded to one per action | Prevents infinite loops if a redraw cascade ever happens. In practice never more than ~2 cards per action. |
| `ActionRestrictionError` new class, not reuse `Error` | Closed `code` union enables type-safe dispatch on the bot side. `security-error-handling` R1 / R2 / R5. |

## Test plan

**Predicate-level (unit, `src/server/__tests__/restrictionPredicates.test.ts`):**
- Table-driven tests for each predicate. Input: `(restrictions, action-key, optional-player-id)`. Output: `{ blocked, restriction? }` matches expected.
- Coverage: every restriction `type` value × `inside zone` / `outside zone` × `target-player matches` / `target-player differs` (where applicable).

**PlayerService parity (integration, `src/server/__tests__/playerService.actionRestrictions.test.ts` — existing file extended):**
- The five inline-check sites now call the predicates. The existing tests in this file must continue to pass without modification. If any assertion changes, the refactor changed observable behavior.
- `grep -nE 'restriction\.type ===' src/server/services/playerService.ts` returns zero matches. Locked as an explicit test (`it('has no inline restriction-type discrimination', () => { const src = readFileSync('src/server/services/playerService.ts', 'utf-8'); expect(src.match(/restriction\.type ===/g) ?? []).toHaveLength(0); })`).

**Bot planner (unit, `src/server/__tests__/ai/MovementPhasePlanner.eventCards.test.ts` and `BuildPhasePlanner.eventCards.test.ts`):**
- Fixture: snapshot with one active effect of each type. Assert: planner produces no candidates that violate.
- Edge cases: empty `activeEffects`, multiple simultaneous effects, effect targets different player.

**Guardrail (unit, `src/server/__tests__/ai/GuardrailEnforcer.eventCards.test.ts`):**
- Construct a `TurnPlan` that violates each restriction. Assert: `checkPlan` returns the corresponding typed `GateViolation.code`.

**Mid-turn re-snapshot (integration, `src/server/__tests__/ai/TurnExecutor.midTurnReSnapshot.test.ts`):**
- Mock `PlayerService` action returning `cardsDrawnDuringAction: 1`. Assert: `WorldSnapshotService.capture` called a second time before next action.
- Mock returning `cardsDrawnDuringAction: 0`. Assert: NO second capture.
- Two cards drawn back-to-back: assert exactly one re-snapshot per action (loop-prevention guard).

**Rejection visibility (integration, `src/server/__tests__/ai/TurnExecutor.rejectionReason.test.ts`):**
- PlayerService throws `ActionRestrictionError('RAIL_STRIKE_BLOCKED', ...)`. Assert: `ExecutionResult.rejectionReason === { code: 'RAIL_STRIKE_BLOCKED', message: ... }`. Assert: NDJSON entry includes the same `{ code, message }`.

**Behavioral parity contract (unit, `src/server/__tests__/restrictionPredicates.parity.test.ts`):**
- For each `(activeEffects, action)` triple in a shared fixture table, assert: the verdict returned by the predicate is consistent between the human path (after refactor) and the bot's planner consultation. Same input → same output, by construction.

**Flood visualization (integration, `src/server/__tests__/EventCardService.floodEmit.test.ts`):**
- Process a Flood event with two affected players. Assert: `emitToGame` called once per affected player with topic `'track:updated'`. Mock socket; verify payload includes `playerId` and `reason: 'flood'`.

**Eager Flood-rebuild (integration, `src/server/__tests__/ai/floodRebuild.policy.test.ts`):**
- Fixture: bot owns 4 segments crossing the Rhine. Flood event drawn naming Rhine.
- Assert (server): after `processFlood`, `player_tracks.pending_flood_rebuilds` contains all 4 removed segments; `player_tracks.segments` no longer contains them.
- Assert (snapshot): next `WorldSnapshotService.capture` returns `snapshot.bot.pendingFloodRebuilds.length === 4`.
- Assert (planner during Flood): while Flood still active, `BuildPhasePlanner` emits NO BuildTrack actions for the pending rebuilds (filtered by `isFloodRebuildBlocked`). If no pending rebuilds are actionable, normal Phase B may proceed (open question — see Step 4.7).
- Assert (planner after Flood discards): on the next turn after Flood discards, `BuildPhasePlanner` emits BuildTrack actions for all 4 pending rebuilds (or as many as fit in 20M budget) and emits NO non-rebuild builds.
- Assert (post-rebuild parity): after all 4 rebuilds complete, the bot's `existingSegments` set equals the pre-Flood `existingSegments` set; `pending_flood_rebuilds` is empty.

**Multi-turn rebuild spread (unit, `src/server/__tests__/ai/floodRebuild.budget.test.ts`):**
- Fixture: bot owns 9 segments lost to a Flood (more than the ECU 20M budget can rebuild in one turn).
- Assert: turn 1 post-discard emits ~6-7 BuildTrack actions (budget-bound). `pending_flood_rebuilds` shrinks by that many entries.
- Assert: turn 2 emits the remaining rebuilds. `pending_flood_rebuilds` reaches zero.
- Assert: throughout both turns, no non-rebuild BuildTrack actions emitted.

## Relationship to JIRA-251

JIRA-251 is closed by this ticket. JIRA-251 proposed the snapshot-enrichment + planner-consultation + guardrail-backstop + server-rejection-visibility pattern as a vertical slice for Rail Strike. We adopt the pattern unchanged and extend it to all event types via the shared-predicate module. The Rail Strike test scenarios from JIRA-251's AC1–AC5 all apply (now generalised to all restriction types).

## Out of scope (carried from behavioral doc)

- LLM-prompt changes — `ContextSerializer` is not modified.
- Strategic event-card adaptation — V1 is reactive.
- Circus / variant cards.

## Validation hooks during implementation

- `snapshot.activeEffects` populated at every turn — log a debug-level entry per snapshot capture showing the effect count.
- `composition.guardrail.firstViolation` shows the new typed codes when a planner ever produces a violating plan.
- Per-turn NDJSON entries carry `rejectionReason` whenever an action fails under a restriction.
- After PlayerService refactor: `grep -nE 'restriction\.type ===' src/server/services/playerService.ts` returns zero matches.
