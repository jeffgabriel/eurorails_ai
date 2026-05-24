# JIRA-221 — Research-mode Opus TripPlanner from raw state (technical)

Companion to `jira-221-rawStateOpusResearch-behavioral.md`. Read that first for scope, evidence, cost expectations, and the open review questions.

## Current implementation

**`src/server/services/ai/TripPlanner.ts`** — `planTrip` (lines 124-450, roughly):

- Lines 134-197: pre-LLM short-circuits — `keep_current_plan`, `no_actionable_options`, `single_option_shortcircuit`. Unchanged by this ticket.
- Lines 200-204: `strategicContext` built only for Medium.
- Line 205: `getTripPlanningPrompt(skillLevel, context, memory, strategicContext)` composes the helper-anchored prompt with `OPTIONS` block.
- Lines 211-319: retry loop calling `adapter.chat(...)` with skill-tiered effort/temperature/maxTokens, parsing the response, scoring candidates against `OPTIONS`.
- Lines 421-445: total-failure fallback to `LLMStrategyBrain.planRoute`.

**`src/server/services/ai/prompts/systemPrompts.ts`** — `getTripPlanningPrompt()` returns `{system, user}` per skill level. The user prompt is built by `buildTripPlanningContext()` in `prompts/ContextSerializer.ts` and contains the `OPTIONS` block enumerating helper-scored candidates.

**`src/server/services/ai/schemas.ts`** — `TRIP_PLAN_SCHEMA` and `TRIP_PLAN_SCHEMA_MEDIUM`. Neither includes `segmentsToBuild`; building track is handled downstream by `BuildPhasePlanner`/`ActionResolver` after the LLM returns stops.

**`src/server/services/ai/MapTopology.ts`** — `loadGridPoints()` returns the full grid; `hexDistance()` computes Chebyshev distance.

**`src/server/services/ai/RouteValidator.ts`** + **`RouteDetourEstimator.ts`** — validate stops and simulate trips. Reused unchanged.

**`src/shared/services/trackUsageFees.ts`** — `buildUnionTrackGraph({allTracks})` returns adjacency + edge ownership for the full board. Reused unchanged for the subgraph BFS.

**`src/shared/types/GameTypes.ts`** lines 19-23 — `BotSkillLevel` enum. Currently `Easy | Medium | Hard`.

## Fix plan

### 1. Skill-level gate (decision pending — see behavioral §"Open questions")

Two options for review:

**Option A: New enum value.**
```ts
// src/shared/types/GameTypes.ts
export enum BotSkillLevel {
  Easy = 'easy',
  Medium = 'medium',
  Hard = 'hard',
  Research = 'research',  // new — Opus only, raw-state mode
}

// LLM_DEFAULT_MODELS:
[BotSkillLevel.Research]: 'claude-opus-4-7-1m',  // 1m context for the larger map subgraph
```

**Option B: Hidden flag on BotConfig.**
```ts
// src/shared/types/GameTypes.ts (extend BotConfig)
researchMode?: boolean;  // when true, overrides skill-level dispatch in TripPlanner
```

Either way, `TripPlanner.planTrip` adds a single early branch:

```ts
const isResearchMode = skillLevel === BotSkillLevel.Research;  // or ctx.botConfig?.researchMode === true
```

If true, route to the new prompt builder + schema; otherwise keep current behavior byte-stable.

### 2. New module: `src/server/services/ai/RawStateContextBuilder.ts`

Owns the subgraph BFS and the prompt serialization.

```ts
export interface RawStateContext {
  systemPrompt: string;
  userPrompt: string;
}

export function buildRawStateContext(
  snapshot: WorldSnapshot,
  context: GameContext,
  memory: BotMemoryState,
  gridPoints: GridPoint[],
  options?: { hopRadius?: number },  // default 5
): RawStateContext;
```

Internals (each a private helper):

- **`collectRelevantCityCoords(snapshot, context)` → `Set<row,col>`**.
  Seed set: bot position + every demand's `supplyCity` and `deliveryCity` resolved to coordinates via `findCityMilepost` (existing in `ActionResolver.ts:1332`). Major cities contribute every milepost in their group via `getMajorCityGroups()`.

