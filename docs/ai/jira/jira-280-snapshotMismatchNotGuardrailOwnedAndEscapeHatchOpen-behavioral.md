# JIRA-280 — Snapshot mismatch is a thrown error inside one planner rather than a guardrail-owned rejection with postmortem visibility, and the optional-identity escape hatch means the freshness contract silently no-ops whenever identity is undefined (behavioral)

Follow-up slice to **JIRA-277** (Fresh Turn Snapshot Contract). Two gaps keep the contract from being enforced end-to-end and explainable after the fact:

1. **Mismatch is not guardrail-owned and not visible to postmortem.** `SNAPSHOT_MISMATCH` exists only as a string constant on `GuardrailEnforcer` (`GuardrailEnforcer.ts:54`); the actual check lives inside `PostDeliveryReplanner`, which `throw`s `SnapshotMismatch`. `GuardrailEnforcer` itself runs no freshness gate, and a mismatch is not recorded as a structured field in the per-turn NDJSON, so postmortem can't tell whether a bad turn came from the original decision, stale state, or execution — one of the proposal's stated payoffs.
2. **The escape hatch is wide open.** `assertFresh` returns `Ok` whenever *either* identity is `undefined` (`PostDeliveryReplanner.ts:79`). Because `WorldSnapshot.identity` is additive/optional, any path that doesn't stamp identity silently bypasses the check. The contract is opt-in, not enforced.

Together these mean the freshness check protects exactly the paths that happen to carry identity, fails by throwing rather than by a guardrail rejection a reviewer can read, and leaves no postmortem trace.

## Source

- `.valence-refactor/PROPOSAL.md` — *"Guardrails can reject a legal-looking action when it no longer matches the decision-time facts"*; *"Guardrails report snapshot mismatch in product language, not implementation language"*; *"Postmortem can explain whether a bad turn came from the original decision, stale state, or execution."*
- Known risk called out in the proposal: *"If execution keeps reaching back to live context, the new contract will be decorative rather than protective."*

## What's wrong

- `SNAPSHOT_MISMATCH` is referenced only by `PostDeliveryReplanner.assertFresh`; `GuardrailEnforcer` has no freshness gate of its own.
- Mismatch surfaces as a thrown `SnapshotMismatch`, not as a guardrail rejection with a product-readable reason in the turn record. No `snapshotMismatch` / `freshness` field appears in the per-turn `game-*.ndjson`.
- `assertFresh` short-circuits to `Ok` on any `undefined` identity, so the contract is bypassed on every unstamped path.

## Expected behavior

- Snapshot mismatch becomes a **guardrail-owned rejection**: `GuardrailEnforcer` checks freshness at the execution boundary and rejects with the `SNAPSHOT_MISMATCH` product-language reason, rather than the check being a planner-local `throw`.
- A mismatch is recorded as a **structured postmortem field** in the per-turn NDJSON (parallel to existing guardrail/decision-source fields) so a reader can attribute a bad turn to decision vs. stale state vs. execution.
- Once all decision-time producers stamp identity, the `undefined`-identity escape hatch is closed: `assertFresh` no longer treats a missing identity as fresh on enforced paths (a legacy/compat flag may remain for replay of pre-contract logs).

## Acceptance

- At least one execution-boundary mismatch is surfaced as a guardrail rejection with the `SNAPSHOT_MISMATCH` reason, not only as a thrown error.
- The per-turn NDJSON carries a structured freshness/mismatch field when a stale plan is rejected.
- On enforced paths, a `undefined` identity no longer auto-passes `assertFresh`; the change does not break replay of pre-contract logs.
- Existing happy-path bot turns pass unchanged.

## Not in scope

- Adding freshness checks at the remaining execution boundaries (**JIRA-278**) — this ticket makes mismatch guardrail-owned and enforced; JIRA-278 widens *where* it is checked.
- End-game re-verification (**JIRA-279**).
- Rewriting `GuardrailEnforcer`'s other gates.

## Relationship to existing JIRAs

- **Completes the enforcement/observability half of JIRA-277.** JIRA-277 proved the contract is real at one boundary by throwing; this makes mismatch a guardrail rejection, gives it postmortem visibility, and removes the opt-in escape hatch.
- **Depends on JIRA-278 / JIRA-279** stamping identity on their boundaries before the escape hatch can be fully closed on those paths.
