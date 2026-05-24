# JIRA-147: Web-Based Game Log & LLM Transcript Viewer

## Problem

Debugging bot behavior requires running `npx tsx scripts/llm-transcript.ts <game-id>` from the CLI and scrolling through monospace output. This is:
- Slow to navigate (no search, no collapsible sections, no filtering)
- Hard to correlate game events with LLM calls (two separate log files)
- Can't share easily — requires repo access and local tooling
- No way to compare turns side-by-side or trace a load across its lifecycle

## Proposal

Add two server-side routes that serve an interactive HTML log viewer:

| Route | Data Source | View |
|-------|-----------|------|
| `/log/:gameId` | `logs/game-{gameId}.ndjson` | Turn-by-turn game log |
| `/llm/:gameId` | `logs/llm-{gameId}.ndjson` | Full LLM call transcripts |

A third route serves as an index page:

| Route | Data Source | View |
|-------|-----------|------|
| `/logs` | `logs/*.ndjson` directory listing | Game index — all available logs |

All routes serve **server-rendered HTML** (no React/Phaser dependency). The pages are standalone — plain HTML + inline CSS + vanilla JS. No build step required.

### Prerequisite: Fix `model` field semantics in NDJSON logs

The current `model` field in `GameTurnLogEntry` is overloaded — it stores `'route-executor'`, `'heuristic-fallback'`, `'trip-planner'` etc. when no LLM was called, and the actual model name (e.g. `'claude-haiku-3-5'`) when one was. These are two different concepts:

- **Decision source** — which pipeline component produced the turn decision (always present)
- **Model** — which LLM model was called, if any (only present on LLM-driven turns)

The log viewer should display these separately. Options:
1. **Parse at read time** — the viewer infers decision source from the model field using the existing `isLlmModel()` heuristic (current approach in `llm-transcript.ts`)
2. **Fix at write time** — add a `decisionSource` field to `GameTurnLogEntry` and `GameLogger`, and reserve `model` for the actual LLM model name (null/undefined when deterministic)

Option 2 is cleaner and should be done as part of this ticket. New log entries get both fields; the viewer falls back to `isLlmModel()` parsing for old logs.

## Route 0: `/logs` — Game Index Page

Lists all available game logs sorted by most recent first.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Game Logs (12 games)                                       │
├─────────────────────────────────────────────────────────────┤
│  Game ID      │ Date       │ Turns │ Players  │ Models     │
│  e02b742e...  │ 2026-03-24 │  24   │ Haiku    │ haiku-3.5  │
│  3343532e...  │ 2026-03-23 │  41   │ Bot1,Bot2│ sonnet-4   │
│  ...          │            │       │          │            │
└─────────────────────────────────────────────────────────────┘
```

Each row links to `/log/:gameId`. Metadata (turns, players, models) is extracted by reading the first and last lines of each NDJSON file.

---

## Route 1: `/log/:gameId` — Game Turn Viewer

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Game: e02b742e | 24 turns | Players: Haiku               │
│  Models: haiku-3.5 | Decision sources: trip-planner, route-executor │
├──────────┬──────────────────────────────────────────────────┤
│ FILTERS  │  TURN DETAIL                                     │
│          │                                                   │
│ Player:  │  ── Turn 9 | Haiku | Early Game | Cash: 41M ──  │
│ [All ▾]  │                                                   │
│          │  (30,30) → (30,29) | Carrying: [Cars, Machinery] │
│ Turns:   │                                                   │
│ [1]-[24] │  [STRATEGY] trip-planner | 6.2s                  │
│          │  Action: BuildTrack                               │
│ Phase:   │  Reasoning: [route-executor] [PlanExecutor...]    │
│ [All ▾]  │                                                   │
│          │  ▶ Trip Planning (click to expand)                │
│ Model:   │  ▶ Build Advisor (click to expand)                │
│ [All ▾]  │  ▶ Validation (click to expand)                  │
│          │  ▶ System Prompt (click to expand)                │
│ Search:  │  ▶ User Prompt (click to expand)                 │
│ [______] │                                                   │
│          │  → picked up: Machinery@Nantes | built: 14 (20M) │
├──────────┤                                                   │
│ STATS    │  ── Turn 10 | Haiku | Early Game | Cash: 30M ── │
│          │  ...                                              │
│ LLM: 15  │                                                   │
│ Tokens:  │                                                   │
│  42k/8k  │                                                   │
│ Retries:2│                                                   │
│ Errors: 0│                                                   │
└──────────┴──────────────────────────────────────────────────┘
```

