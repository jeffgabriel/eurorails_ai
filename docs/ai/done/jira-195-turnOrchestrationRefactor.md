# JIRA-195: Turn Orchestration Refactor

**Status:** PLAN — awaiting review.
**Related:** JIRA-156, JIRA-184, JIRA-190, JIRA-191, JIRA-193, JIRA-194.
**Dependency:** JIRA-193 and JIRA-194 must land in `main` with their regression tests before Slice 3 begins.

This is a structural refactor. **No new bot mistakes.** The intent is no behavioural change, but several known bugs (JIRA-193 pickup-then-stop, the upgrade-consistency split, the JIRA-194 stale-locals class) live in exactly the code being restructured, and some may disappear as a side effect of the cleaner shape. That is acceptable. The acceptance bar protects against regressions, not against incidental improvements.

## Why now

Recent tickets (JIRA-170, 173, 184, 187, 190, 191, 193, 194) keep landing as conditionals and re-snapshots inside the same three files: `AIStrategyEngine`, `TurnExecutorPlanner`, and `ContextBuilder`. Each fix is correct in isolation. Cumulatively they are a signal that the contracts between these pieces did not anticipate the phase transitions (pickup → mid-turn replan → move → build) that real turns actually contain. Four symptoms:

1. **`ContextBuilder.ts` is 3063 LOC** holding two responsibilities: computing ~25 decision signals *and* hosting five prompt serializers (~750 LOC). Every new signal and every new prompt variant lands here.
2. **Stage-ordering patches in `AIStrategyEngine`.** Context is built before memory is loaded, so memory-dependent signals get re-computed in patch blocks at `ts:228-237` and again at `ts:417-436` after auto-delivery.
3. **Three LLM advisors spread across three files with no coordinator.** `RouteOptimizer` in `TripPlanner.ts:332`, `RouteEnrichmentAdvisor` in both `AIStrategyEngine.ts:459` and `TurnExecutorPlanner.ts:470`, `BuildAdvisor` in `TurnExecutorPlanner.ts:871, 906`. A future fourth advisor has no obvious home.
4. **A nested trip-planning loop inside the movement phase.** `TurnExecutorPlanner.ts:450-470` instantiates a fresh `TripPlanner` mid-turn. JIRA-194's stale-local bug is a symptom of this nesting — Phase A's locals go stale because the route is being replaced underneath them.

## Current behaviour (plain English)

When it's the bot's turn, the turn unfolds like this:

1. **Take a snapshot** of the game state — money, train, loads, demand cards, the whole board.
2. **Compute context** — decision-relevant facts derived from the snapshot: "what can I deliver right now?", "what cities are reachable?", "should I upgrade?", "where is the nearest unconnected major city?". This step runs *before* the bot's memory of past turns is loaded, so a handful of memory-dependent fields are wrong at this point. The engine patches them up in a fix-up block right after.
3. **Decide what to do.** If the bot has an active route from a previous turn, continue with it as-is. Otherwise, ask the LLM trip planner for a new route — and as part of that route plan, the LLM also emits an `upgradeOnRoute` recommendation that gets consumed once and queued. If a delivery happened on the way into this turn, take a fresh snapshot, rebuild context, and patch the same memory-dependent fields a second time. The LLM enrichment advisor runs **only when a route is freshly created here**, not on continuation turns.
4. **Run the route** — this is the engine room and where the most bugs land. There are two phases inside it:
   - **Movement.** Step toward the next stop on the route. Execute pickups, deliveries, drops as the bot arrives. After a delivery, the bot may decide mid-turn that the rest of the route is stale — when this happens, a brand-new trip planner is instantiated and run inline, and the enrichment advisor is called a second time. The local variables that track "where I'm moving to" can become stale across this replan, which is the class of bug JIRA-194 just fixed.
   - **Build / Upgrade.** Game rules treat building track and upgrading the train as siblings — both spend from the up-to-20M build budget, and the bot can do one or the other. Today the codebase doesn't honour that symmetry: the build path asks the LLM build advisor for waypoints (with a one-shot solvency retry) and computes track segments, while the upgrade decision was made earlier in step 3 at route creation and is just being executed here as a queued action. A continuation turn never reconsiders whether to upgrade, even if the delivery-count gate has crossed or solvency has changed since the route was planned. There is one narrow exception — an "upgrade instead of dropping a load" LLM call that fires only in cargo-conflict situations. This split is why upgrades fire inconsistently.
5. **Check guardrails** against the composed plan.
6. **Execute** — write to the database, emit to the socket.
7. **Update memory and log.**

The pipeline is sound. The complaints above all describe the same structural shape: too much logic packed into too few files, with the seams between phases left implicit (shared locals, patch-up blocks, advisor calls scattered across three files).

## Future behaviour (plain English)

After the refactor, the same seven steps happen in the same order. The bot's decisions should be substantially the same on a pinned-seed game — the intent is not to change behaviour. Some known bugs may disappear as side effects of the cleaner structure; that is acceptable. What changes is where each kind of work lives:

