# JIRA-191: Bot Wastes Movement When the Next Pickup Is Off-Network

**Status:** SPEC — awaiting review.
**Related:** supersedes the "A3 frontier-move" portion of JIRA-115, JIRA-155, JIRA-171, JIRA-176.

## Why

Game `1c2dadeb-1177-4f32-8b8c-c042bff5ba6f`, turn 5. The bot (`nano`) delivers cars to Antwerpen, picks up a new route targeting wine in Frankfurt, and stops. 2 of its 9 movement points go unused.

A human in the same seat would walk those 2 mileposts along existing track toward Frankfurt — even though Frankfurt itself isn't connected yet — so the bot is closer to the eventual pickup once the track gets extended next turn.

We've written this fix six times already (JIRA-115, 155, 156, 162, 171, 176). Each time we added another filter or guard to the same block. The block keeps finding new ways to produce "no move" for a bot that clearly should move.

## What's wrong with the current logic

Inside `TurnExecutorPlanner`'s movement loop there's a block called "A3 frontier move" that fires when the next route stop is off-network and the bot still has movement budget. Today it:

1. Finds all **dead-end** nodes on the bot's existing track (degree-1 endpoints only).
2. Sorts them by distance to the build target.
3. Throws away any dead-end that isn't strictly closer to the build target than the bot's current position (the "directional guard" from JIRA-171).
4. Tries to move to the first surviving dead-end.
5. If the list is empty, gives up and ends the movement phase.

For the nano scenario, the only dead-ends on the bot's track are Antwerpen (the bot's current position — filtered by step 3) and the original pickup city, which is farther from Frankfurt than Antwerpen (filtered by step 3). Result: empty list, no move, turn ends with 2 unused mileposts.

The root cause isn't any individual guard. It's that the heuristic A3 uses to pick where to move is **different from** the logic Phase B later uses to decide where to build. They can — and often do — disagree. When A3's answer is "nowhere useful" but Phase B's answer is "build from somewhere specific on your existing track," the bot should have walked toward that somewhere.

## What we want to change

Stop inventing an A3-specific heuristic. Instead, let A3 peek at the answer Phase B is about to compute, and walk toward it now.

Concretely:

1. When the next route stop is off-network, ask the build planner (`computeBuildSegments`, a deterministic Dijkstra that's already in the codebase) where it would start building to reach that stop.
2. The first segment of that build plan starts at a node on the bot's existing track — the "build origin."
3. Move the bot toward that build origin using the same `resolveMove` call A3 already uses. If the origin is farther than the bot's remaining budget, `resolveMove` already truncates the path at the budget, so the bot lands on an internal milepost along the way — which is exactly where we want it.
4. If the build planner can't find a path at all (target genuinely unreachable under this turn's budget), fall straight through to Phase B as today. If the origin equals the bot's current position, no-op.

That's the entire change. No new directional guard, no new frontier semantics, no new internal-node search. We're replacing a heuristic that guesses at Phase B's intent with a call that asks Phase B directly.

## How we'll know it worked

- Replaying turn 5 of game `1c2dadeb-1177-4f32-8b8c-c042bff5ba6f` (or a unit test synthesized from it) shows the bot consuming all 9 mileposts instead of 7. At least 2 of those mileposts are spent moving along existing track toward the Frankfurt build frontier.
- The previously fixed cases from JIRA-115/155/156/162/171/176 still behave correctly — those tests stay green.
- On a small sample of full games, average movement utilization per turn goes up; deliveries per 100 turns does not regress.

## Risks to think about before approving

- **Extra Dijkstra call per A3 invocation.** `computeBuildSegments` runs a multi-source Dijkstra over the map grid. It's already run once per turn in Phase B; A3 would run it a second time. If that matters for turn time, we can cache the result within the turn. Worth measuring before optimizing.
- **A3 and Phase B disagreeing later.** Phase B's actual build target can be influenced by BuildAdvisor (LLM) and solvency retries. If the LLM overrides Phase B's deterministic choice after A3 has already moved, the bot may have walked toward the wrong origin. The movement would still be roughly toward the target, so it's unlikely to be wasted — but the spec should call out this coupling so the implementing agent doesn't try to "fix" the disagreement elsewhere.
- **Victory-build override path.** When the bot qualifies for a victory build, `resolveBuildTarget` points at the cheapest unconnected major city, not at a route stop. A3 should use the same target `resolveBuildTarget` returns, so this path should work automatically — but verify with a test.
- **Ferry-port truncation.** `resolveMove` already truncates paths at ferry ports (bot must stop one turn before crossing). If the build origin is across a ferry, A3 will stop at the port this turn. This is correct, but worth an explicit test case.

## Out of scope

- **Rewriting Phase B or BuildAdvisor.** This ticket only changes A3. If Phase B's build-origin selection is itself suboptimal, that's a separate ticket.
- **Removing the old frontier/directional-guard helpers.** `getNetworkFrontier` is still used by other callers. Leave it alone.
- **Changing movement-budget accounting.** `computeEffectivePathLength` stays as-is.

## Related

- JIRA-115 — original A3 frontier approach.
- JIRA-155 — widened guards after pickup/deliver.
- JIRA-156 BE-003 — unified `getNetworkFrontier`.
- JIRA-162 — directional BFS on `calculateTrackRunway`.
- JIRA-171 — the directional guard this ticket effectively replaces.
- JIRA-176 — allowed unnamed milepost frontiers.
