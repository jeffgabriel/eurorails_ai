# Compounds Task Breakdown: Gap Analysis & Feedback

**Project:** ai-v6 (LLM-as-Strategy-Brain)
**Date:** 2026-02-17
**Context:** Used full Compounds workflow (PRD upload → tech spec research → pattern detection → spec generation → validation → plan_project) to generate 9 implementation tasks. Post-generation review found 4 critical tasks missing and several spec content gaps.

---

## 1. Missing Tasks (Critical)

The breakdown generated 9 tasks but missed 4 that are essential for a working implementation. Without these, the other 9 tasks produce components that can't be connected.

### 1a. LLMStrategyBrain — the core orchestrator

**What's missing:** No task creates the `LLMStrategyBrain` class, which is the central module that calls GameStateSerializer → ProviderAdapter → ResponseParser → GuardrailEnforcer and manages the retry/fallback chain.

**Root cause:** The tech spec describes LLMStrategyBrain in Section B7.1 as a *service that uses* the other modules. The breakdown appears to have decomposed LLMStrategyBrain into its constituent parts (serializer, adapters, parser) but never created a task for the orchestrator itself. It's the "glue" module — it doesn't have a single clear responsibility like "parse JSON" or "call API", so the decomposition missed it.

**Evidence:** TEST-001's prompt explicitly references `LLMStrategyBrain` as a module to test and assumes it exists. The PRD's MVP scope item #1 is "`LLMStrategyBrain` class with Anthropic provider adapter, response parsing, and guardrails." Yet no BE-xxx task creates it.

### 1b. GuardrailEnforcer — post-LLM hard rule checking

**What's missing:** No task creates the `GuardrailEnforcer` class (3 hard rules: delivery move override, bankruptcy prevention, discard override).

**Root cause:** Similar to LLMStrategyBrain — the breakdown created tasks for the components GuardrailEnforcer *depends on* (types in BE-001, tests in TEST-001) but not for the module itself. The tech spec describes it in B7.4 with full rule specifications. The companion `docs/aiLLM/technical-spec.md` has 90 lines of pseudocode for it.

**Evidence:** TEST-001 has a subtask "Unit Tests: GuardrailEnforcer" that assumes the class exists. BE-001 defines the `GuardrailResult` interface (the return type). But no task implements the class.

### 1c. AIStrategyEngine modification — wiring LLM into the pipeline

**What's missing:** No task modifies `AIStrategyEngine.takeTurn()` to replace `Scorer.score()` with `LLMStrategyBrain.selectOptions()` for Phase 1 and Phase 2 decisions.

**Root cause:** This is a *modification to an existing file*, not a new module. The breakdown appears biased toward "create new thing" tasks and missed "modify existing thing" tasks. The tech spec describes this clearly in B7.7 with before/after code showing the exact lines to change (AIStrategyEngine.ts:118-168 for Phase 1).

**Evidence:** The PRD's MVP scope item #3 is "Wire into `AIStrategyEngine.takeTurn()` — replace `Scorer.score()` for Phase 1 + Phase 2 decisions." The tech spec B7.7 has the modification pattern. No task implements it.

### 1d. DecisionLogger extension — LLM-specific audit fields

**What's missing:** No task extends `DecisionLogger` to log LLM-specific fields (model, latencyMs, tokenUsage, reasoning, planHorizon, guardrail overrides).

**Root cause:** Same pattern as 1c — this is an *extension to an existing module*, not a new one. The tech spec's "Discovered from Codebase" section (line 43) explicitly says "**Extend** to log LLM-specific fields" but the breakdown didn't generate a task for it.

**Evidence:** The tech spec marks DecisionLogger as EXISTS with usage "Extend". The `TurnDecisionLog` type extension is in BE-001 (types), but the actual code change to DecisionLogger.ts is not in any task.

---

## 2. Root Cause Pattern

All 4 missing tasks share a common pattern:

**The breakdown decomposes new modules well but misses orchestrators and modifications to existing code.**

