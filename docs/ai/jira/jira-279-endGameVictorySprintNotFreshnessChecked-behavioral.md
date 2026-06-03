# JIRA-279 — End-game victory-sprint routing mutates game state without re-verifying the same board and demand facts it was planned against, and still reaches into live context for state instead of the turn snapshot (behavioral)

Follow-up slice to **JIRA-277** (Fresh Turn Snapshot Contract). The end-game routing path (`findFinalVictoryOutcome` / `findFinalVictoryRoute` in `victoryRules.ts`) proposes a victory sprint — a route intended to connect the seventh city and/or complete the cash condition — and that sprint can change route/build/delivery state without proving the board and demand facts still match the picture it was planned against. End-Game Routing also still reaches into the live context machinery for state rather than reading from the agreed turn snapshot, which is the shared-state reach the refactor set out to resolve.

## Source

- `.valence-refactor/PROPOSAL.md` — proposed change #4: *"Resolve the End-Game Routing shared-state reach into Context Builder,"* and the stress test: *"End-game routing proposes a victory sprint; execution must verify the same board and demand facts before changing state."*
- `.valence-refactor/IMPLEMENTATION-BRIDGE.md` test map: *"End-game JIRA-261/266/267 coverage: victory sprint re-verifies the same board and demand facts before mutating game state."*

## What's wrong

- The victory-sprint decision is computed from end-game facts (cities-on-network, carried loads, demand cards, cash) but the resulting state mutation is not gated by a freshness check against the snapshot identity those facts came from. A sprint chosen at decision time can be applied after a mid-turn change.
- End-Game Routing reads live state from context assembly rather than from the frozen turn snapshot — the exact "shared-state reach into Context Builder" the proposal flagged. This is also the source of prior end-game defects (JIRA-261 route commits before victory gate; JIRA-266 victory-build trigger gated on cash not end-game latch; JIRA-267 carry-turn estimate / `isLoadOnTrain` multiplicity).

## Expected behavior

- Before the victory sprint mutates route/build/delivery state, it re-verifies the same board and demand facts against the snapshot identity it was planned from, failing closed with `SNAPSHOT_MISMATCH` (the JIRA-277 contract) on mismatch.
- End-Game Routing reads decision-critical state from the turn snapshot, not by reaching back into live context — passing clearer intent forward and removing the shared-state reach.

## Acceptance

- The end-game victory-sprint path records the snapshot identity it was planned against and validates it before mutating game state.
- A victory sprint planned at decision time fails closed if board/demand facts changed before it is applied, rather than committing a sprint against a different game picture.
- End-Game Routing no longer reads live state from Context Builder for the facts now carried by the snapshot; the JIRA-261/266/267 regression coverage still passes.
- No change to victory economics or the win condition itself.

## Not in scope

- The generalized build/movement/pickup/delivery boundary checks (**JIRA-278**).
- Guardrail-owned mismatch rejection / escape-hatch closure (**JIRA-280**).
- Re-litigating the JIRA-261/266/267 fixes — this ticket only routes their facts through the snapshot and adds the pre-mutation re-verification.

## Relationship to existing JIRAs

- **Extends JIRA-277** to the end-game routing boundary.
- **Builds on JIRA-261 / 266 / 267** — those fixed specific end-game scoring/gating bugs; this removes the live-state reach that made them possible and adds the freshness re-verification the bridge's test map calls for.
