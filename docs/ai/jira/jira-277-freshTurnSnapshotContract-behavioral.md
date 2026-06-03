# JIRA-277 — Bot reasoning and game-changing execution share no named, freshness-checked handoff, so a plan chosen from one turn picture can mutate game state after the facts under it have changed (behavioral)

There is no explicit contract between *what the bot believed when it chose a plan* and *what execution is allowed to change*. Context Builder prepares decision-time facts (money, position, carried loads, demands, active event-card effects, train capacity), the bot picks a plan from those facts, and then `TurnExecutor` applies build / movement / pickup / delivery actions — but nothing names the facts the plan was chosen against, and nothing checks that those facts still hold before the action mutates game state. `turnNumber` is the only freshness marker, and it cannot distinguish "same turn, but a mid-turn delivery already changed money and loads" from "nothing changed."

The result is a recurring failure family: a plan that was correct at decision time is applied against a different game state. The clearest evidence is the post-delivery carried-load strand (JIRA-263) — a replan derived from a pre-delivery snapshot mutates route/loads after the delivery already changed them. Today execution is the *first* place that staleness becomes a player-visible mutation, and the `TurnExecutor` re-snapshot at `TurnExecutor.ts:134-153` does a **silent best-effort re-capture** that can quietly swap the facts under a committed plan rather than failing closed.

This ticket introduces one explicit handoff — a **Fresh Turn Snapshot Contract** — built on the *existing* `WorldSnapshot` (not a parallel object): a freshness identity stronger than `turnNumber`, threaded from context building through plan validation into execution, with a fail-closed freshness check at the delivery / post-delivery replan boundary, and mismatch reported in product language.

## Source

Valence decision artifact and implementation bridge:
- `.valence-refactor/PROPOSAL.md` — refactor boundary, contract contents, stress tests, acceptance checks.
- `.valence-refactor/IMPLEMENTATION-BRIDGE.md` — code coordinates, sequenced first slice, test map.

Motivating in-repo evidence: the stale-snapshot bug family — JIRA-185 (post-delivery replan stale snapshot), JIRA-222 / JIRA-224 (validator / fresh-snapshot loads override), JIRA-233 (replan after delivery uses stale cargo), JIRA-263 (post-delivery replan strands carried load). Each is a separate symptom of the same missing boundary.

## What's wrong

- **No named decision-time picture.** Once the bot chooses a plan, Context Builder is still treated as a live source of truth. Nothing records the exact facts the plan was validated against.
- **No execution-boundary freshness check.** `TurnExecutor` mutates the in-memory snapshot in several places to keep later steps in sync (`TurnExecutor.ts:605-608, 744-758, 892-893, 962-963, 1010-1011`) with no named rule for when a mismatch should *reject* an action instead of silently patching state.
- **Silent best-effort re-snapshot.** `TurnExecutor.ts:134-153` re-captures after card-drawing actions on a best-effort basis. A capture failure silently continues with stale event-card rules state instead of failing closed.
- **`turnNumber` is too weak a freshness marker.** Same `turnNumber` with different loads/money/position (e.g. after an in-turn delivery) is treated as automatically fresh.

## Expected behavior

A small, testable, explainable contract between bot reasoning and game-changing execution:

- The decision-time `WorldSnapshot` carries a **freshness identity** — `turnNumber` plus a `factsHash` over the decision-critical facts (money, position, carried loads, demand cards, active event-card effects), with arrays canonicalized so equal facts always hash equal.
- That identity is threaded decision → validation → execution.
- Execution performs **one narrow freshness check** before mutating game state at the delivery / post-delivery replan boundary; a plan whose snapshot no longer matches the live facts **fails closed** with a product-language mismatch reason rather than silently patching state.
- The silent best-effort re-snapshot becomes a **named refresh** that reports its outcome explicitly and is fail-closed on capture error.
- Guardrails / postmortem can report "snapshot mismatch" in product language, not implementation language.

## Acceptance