### Features

**Sidebar Filters** (all combinable, URL-persisted as query params):
- **Player** dropdown — filter to single bot
- **Turn range** slider — min/max turn
- **Game phase** — Initial Build, Early Game, Mid Game, Late Game
- **Decision source** — trip-planner, route-executor, heuristic-fallback, etc. (the pipeline component that made the decision — NOT the LLM model)
- **Model** — the actual LLM model: haiku-3.5, sonnet-4, gemini-2.5-pro, etc. (only present on LLM-driven turns)
- **Text search** — searches reasoning, action, error fields

**Turn Cards** (main content area):
- Header: turn number, player, phase, cash, train type
- Position line: start → end, carried loads, connected cities
- Decision source badge: `[STRATEGY]`, `[ROUTE EXECUTOR]`, `[HEURISTIC FALLBACK]`
- Collapsible sections for verbose data:
  - Trip Planning: candidates table, chosen route, reasoning
  - Build Advisor: action, waypoints, reasoning
  - Turn Validation: gates table, outcome, recompositions
  - System Prompt / User Prompt: full text (collapsed by default)
  - LLM Retries: attempt list with errors and latency
- Execution results: pickups, deliveries, track built, fees, movement
- Error banner (red) when `success: false`
- Guardrail override warning (yellow) when `guardrailOverride: true`

**Aggregate Stats** (sidebar, always visible):
- Total turns, LLM calls, token usage (in/out)
- Avg latency, retries, failures
- Deliveries completed, total revenue earned
- Cities connected progression

**Navigation:**
- Link to `/llm/:gameId` for full transcript view
- Each turn card links to `/llm/:gameId?turn=N&player=X` to jump to the LLM calls for that turn

### Color Coding
- Green border: successful delivery turn
- Red border: error turn
- Yellow border: guardrail override
- Gray border: routine turn
- Blue badge: LLM-driven decision
- Gray badge: deterministic (route-executor, heuristic)