- **`bfsSubgraph(seedSet, hopRadius, adjacency)` → `Set<row,col>`**.
  Multi-source BFS over the union track graph (`buildUnionTrackGraph` from `trackUsageFees.ts`) PLUS the base topology graph (any milepost reachable, regardless of built track). Returns the union of all coordinates within `hopRadius` of any seed.

- **`serializeMapSubgraph(coordSet, gridPoints, adjacency, edgeOwners, botPlayerId)` → `string`**.
  Per-city block:
  ```
  Paris(45,32)[major,connected]: Reims(1M,clear,own) Lille(3M,clear+river,own) Tours(2M,clear,unbuilt) Bruxelles(7M,clear,Bot-2) ...
  ```
  Format rules:
  - First line per major city group lists the group name + all member milepost coords.
  - Edges sorted by cost ascending (cheapest options first — the LLM scans top-of-line for legal moves).
  - Owner field: `own` (bot's track), `unbuilt` (no track yet), or `<player-name>` (opponent track — Opus must compute fees).
  - Terrain field includes water-crossing surcharges inline: `clear+river`, `mountain+lake`, etc.
  - Cap each city's neighbor list at the cheapest 8 edges to bound token count.

- **`serializeFerries(coordSet, ferryConnections)` → `string`**.
  Filter `ferryConnections` to those with both endpoints inside `coordSet`. One line each: `Stockholm(45,55) ↔ Helsinki(40,60) cost 5M`.

- **`serializeOpponents(snapshot)` → `string`**.
  Per non-bot player: cities-connected count, cash, train type, position. One line each.

- **`composeUserPrompt(...)` → `string`**.
  Stitch the sections in order: STATE, DEMANDS, OPPONENTS, MAP SUBGRAPH, FERRIES, TASK. The TASK block is a fixed string that names the scoring criterion `(payout − build − fees) / turns` and the output schema.

The system prompt is a new constant `RAW_STATE_SYSTEM` defined in `prompts/systemPrompts.ts` (see step 4).

### 3. New schema: `TRIP_PLAN_SCHEMA_RAW`

In `src/server/services/ai/schemas.ts`:

```ts
export const TRIP_PLAN_SCHEMA_RAW = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    stops: {
      // identical to TRIP_PLAN_SCHEMA stops (action: PICKUP|DELIVER, load, supplyCity, deliveryCity, demandCardId, payment)
      ...
    },
    segmentsToBuild: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          fromRow: { type: 'number' as const },
          fromCol: { type: 'number' as const },
          toRow:   { type: 'number' as const },
          toCol:   { type: 'number' as const },
        },
        required: ['fromRow', 'fromCol', 'toRow', 'toCol'],
      },
    },
    upgradeOnRoute: { type: 'string' as const, enum: ['FastFreight', 'HeavyFreight', 'Superfreight'] },
    reasoning: { type: 'string' as const },
  },
  required: ['stops', 'segmentsToBuild', 'reasoning'],
};
```

Note `segmentsToBuild` is the new field. Existing schemas don't include it because the helper-anchored path computes track via `BuildRouteResolver` from declared stops; raw-state mode lets Opus declare track explicitly.

### 4. New system prompt: `RAW_STATE_SYSTEM`

In `src/server/services/ai/prompts/systemPrompts.ts`:

```ts
export const RAW_STATE_SYSTEM = `
You are playing Eurorails. Your job is to choose this turn's trip plan from the
9 demands across 3 demand cards, the current state, the map subgraph, and the
opponent state.

GAME RULES (relevant to trip planning):
- Movement: <speed> mileposts/turn (Freight 9, Fast 12, Heavy 9, Super 12).
- Capacity: 2 loads (Freight/Fast), 3 loads (Heavy/Super).
- Build budget: 20M/turn cap. No more than 2 sections from a major-city milepost.
- Track-usage fee: 4M/turn flat for any opponent track segment used.
- Pickup/deliver: PICKUP requires the load to be available at supplyCity. DELIVER requires the load on train AND a demand card for that load+deliveryCity. Carried loads are noted in STATE.
- Win: 7 connected major cities AND 250M cash.

ACTION GRAMMAR (same as helper-anchored mode):
- DELIVER requires a prior PICKUP in the stop sequence OR the load already in STATE.loads.
- Same-city same-load multi-load pickups are SEPARATE PICKUP stops.
- Total PICKUP stops + carried loads must not exceed train capacity.

SCORING: trip_score = (total payout − build cost − usage fees) / turns to complete.

YOU PLAN THE TRACK YOURSELF. The map subgraph below shows every relevant edge with cost, terrain, and ownership. Declare the track to build in segmentsToBuild as (fromRow, fromCol, toRow, toCol) milepost pairs. The simulator will reject illegal/unaffordable plans.

OUTPUT SCHEMA: { stops: [...], segmentsToBuild: [...], upgradeOnRoute?: ..., reasoning: "..." }
Justify in 2-3 sentences citing payout, build cost, and turns.
`;
```

`getTripPlanningPrompt()` adds a third branch:

```ts
if (skillLevel === BotSkillLevel.Research /* or researchMode flag */) {
  const { systemPrompt, userPrompt } = buildRawStateContext(snapshot, context, memory, gridPoints);
  return { system: systemPrompt, user: userPrompt };
}
```

### 5. TripPlanner branch

Inside `planTrip`, after the pre-LLM short-circuits and before the existing prompt construction:

```ts
const isResearchMode = skillLevel === BotSkillLevel.Research;

// existing strategicContext builder runs only for Medium — leave unchanged

const promptResult = isResearchMode
  ? buildRawStateContext(snapshot, context, memory, gridPoints)
  : { system: ..., user: ... };  // existing path

const outputSchema = isResearchMode
  ? TRIP_PLAN_SCHEMA_RAW
  : (skillLevel === BotSkillLevel.Medium ? TRIP_PLAN_SCHEMA_MEDIUM : TRIP_PLAN_SCHEMA);

// adapter.chat(...) call body — extend timeoutMs for research mode:
timeoutMs: isResearchMode ? 180000 : 120000,
```

The retry loop, parse handling, candidate scoring, validation, affordability, and fallback flow are unchanged. The only difference is the input schema and the output schema; everything downstream operates on the resulting stops + (optionally) segmentsToBuild.

### 6. Plumbing `segmentsToBuild` to BuildPhasePlanner

The current `BuildPhasePlanner` derives track from declared stops via `BuildRouteResolver`. Research mode bypasses this: Opus's `segmentsToBuild` is the authoritative track plan.

Two implementation paths:

**Path A: minimal — store in StrategicRoute, BuildPhasePlanner reads it.**
```ts
// StrategicRoute extension (additive, optional):
declaredSegments?: { from: {row, col}, to: {row, col} }[];
```
`BuildPhasePlanner.run()` checks `route.declaredSegments`; if present, validates against the union track graph (legal adjacency, terrain costs, owner-blocking rules) and emits BuildTrack actions directly. If absent, falls back to today's `BuildRouteResolver` derivation.

**Path B: convert at the boundary.**
`TripPlanner` consumes `segmentsToBuild` from the LLM response, passes through `BuildRouteResolver.validateExternalSegments()` (new method), and stores the validated set on the route. Same downstream effect.

Path A is simpler. Recommend Path A.

### 7. Validation pipeline

No changes. `RouteValidator.validate(route, context, snapshot)` and `simulateTrip(startPos, stops, snapshot)` are called exactly as today. The retry-on-failure with error-feedback append is unchanged.

The expected new failure modes for research mode:

- **Hallucinated city.** Opus references a city not in the demand list or not in the subgraph. `RouteValidator` already rejects.
- **Illegal segment.** Opus declares `segmentsToBuild` for non-adjacent mileposts or already-built track. New validation in Path A's `BuildPhasePlanner` check.
- **Budget overrun.** Opus's `segmentsToBuild` totals >20M for the turn. `simulateTrip` already detects via cumulative budget check.
- **Capacity overrun.** Opus declares more PICKUPs than capacity. `RouteValidator` already detects.

If retry doesn't recover, fall through to `LLMStrategyBrain.planRoute` heuristic — same as today's LLM total-failure path.

### 8. Token-budget tuning

Opus 4.7 with the 1M context model handles the prompt size easily. Practical concerns:

- **Prompt-cache the rules block.** `RAW_STATE_SYSTEM` is byte-stable across all calls — wrap in `cache_control: { type: 'ephemeral' }` (existing pattern in `AnthropicAdapter.ts:42-46`). Saves ~15% per call after the first.
- **Subgraph radius `N=5`** as the starting value. Empirically tune down toward 3-4 if the prompt routinely exceeds ~5K tokens, or up toward 6-7 if Opus complains about missing geography in its retries.
- **Edge cap of 8 per city** keeps the subgraph from blowing up at major cities (which can have 6-12 incident edges).

### 9. Logging

`LlmAttempt` entries are already recorded. Add one new `caller` value: `'trip-planner-raw-state'` so downstream analysis (and the existing `LLMTranscriptLogger`) can distinguish research-mode calls from production calls.

`TripPlannerSelectionDiagnostic.fallbackReason` does NOT need a new value — research mode either succeeds (LLM emits a valid plan) or fails (falls through to `planRoute`); both states are already represented.

### 10. Tests

Following the existing pattern under `src/server/__tests__/ai/`:

- **`RawStateContextBuilder.test.ts`** — unit tests for the subgraph BFS, per-city serialization format, owner-label correctness, ferry filtering. Mock `loadGridPoints`, `buildUnionTrackGraph`, `getMajorCityGroups`.
- **`TripPlanner.research.test.ts`** — integration tests for the new branch:
  - Research-mode skill level routes to `buildRawStateContext` (verify prompt content).
  - `TRIP_PLAN_SCHEMA_RAW` is passed to the adapter.
  - `segmentsToBuild` is parsed and stored on the route.
  - Validation failure triggers retry with error feedback.
  - Total failure falls through to `planRoute`.
- **`schemas.test.ts`** — schema regression test: `TRIP_PLAN_SCHEMA_RAW` accepts a known-good response and rejects responses missing `segmentsToBuild`.

Existing TripPlanner tests must continue to pass — the new branch is additive.

### 11. Experiment runner

Out of scope for the production code change but called out here so the technical surface is complete:

- **`scripts/ai/research-mode-headtohead.ts`** — orchestrate 10 games each across the three baselines (research-Opus vs Sonnet, vs deterministic-Medium, vs Hard-Opus). Reuse existing `scripts/captureContextFixtures.ts` patterns where applicable. Report the 7-metric table from the behavioral file.
- **`scripts/ai/research-mode-results.md`** — write the experiment results, parameter sweeps, cost actuals, and recommendation (productionize / archive / further research).

Both scripts can be added in a follow-up PR after the production-code change lands. The behavioral file's go/no-go decision should pass before either is built.

## Affected files

| Path | Change | Reason |
|---|---|---|
| `src/shared/types/GameTypes.ts` | `BotSkillLevel.Research` (Option A) OR `BotConfig.researchMode` (Option B) | Skill-level gate |
| `src/shared/types/GameTypes.ts` | `LLM_DEFAULT_MODELS[Anthropic][BotSkillLevel.Research] = 'claude-opus-4-7-1m'` | Default model |
| `src/server/services/ai/RawStateContextBuilder.ts` | New file (~250 LOC) | Subgraph BFS + serialization |
| `src/server/services/ai/schemas.ts` | Add `TRIP_PLAN_SCHEMA_RAW` | Output schema with `segmentsToBuild` |
| `src/server/services/ai/prompts/systemPrompts.ts` | Add `RAW_STATE_SYSTEM` const + new branch in `getTripPlanningPrompt` | New prompt path |
| `src/server/services/ai/TripPlanner.ts` | New `isResearchMode` branch in `planTrip`, schema/timeout switch | Wire new path |
| `src/server/services/ai/BuildPhasePlanner.ts` | Read `route.declaredSegments` if present, validate, emit BuildTrack actions | Honor LLM-declared track |
| `src/shared/types/GameTypes.ts` (`StrategicRoute`) | Optional `declaredSegments?` field | Path A storage |
| `src/server/__tests__/ai/RawStateContextBuilder.test.ts` | New | Unit tests |
| `src/server/__tests__/ai/TripPlanner.research.test.ts` | New | Integration tests |
| `src/server/__tests__/ai/schemas.test.ts` | Extend | Schema regression |
| `scripts/ai/research-mode-headtohead.ts` | New (follow-up PR) | Experiment runner |
| `scripts/ai/research-mode-results.md` | New (follow-up PR) | Experiment results |

## Estimated implementation cost

Excluding the experiment runner (separate PR):

- New module + serializer: ~250 LOC
- TripPlanner branch + schema + system prompt: ~50 LOC
- BuildPhasePlanner declaredSegments path: ~80 LOC
- Tests: ~400 LOC across three files

Approximately a 2-3 day implementation if Path A is chosen and the BuildPhasePlanner integration is the only real surprise.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Opus declares illegal segments (non-adjacent, blocking, etc.) at high rate | Path A's validation block in `BuildPhasePlanner` rejects per-segment with a structured error; retry loop appends the rejection to the user prompt for Opus to correct |
| Subgraph misses a critical city the demand depends on | `findCityMilepost` for every demand city is in the seed set; BFS is over the full base topology, so reachability is preserved. Tune `hopRadius` upward if Opus's retries cite missing geography |
| Cost runs higher than the $80 estimate | Implement prompt caching on `RAW_STATE_SYSTEM` first; halt the experiment after 3 games if per-game cost exceeds $15 |
| Existing tests regress because of additive changes to `StrategicRoute` | `declaredSegments` is optional; existing code that destructures `StrategicRoute` ignores it. Run full test suite after each PR step |
| Research mode accidentally enabled in production lobby | Default-off flag; lobby UI does not render the option without an explicit dev-tools toggle |

## Open implementation questions

1. **Path A vs Path B for `segmentsToBuild`.** Recommend Path A (additive optional field on `StrategicRoute`); Path B requires a new method on `BuildRouteResolver`. Either works.
2. **Should `propose` from the Medium schema be available to Research mode?** Probably no — raw-state mode IS the propose path, the entire output is freeform.
3. **Should Research mode honor `userPromptOverride`?** Yes — the same override semantics in the existing planTrip flow apply (skip the short-circuits, use the override prompt, run through the same validation). No changes needed beyond ensuring the gate at line 139 doesn't block the Research path differently than today.
4. **One LLM call or two?** A two-call structure (call 1: pick the trip; call 2: declare the track) is cheaper per call but doubles latency. Recommend one call for the experiment; if Opus is unreliable at declaring track, split in a follow-up.
5. **Stream vs block.** All current calls block. No reason to change for this experiment, but if latency becomes a UX problem in research mode the streaming option exists.

## Acceptance criteria

- AC1: A bot configured with research mode (skill level or flag) calls Opus with the `RAW_STATE_SYSTEM` system prompt and `TRIP_PLAN_SCHEMA_RAW` schema. No `OPTIONS` block in the user prompt.
- AC2: The map subgraph user-prompt section contains every demand's supply and delivery city, plus the bot's position, plus all coordinates within `hopRadius` of any seed.
- AC3: Edge ownership (`own` / `unbuilt` / `<opponent-name>`) is correct for every edge in the serialized subgraph (verified by unit test against a known fixture).
- AC4: A research-mode response with valid `segmentsToBuild` results in those segments being built by `BuildPhasePlanner`, not derived by `BuildRouteResolver`.
- AC5: A research-mode response with invalid `segmentsToBuild` (illegal adjacency, non-existent milepost, blocking rule) is rejected and the LLM is retried with the error in the user prompt.
- AC6: Existing skill-level paths (Easy/Medium/Hard) emit byte-identical prompts and pass byte-identical schemas to before this change.
- AC7: A 10-game research-mode experiment can run end-to-end without a manual intervention, and produces the 7-metric report from the behavioral file.

## Backout plan

Research mode is a new code path behind a default-off gate. Backout = revert the PR or set the flag/skill-level off. No production state migration; no schema migration; no data on disk that depends on this code path.