- Every captured snapshot carries a freshness identity stronger than `turnNumber` alone (`turnNumber` + `factsHash`), and the field is additive/optional so all existing `WorldSnapshot` consumers compile unchanged.
- The freshness mechanism catches at least one mid-turn change `turnNumber` alone would miss — e.g. same turn, loads changed by an in-turn delivery, must **not** be treated as automatically fresh.
- At least one game-changing action (the post-delivery replan boundary, where the JIRA-263 carried-load evidence is strongest) records the snapshot identity it validated against; a stale plan returns a fail-closed, product-readable `SNAPSHOT_MISMATCH` instead of mutating money/loads/route.
- The named refresh on the card-drawing path reports its outcome and throws on capture failure (no silent continue on stale event-card rules state).
- Existing happy-path bot turns pass with no change to visible game behavior.
- A reviewer can tell which fields are in this first slice and which are deferred without reading source.

## Scope (first slice)

Per the implementation bridge — reconcile with the existing `WorldSnapshot`, do not invent a blank-slate `TurnSnapshot`:

1. Add the snapshot identity / freshness field to the existing decision-time snapshot (`src/shared/types/GameTypes.ts`, `WorldSnapshotService.capture()`) without changing visible bot behavior.
2. Thread that identity from context building through plan validation into `TurnExecutor`.
3. Add one execution-boundary freshness check for delivery / post-delivery replan.
4. Convert exactly one reactive re-capture path (the `TurnExecutor.ts:134-153` best-effort re-snapshot) into a measured, named validation/refresh point.

## Not in scope

- Whole-pipeline snapshot redesign, or a broad `TurnSnapshot` that copies every `WorldSnapshot` field.
- Rewriting route planning, LLM prompting, or guardrails wholesale.
- Any cash-reserve / minimum-balance rule.
- Claiming a measured post-refactor health improvement before Valence regenerates the map from the implemented branch.

## Relationship to existing JIRAs

- **Generalizes the stale-snapshot bug family** (JIRA-185 / 222 / 224 / 233 / 263) into a structural contract: instead of patching each stale-state symptom, name the decision-time facts and fail closed when execution no longer matches them. JIRA-263's post-delivery carried-load strand is the strongest motivating evidence and the chosen first-slice boundary.
- **JIRA-276 is explicitly NOT this.** That defect is a forward cash-lookahead gap in the upgrade-emit logic (the T14 snapshot there was *fresh and correct*; `assertFresh` would pass). It is a distinct check on a distinct code path. Note: JIRA-276's "Relationship" section currently refers to this work as "JIRA-275 (Fresh Turn Snapshot Contract)" — that cross-reference should point here (JIRA-277).
- **Not JIRA-275.** The real JIRA-275 (`done/jira-275-perTurnLogHidesLostLoadAndShowsOpaqueRouteExecutorReasoning`) is a per-turn NDJSON logging/observability ticket — a different, already-shipped piece of work. Commit `a5cc3103` labeled this slice "the JIRA-275 snapshot-contract slice"; the correct owner is JIRA-277.

## Follow-up slices

This ticket is **slice 1** — it proves the contract is real (not decorative) at the single highest-evidence boundary. Remaining proposal scope is tracked separately, one landable boundary per ticket:

- **JIRA-278** — extend the freshness check to the remaining `TurnExecutor` execution boundaries (build / movement / pickup / delivery), which today only re-mint identity without validating.
- **JIRA-279** — end-game victory-sprint re-verifies board/demand facts before mutating state, and resolves End-Game Routing's live-state reach into the snapshot.
- **JIRA-280** — make snapshot mismatch a guardrail-owned rejection with postmortem NDJSON visibility, and close the optional-identity escape hatch so the contract is enforced end-to-end.

## Implemented by

This ticket scopes work already on branch `matt/turn-snapshot-contract`:
- `f7bd35be` — BE-001: `SnapshotIdentity` type + `computeIdentity()` (single source of truth for freshness identity; `capture()` mints identity on every snapshot).
- `81a988a3` — BE-002: `TurnExecutor` re-mints identity after each in-place mutation; silent re-snapshot replaced by named `performNamedRefresh()` (fail-closed on error).
- `4bc40b27` — BE-003: `PostDeliveryReplanner.assertFresh()` + `SnapshotMismatch` typed error + `SNAPSHOT_MISMATCH` product-language constant; outcomes stamped with `derivedFromIdentity`.
- `ee146eca` — TEST-001: `snapshotContract.integration.test.ts` end-to-end coverage of the freshness pipeline.
