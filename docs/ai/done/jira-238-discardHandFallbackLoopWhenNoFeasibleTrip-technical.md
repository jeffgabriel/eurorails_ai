# JIRA-238 — DiscardHand fallback self-renews; consecutiveDiscards counter is read but never gates the next decision (technical)

Companion to `jira-238-discardHandFallbackLoopWhenNoFeasibleTrip-behavioral.md`.

## Investigation plan

### 1. Confirm the fallback path

`AIStrategyEngine.ts`:

- `:593` — `consecutiveDiscards` incremented when `executedAction === AIActionType.DiscardHand`.
- `:595` — `consecutiveLlmFailures` incremented when `decision.model === 'heuristic-fallback' || 'llm-failed'`.
- `:1064` — `case 'heuristic-fallback':` in the actor-mapping switch.
- `:691–698` — JIRA-56: after DiscardHand, refresh `context.demands` from new cards (works fine; this is not the bug).

The deterministic-planner branch that emits `no_feasible_candidates` lives in `TripPlanner.ts`. Find the exact branch (greppable for `no_feasible_candidates` literal) and confirm it short-circuits to the heuristic fallback without trying the LLM path.

### 2. Confirm LLM-fallback gating

The LLM path was not called across t17–t21 (`llmCallIds: []`). Determine why:
- Is Medium-skill bound to deterministic-only? If yes, then the LLM is correctly skipped, but then the heuristic fallback is the only fallback and needs to be smarter.
- If the LLM is supposed to fire on `no_feasible_candidates` for Medium skill, identify the gate that suppressed it.

Likely entry: `TripPlanner.planTrip` Medium branch (`TripPlanner.ts:212`) — if it returns `no_feasible_candidates`, does the caller try the LLM, or hand off to heuristic immediately?

### 3. Inspect the heuristic-fallback discard logic

Grep `src/server/services/ai` for where `decision.plan = { type: AIActionType.DiscardHand }` is set with model `heuristic-fallback`. Likely a small helper that:
1. Receives `no_feasible_candidates` from the planner.
2. Checks each card for at least one viable route. If none, picks DiscardHand.

The issue: this helper is stateless. Every turn it gets a fresh hand → re-runs the same check → emits DiscardHand again. The `consecutiveDiscards` counter is in scope but not read.

### 4. Inspect the consecutiveDiscards counter consumers

Grep for `consecutiveDiscards` usage:
- `AIStrategyEngine.ts:593` (write).
- Any reads should be located — if the counter is only written and never read for decision-making, that is the gap.

The `consecutiveLlmFailures` counter has documented usage in JIRA-120 (forced-discard after N LLM failures). The reverse direction (forced-non-discard after N heuristic discards) appears to be missing.

## Candidate fix shapes

### Fix A — Force LLM escalation after N heuristic-fallback discards

If Medium skill normally skips the LLM but a stuck state is detected (`consecutiveDiscards >= 2` AND cash unchanged AND no movement), invoke the LLM trip planner once as an escape valve. The LLM's higher-context reasoning may identify a feasible trip the deterministic planner over-rejected on threshold.

Risk: token cost on Medium skill, which is intentionally deterministic. Mitigate by capping at one LLM call per stuck-state cycle.

### Fix B — Least-bad trip commitment

In the heuristic-fallback discard helper, if `consecutiveDiscards >= 2`, fall through and select the highest-scoring candidate even if `score < 0`. Track its build cost vs. cash; if reachable, commit. The bot loses a small amount of value once but avoids losing 5 turns of game time.

This is the minimal, deterministic fix and is closest in spirit to the user's existing standing rule (per memory: PassTurn is legal only when mid-route and out of built track — never as a fallback for "no plan"). DiscardHand-as-self-renewing-fallback violates the same principle.

### Fix C — Loop detector gate at AIStrategyEngine

Wrap the existing decision pipeline with a gate: if `consecutiveDiscards >= 2`, override `decision.plan` away from `DiscardHand` and toward whatever non-discard action ranks next. The ranking is whatever the trip planner returns at `rank 1` regardless of negative score.

This is structurally cleanest because it doesn't require deeper logic in `TripPlanner`; the gate lives where the loop is observable. Implementation site: somewhere between `:435–440` (where the lockup-loop force-discard already exists) and `:535–550` (where the broke-and-stuck guardrail interacts with DiscardHand). The opposite-direction guardrail belongs nearby.

### Fix D — Stop discarding when the new hand drew the same problem

After DiscardHand at turn N, the engine has the new hand at turn N+1. Compare turn N+1's demandRanking against turn N's: if the top-ranked demand has comparable score (e.g., both negative or both below a threshold), don't discard again — the deck is genuinely full of low-value demands and shuffling is unlikely to help. Commit to the best available action.

## Recommended approach

Start with **Fix C** (loop detector at engine layer) plus **Fix B** (least-bad commitment as the fallback). This is the minimum that breaks the loop deterministically without adding LLM-cost regressions. Treat Fix A as a follow-on if Fix B's least-bad selections turn out to be too lossy in practice.

## Test coverage

- `AIStrategyEngine.test.ts`: snapshot returning `no_feasible_candidates` from the deterministic planner across 3 consecutive ticks; assert that turn 3 emits something other than `DiscardHand`.
- `AIStrategyEngine.test.ts`: snapshot with `consecutiveDiscards == 0` and a feasible-but-negative-score candidate; assert that DiscardHand is selected (default behavior preserved).
- `AIStrategyEngine.test.ts`: snapshot with `consecutiveDiscards == 2` and only negative-score candidates; assert that the engine commits to the least-bad candidate (Fix B) rather than discarding again.

## Open questions

1. Is the LLM-fallback gated off Medium skill by design? If yes, document the policy in code comments; if no, the gate is a bug independent of this ticket.
2. Should Fix B's threshold be `score >= 0` or something looser (e.g., `score >= -5`)? Pick by replaying the s3 t17–t21 snapshots through the proposed logic and checking what the bot would have done.
3. Does the deterministic planner's `no_feasible_candidates` outcome match the spirit of the original deterministic-or-LLM split, or is it a leak that the LLM was supposed to absorb? Audit `TripPlanner.skill-fork.test.ts` for the documented contract.

## Not in scope

- Scoring tuning to make more hands feasible — separate ticket.
- LLM prompt or model selection — out of scope.
- Network-expansion strategy when stuck — interesting but speculative; defer.
