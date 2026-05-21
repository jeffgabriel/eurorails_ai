# JIRA-168 — Remove JIRA-165 oscillation detection guardrail (activeRoute nullification)

## Symptom

In game `ed4f7b5e-c488-49c1-9f58-144576e6609a`, Haiku's active route (`Oil Beograd→Zurich`, currentStopIndex=1, Oil already on the train) was cleared at the start of T11 by the JIRA-165 oscillation detection guard. This dropped the bot into the LLM trip-planner path, which returned a garbage plan (hallucinated same-city pickup/deliver of Oil@Zurich), crashed the downstream pipeline, and caused a three-turn death spiral of `PassTurn` pipeline-errors (T11, T12, T13).

The bot was NOT stuck — it was carrying Oil and actively moving toward Zurich for delivery. The guardrail misidentified a productive mid-haul state as oscillation.

## Root cause

`src/server/services/ai/AIStrategyEngine.ts:267-278`:

```ts
// ── JIRA-165 Fix 3: Oscillation detection — abandon stuck routes at $0 ──
if (activeRoute && (memory.noProgressTurns ?? 0) >= 3 && snapshot.bot.money < 5) {
  console.warn(
    `${tag} JIRA-165: Abandoning stuck route after ${memory.noProgressTurns} no-progress turns ` +
    `at $${snapshot.bot.money}M — forcing LLM replan`,
  );
  activeRoute = null;
}
```

The guard fires when:
1. An active route exists
2. `noProgressTurns >= 3` (counted by turns without a delivery)
3. `money < 5`

This is dangerously underspecified. Any bot on a multi-turn haul (e.g., Beograd→Zurich = ~4-5 move turns) with low starting cash will hit `noProgressTurns >= 3` AND `money < 5` during perfectly productive execution. The guard has no concept of "making progress toward delivery" — it only knows "has delivered or hasn't."

## Decision: remove entirely

The guardrail causes more harm than the problem it was designed to solve. When it fires on a bot that IS making progress:

1. The valid active route is destroyed.
2. The LLM is called unnecessarily (5-6 calls per attempt).
3. The LLM returns garbage plans (hallucinated pickup cities, same-city pickup/deliver).
4. Downstream pipeline crashes on the invalid LLM output.
5. Error handler emits PassTurn, discards the LLM work.
6. Next turn: same state → same crash → death spiral until something breaks the cycle.

The original JIRA-165 intent (break out of truly stuck routes) should be revisited separately with a better heuristic — e.g., detecting that the bot's position hasn't changed for N turns, or that the train has been oscillating between the same two mileposts. That's a future ticket, not a patch on this guard.

## Fix

Remove the entire JIRA-165 Fix 3 block (lines 267-278 of `AIStrategyEngine.ts`).

## Acceptance criteria

- The JIRA-165 oscillation detection code block is removed from `AIStrategyEngine.ts`.
- A bot carrying a load mid-delivery is never forced into an LLM replan by this path.
- Existing tests pass (any tests asserting the oscillation guard behavior should be removed or updated).
- Game replay of `ed4f7b5e` scenario: Haiku continues executing the Oil→Zurich delivery through T11+ without route clearing.

## Related

- **JIRA-167**: InitialBuildPlanner runs twice during initial-build phase (contributes orphaned track that wastes early turns).
- **JIRA-165**: Original ticket that introduced this guardrail. Fix 1 (capital allocation gate) and Fix 2 remain; only Fix 3 (oscillation detection) is removed.
