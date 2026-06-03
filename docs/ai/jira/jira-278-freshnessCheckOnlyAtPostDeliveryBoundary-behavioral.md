# JIRA-278 — The turn-snapshot freshness check guards only the post-delivery replan boundary; build, movement, pickup, and delivery execution still mutate game state without validating against the decision-time identity (behavioral)

Follow-up slice to **JIRA-277** (Fresh Turn Snapshot Contract). The first slice added exactly one fail-closed freshness check — `PostDeliveryReplanner.assertFresh` / `withFreshnessCheck` — at the post-delivery replan boundary, because that is where the stale carried-load evidence (JIRA-263) was strongest. Every other execution boundary in `TurnExecutor` still mutates game state with **no** freshness validation.

The identity is kept *live* at those boundaries (each in-place mutation calls `computeIdentity()` to re-mint `snapshot.identity`), but re-minting is not validating: nothing compares the identity the plan was *derived from* against the live identity before applying a build, move, pickup, or delivery. So a multi-action plan whose later steps were chosen against facts that an earlier step (or a card draw) changed can still mutate money, position, or loads without the contract firing.

## Source

- `.valence-refactor/PROPOSAL.md` — *"Plan Execution checks the snapshot before applying build, movement, pickup, or delivery actions."* This ticket completes that goal beyond the single post-delivery boundary shipped in JIRA-277.
- `.valence-refactor/IMPLEMENTATION-BRIDGE.md` — the execution mutation points named as *"the places most likely to need a named freshness rule."*

## What's wrong

The `TurnExecutor` mutation points re-mint but do not validate:

- `TurnExecutor.ts:646` — re-mint after `bot.money` change (`executeMultiAction`)
- `TurnExecutor.ts:800` — re-mint after `bot.position` change (`MoveTrain`)
- `TurnExecutor.ts:935` — re-mint after `bot.loads` change (pickup / deliver / drop)
- `TurnExecutor.ts:352, 374` — re-mint on the named-refresh path

Each writes a fresh `snapshot.identity`. None calls `assertFresh(derivedFromIdentity, liveIdentity)` before the mutation it guards. The only consumer of `assertFresh` in source is `PostDeliveryReplanner` (`PostDeliveryReplanner.ts:317–513`).

## Expected behavior

Generalize the JIRA-277 pattern: each game-changing execution step records the snapshot identity its plan was derived from and validates it against the live identity **before** mutating state, failing closed with the existing product-language `SNAPSHOT_MISMATCH` reason on mismatch — same fail-closed contract `PostDeliveryReplanner` already honors. Where an action legitimately needs newer facts (a deliberate refresh rather than a stale apply), it must request a **named** refresh, not silently re-mint and proceed.

## Acceptance

- Build, movement, pickup, and delivery execution steps in `TurnExecutor` each carry a `derivedFromIdentity` and run an `assertFresh`-equivalent check before mutating game state.
- A multi-action plan whose later step was chosen against facts an earlier in-turn mutation changed fails closed with `SNAPSHOT_MISMATCH` instead of applying the stale step.
- The distinction between "re-mint to keep identity live" and "validate before mutate" is explicit at each boundary — re-minting alone no longer stands in for a freshness check.
- Existing happy-path bot turns pass unchanged; legacy snapshots without identity continue to no-op the check (escape hatch closure is JIRA-280, not here).

## Not in scope

- Closing the `undefined`-identity escape hatch / end-to-end enforcement (**JIRA-280**).
- End-game victory-sprint re-verification (**JIRA-279**).
- Changing what any action does when fresh — only adding the freshness gate.

## Relationship to existing JIRAs

- **Extends JIRA-277.** Same contract and `SNAPSHOT_MISMATCH` constant; widens coverage from one boundary to all `TurnExecutor` execution boundaries.
- **Pairs with JIRA-280**, which makes mismatch a guardrail-owned rejection and removes the optional-identity escape hatch so these new checks actually fire on every turn rather than no-op on `undefined`.