Specifically:
- **Leaf nodes get tasks; internal nodes don't.** GameStateSerializer, ResponseParser, ProviderAdapters, and system prompts are all "leaf" dependencies — they don't call other new modules. They all got tasks. LLMStrategyBrain and GuardrailEnforcer are "internal" modules that orchestrate the leaves. They didn't get tasks.
- **New files get tasks; modified files don't.** Every task creates a new file. No task modifies an existing file (AIStrategyEngine.ts, DecisionLogger.ts). The tech spec explicitly marks these as "EXISTS → Extend/Modify" but the breakdown only generated "MISSING → Create" tasks.

**Suggested fix for the breakdown agent:**
1. After generating tasks, verify that every module in the spec's "Required Implementation" section AND every "EXISTS → Extend/Modify" item has a corresponding task.
2. Specifically check for orchestrator/glue modules that call multiple new modules — these are the most likely to be missed.
3. Check for "wiring" tasks — when new modules need to be integrated into existing code, that integration is itself a task.

---

## 3. Spec Content Gaps

These details exist in the companion docs (`docs/aiLLM/technical-spec.md` and `docs/aiLLM/prompt-catalog.md`) but were not surfaced in the Compounds tech spec. Since the breakdown agent uses only the Compounds tech spec, these details are invisible to it.

| Missing Detail | Source Document | Why It Matters |
|---|---|---|
| `maxTokens: 256` for LLM response | `technical-spec.md:157` | Without this, implementer must guess the token budget |
| `temperature: 0.3` (0.5 for Easy) | `technical-spec.md:158` | Controls response consistency; varies by skill level |
| `LLMStrategyConfig` named interface | `technical-spec.md:26-34` | Config type with archetype, skillLevel, provider, model, apiKey, timeoutMs, maxRetries |
| Option type mapping note | `prompt-catalog.md:224-228` | `BuildTowardMajorCity` and `PickupAndDeliver` don't exist as prompt option types — they map to `BuildTrack` with annotations |
| Ferry crossing annotation in prompts | `prompt-catalog.md:282` | Serializer should note "Route includes 1 ferry (movement penalty)" |
| Upgrade ROI pre-computation | `prompt-catalog.md:287` | `(speedGain x avgRouteLength x estRemainingDeliveries) / cost` |
| `lastTurnSummary` for Hard skill | `prd-aiLLM.md` Section 5.2 | Single line from previous turn's audit for strategic continuity |
| `heuristicFallback()` scoring logic | `technical-spec.md:107-144` | Highest-payment feasible move + highest-chainScore build |

**Root cause:** The Compounds tech spec was generated from the PRD + codebase research. The companion docs (`technical-spec.md`, `prompt-catalog.md`) contain implementation-level detail (pseudocode, constants, example prompts) that the Compounds spec format doesn't naturally capture — it focuses on architecture, not code-level constants.

**Suggested fix:** When the PRD references companion documents (as ours does in Sections 3 and 6), the spec generation step should either:
1. Ingest those companion docs as additional context, or
2. Flag them as "referenced but not ingested — manual review needed"

---

## 4. What Worked Well

For completeness, the breakdown got these right:

- **Type definitions task (BE-001):** Correctly identified all new interfaces needed and grouped them into one task
- **Provider adapters (BE-003, BE-004):** Clean separation of Anthropic and Google into separate tasks with correct priority (Anthropic HIGH for MVP, Google MEDIUM for Phase 2)
- **GameStateSerializer (BE-005):** Detailed prompt with skill-level filtering, security constraints, and reference to prompt-catalog.md format
- **System prompts (BE-006):** Correctly identified as a separate task from the serializer
- **Test task (TEST-001):** Comprehensive — covers all modules including the ones that are missing implementation tasks. Good subtask decomposition.
- **Task prompts are rich:** Each task has detailed implementation steps, acceptance criteria, and design pattern references. The prompts are production-quality.

---

## 5. Summary

| Category | Count | Items |
|---|---|---|
| Tasks generated | 9 | INF-001, BE-001 through BE-007, TEST-001 |
| Missing tasks (critical) | 4 | LLMStrategyBrain, GuardrailEnforcer, AIStrategyEngine wiring, DecisionLogger extension |
| Spec content gaps | 8 | Constants, config type, option type mapping, pre-computations, fallback logic |
| Root cause | 1 | Breakdown decomposes leaf modules but misses orchestrators and existing-file modifications |