1. **Snapshot** — unchanged.
2. **Compute context** — runs once, with memory already available. No patch-up blocks afterward. The single `ContextBuilder` file is replaced by four small computation modules (demand, network, build, upgrade) and a separate prompt-serializer module, all hidden behind a thin facade so callers see the same flat context object they see today.
3. **Decide what to do** — same logic, same decisions. Internal cleanup of this stage is named as a follow-up but not done in this ticket.
4. **Run the route:**
   - **Movement.** Same step-by-step movement. When a mid-turn replan is needed, instead of instantiating a fresh trip planner inline, the movement phase calls a dedicated `PostDeliveryReplanner` service. That service returns the new route along with an explicit "your move target is now stale" signal, so the JIRA-194 class of bug is structurally impossible.
   - **Build / Upgrade.** Same logic, same outcomes on a pinned-seed game. Instead of calling the build advisor and the enrichment advisor directly from inside the movement and build code, both calls go through a single `AdvisorCoordinator`. Build and upgrade are both modelled as build-phase work — the upgrade execution still consumes the queued action from route creation today, but the phase is now structured so that a future ticket can add a per-turn upgrade re-evaluation step in one obvious place (inside the build phase, alongside the build-advisor call). Fixing the upgrade-consistency bug is *not* part of this refactor, but its home becomes obvious.
   - At the boundary between movement and build, an explicit handoff object passes route state across. The current implicit shared-locals coupling becomes a named contract.
5. **Guardrails, execute, memory, log** — unchanged.

Externally: same bot, possibly with a few fewer self-inflicted wounds. Internally: the next ticket has an obvious home, the next advisor has an obvious home, and the next phase-transition bug is harder to write.

## Slices

Compounds will fill in the technical details per slice. Plain-English scope only:

**Slice 1 — Fix stage ordering, then split `ContextBuilder`.**
Pass memory into `ContextBuilder.build()` so it computes everything correctly the first time; delete both patch-up blocks. Split the file into four computation modules (demand, network, build, upgrade) plus a prompt-serializer module, behind a facade that keeps the public `BotContext` shape unchanged.

**Slice 2 — Introduce `AdvisorCoordinator` (narrow scope).**
Move the two advisor call sites inside `TurnExecutorPlanner` (`BuildAdvisor` and `RouteEnrichmentAdvisor`) behind a single coordinator. Pure code motion, zero behaviour change. The third advisor (`RouteOptimizer` in `TripPlanner`) and the initial-route enrichment call in `AIStrategyEngine` stay where they are — they are deferred follow-ups (Slice 2b), to be done only if a concrete need emerges. A per-turn LLM budget is *not* part of Slice 2; it would be a behaviour change and lives in a separate Slice 2c if we ever want it.

**Slice 3 — Extract the post-delivery replan, then split `TurnExecutorPlanner`.**
Two sub-slices, in order:
- **3a:** Pull the in-movement replan block (`TurnExecutorPlanner.ts:444-490`) into a dedicated `PostDeliveryReplanner` service. Result carries an explicit "move target invalidated" signal across the boundary.
- **3b:** Once the nested call is gone, split `TurnExecutorPlanner` into `MovementPhasePlanner` and `BuildPhasePlanner`. Phase A returns a named handoff object (`PhaseAResult`) to Phase B. JIRA-194's class of bug becomes structurally impossible.

Prerequisite for Slice 3: JIRA-193 and JIRA-194 must be in `main` with regression tests, so we have a zero-diff oracle.

**Slice 4 — Scope Stage 3 of `AIStrategyEngine` as a follow-up ticket.**
Half-day spike, no code change. `AIStrategyEngine.takeTurn` Stage 3 alone is 468 LOC (`ts:259-727`) and accumulates patches. Read it end to end, identify natural sub-stages, file a follow-up ticket. Do not attempt extraction here — too many cross-references to the rest of `AIStrategyEngine` until Slices 1-3 settle.

## Sequencing

**Slice 1 → Slice 2 → Slice 3a → Slice 3b → Slice 4 (scoping spike).**

Each slice ships behind its own PR. Slice 3 only begins after JIRA-193 and JIRA-194 are in main.

**Acceptance bar: no behavioural regressions on a pinned-seed game-log replay.** Diffs are expected and reviewed, not banned. Each diff against the seed must be classified before merge:

- **Acceptable** — the bot makes a *better* decision (uses more of its movement budget, picks up an upgrade it was previously missing, builds toward a delivery instead of stalling, etc.). Reference the known-bug ticket if one exists; if not, note the improvement and merge. Bugs we can't reproduce after the refactor are wins, not failures.
- **Blocker** — the bot makes a *new* mistake (wastes movement it was previously using, picks a worse delivery, builds dead-end track, fires a guardrail it didn't fire before). Stop and investigate before continuing.
- **Neutral / unexplained** — same outcome, different path; or a diff with no clear "better/worse" reading. Spend a few minutes understanding it, then either merge with a note or escalate.

The point is to prevent regressions, not to freeze the bot's existing mistakes in amber.

## Non-goals

- Not changing the 6-stage pipeline shape in `AIStrategyEngine.takeTurn`. The abstraction is correct.
- Not collapsing the three planners (`InitialBuildPlanner`, `TripPlanner`, `TurnExecutorPlanner`). They are three different problems.
- Not changing prompts, guardrails, or scoring heuristics. Serializers move verbatim.
- Not changing the public shape of `BotContext`. Internal slicing only.
- Not adding a per-turn LLM budget in the base slices.
- Not rewriting `ActionResolver`. Big but clean; it pays for its size.
- No new frameworks (no plugin systems, no event bus, no DI container).

## Expected outcome

Same bot, broadly the same decisions on the same seed game — possibly a few incidental bug fixes where the cleaner structure makes a known wound impossible. Inside the codebase: stage ordering fixed, `ContextBuilder` reduced from 3063 LOC to a thin facade, advisor calls in the turn-execution path concentrated behind one coordinator, the nested mid-turn trip-planning loop extracted into a named service, and the Movement/Build seam expressed as a typed handoff. The next ticket has an obvious home.