## Route 2: `/llm/:gameId` — LLM Transcript Viewer

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  LLM Transcripts: e02b742e | 42 calls | 3 models           │
├──────────┬──────────────────────────────────────────────────┤
│ FILTERS  │  LLM CALL DETAIL                                 │
│          │                                                   │
│ Player:  │  ── Call #7 | Turn 9 | Haiku | trip-planner ──  │
│ [All ▾]  │  Status: success | 6.2s | 2,436 in / 487 out    │
│          │                                                   │
│ Turn:    │  ▼ System Prompt (2,891 chars)                   │
│ [1]-[24] │  │ You are planning multi-stop TRIP CANDIDATES.  │
│          │  │ Generate 2-3 candidate trips...               │
│ Caller:  │  │ ...                                           │
│ [All ▾]  │                                                   │
│          │  ▼ User Prompt (128 chars)                       │
│ Status:  │  │ Plan the best multi-stop trip for this turn.  │
│ [All ▾]  │                                                   │
│          │  ▼ Response (487 tokens)                         │
│ Model:   │  │ { "candidates": [ ... ], "chosenIndex": 0 }  │
│ [All ▾]  │                                                   │
│          │  ▶ Parsed Response (formatted JSON)              │
└──────────┴──────────────────────────────────────────────────┘
```

### Features

**Sidebar Filters:**
- Player, Turn, Caller (strategy, trip-planner, build-advisor, cargo-conflict), Status (success, error, timeout, validation_error), Model (the actual LLM: haiku-3.5, sonnet-4, gemini-2.5-pro, etc.)

**Call Cards:**
- Header: call number, turn, player, caller method, model
- Status badge with latency and token counts
- System prompt: full text, collapsible, syntax-highlighted
- User prompt: full text, collapsible
- Response: raw text + formatted/pretty-printed JSON toggle
- Error detail (if status != success)
- Attempt number / total attempts (shows retry context)

**Cross-linking:**
- Each call links back to `/log/:gameId?turn=N` for the game context
- Retry chains grouped visually (attempt 1, 2, 3 under one header)

**Prompt Diffs (retry chains):**
- When a retry chain has 2+ attempts, show a diff view between consecutive prompts
- Highlight what changed between attempt N and attempt N+1 (typically the `PREVIOUS ATTEMPT FAILED:` error context appended to the user prompt)
- Use a simple inline diff: green background for added lines, red for removed
- Implemented in vanilla JS using a basic line-by-line comparison (no external diff library needed — prompts are structured text and changes are typically appended blocks)

## Implementation Architecture

### Server Side

**New file: `src/server/routes/logRoutes.ts`**
- `GET /logs` — lists all game logs from `logs/` directory, renders HTML index
- `GET /log/:gameId` — reads `logs/game-{gameId}.ndjson`, renders HTML
- `GET /llm/:gameId` — reads `logs/llm-{gameId}.ndjson`, renders HTML
- `GET /api/log/:gameId` — returns raw JSON array (for potential future client use)
- `GET /api/llm/:gameId` — returns raw JSON array
- No auth required (dev-only tool, not player-facing)

**HTML rendering:** Use template literals in the route handler. The HTML is self-contained with inline `<style>` and `<script>` tags. No external dependencies, no build step.

**Log parsing:** Reuse the NDJSON parsing logic from `scripts/llm-transcript.ts`. Extract the `loadLog()`, `parseTurnRange()`, `fmt()`, `secs()`, `loc()`, `isLlmModel()` helpers into a shared `src/server/services/logParser.ts` that both the CLI script and routes can import.

### Client Side (inline vanilla JS)

- Filter controls update URL query params and re-filter the DOM (no page reload)
- Collapsible sections via `<details>/<summary>` elements (zero JS needed for basic expand/collapse)
- Text search uses `element.textContent.includes()` to show/hide turn cards
- JSON pretty-printing via `JSON.stringify(parsed, null, 2)` in a `<pre>` block

### Data Flow

```
logs/game-{id}.ndjson  →  logParser.ts  →  GET /log/:id  →  HTML response
logs/llm-{id}.ndjson   →  logParser.ts  →  GET /llm/:id  →  HTML response
```

No database involvement. Reads directly from the filesystem.

## Non-Goals (Out of Scope)

- **Real-time streaming** — logs are read on page load, not live-updated
- **Multi-game comparison** — one game per page
- **Log editing or annotation** — read-only view
- **React/Phaser integration** — standalone HTML pages, not part of the game client
- **Authentication** — dev tool, no auth needed
- **Map visualization** — no board rendering (just coordinates)

## Decisions

1. **Log file retention** — keep all old logs. No auto-cleanup.
2. **Game index page** — yes, `/logs` lists all available games (see Route 0 above).
3. **Export** — not needed. CLI script still available for markdown output.
4. **Prompt diffs** — yes, show inline diffs between retry attempts in the LLM transcript viewer.

## Estimated Scope

- **GameLogger.ts / GameTurnLogEntry** — add `decisionSource` field, reserve `model` for actual LLM model
- **AIStrategyEngine.ts** — populate `decisionSource` alongside `model` in log entries
- **logParser.ts** — extract shared helpers from `scripts/llm-transcript.ts`, add backward-compat `isLlmModel()` fallback for old logs
- **logRoutes.ts** — three routes (index + game + llm) + HTML templates
- **Register routes** in server bootstrap
- **Update llm-transcript.ts** to import from shared parser

Standard tier. ~6-7 files touched.
