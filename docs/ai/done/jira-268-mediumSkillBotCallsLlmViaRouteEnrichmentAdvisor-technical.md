# JIRA-268 — Add `BotSkillLevel.Medium` short-circuit to `AIStrategyEngine.hasLLMApiKey` so `brain` is null for Medium and every downstream advisor `brain != null` gate enforces the JIRA-220 "Medium is deterministic" contract policy-side (technical)

Companion to `jira-268-mediumSkillBotCallsLlmViaRouteEnrichmentAdvisor-behavioral.md`.

One architectural fix at the single brain-construction predicate. No per-advisor gate, no env flag, no signature propagation. The policy "Medium uses no LLM" is enforced where the policy decision belongs — at the boundary where credentials would otherwise be resolved into an `LLMStrategyBrain` instance.

## The fix — skill-level early-return at `hasLLMApiKey`

**Defect locus.** `src/server/services/ai/AIStrategyEngine.ts:1511-1519` (the `hasLLMApiKey` predicate).

Current code:

```ts
private static hasLLMApiKey(botConfig: BotConfig | null): boolean {
  if (!botConfig) return false;
  const provider = (botConfig.provider as LLMProvider) ?? LLMProvider.Anthropic;
  if (provider === LLMProvider.Anthropic) {
    return AIStrategyEngine.resolveAnthropicCredential() !== null;
  }
  const envKey = AIStrategyEngine.ENV_KEY_MAP[provider];
  return !!process.env[envKey];
}
```

Fix:

```ts
private static hasLLMApiKey(botConfig: BotConfig | null): boolean {
  if (!botConfig) return false;
  // JIRA-220 / JIRA-268: Medium skill is fully deterministic; never construct
  // an LLM brain regardless of credential availability. Predicate name is kept
  // for caller compatibility — semantically it now answers "should this bot
  // use an LLM brain?" rather than "is a credential present?".
  if (botConfig.skillLevel === BotSkillLevel.Medium) return false;
  const provider = (botConfig.provider as LLMProvider) ?? LLMProvider.Anthropic;
  if (provider === LLMProvider.Anthropic) {
    return AIStrategyEngine.resolveAnthropicCredential() !== null;
  }
  const envKey = AIStrategyEngine.ENV_KEY_MAP[provider];
  return !!process.env[envKey];
}
```

**Effect.** For `skillLevel === Medium`, `hasLLMApiKey` returns false unconditionally. At `AIStrategyEngine.ts:297`:

```ts
const brain = AIStrategyEngine.hasLLMApiKey(botConfig)
  ? AIStrategyEngine.createBrain(botConfig!)
  : null;
```

`brain` becomes `null` for Medium. Every downstream gate of the form `if (!brain) return ...` short-circuits. This covers:

- `MovementPhasePlanner.ts:753` (`maybeFireAdvisor` — RouteEnrichmentAdvisor entry).
- `TurnExecutorPlanner.ts:410` (BuildAdvisor — already env-gated off by default; this is belt-and-suspenders).
- Any future advisor adopting the `brain != null` convention.

`TripPlanner.planTrip` (called from `AIStrategyEngine` and `PostDeliveryReplanner`) is unaffected: its Medium-skill dispatch at `TripPlanner.ts:219` does not depend on `brain` and was already deterministic. The `brain` parameter passed to `TripPlanner` for Medium is now `null`; the deterministic branch never reads it.

## Why this location and not the alternatives

A prior draft of this ticket proposed a 2-line gate inside `MovementPhasePlanner.maybeFireAdvisor` (checking `brain.strategyConfig.skillLevel === Medium` before the advisor call). That fix was reverted because it plugged the one observed leak without preventing the next one — any new advisor added under the same `brain != null` convention would re-introduce the bug. The architectural defect is that `hasLLMApiKey` answers the wrong question; fix it once at the boundary and every advisor inherits the correct behavior.

Two adjacent alternatives were considered and rejected:

- **Gate at `AIStrategyEngine.ts:297` directly** (`const brain = (skillLevel !== Medium && hasLLMApiKey(botConfig)) ? ... : null;`). Works, but spreads the policy across two locations — the construction site and `hasLLMApiKey`. If someone reads `hasLLMApiKey` in isolation later, the policy is invisible. Keeping the gate inside the predicate makes the policy local to its single use.
- **Rename `hasLLMApiKey` to `shouldHaveLLMBrain`.** Semantically cleaner but a wider refactor than the bug warrants. The predicate has only one caller (line 297). The inline comment in the proposed fix documents the semantic shift; a rename can follow as a separate cleanup if the predicate gains more callers.

## Acceptance criteria

- **AC1 (unit, Medium with key)** Call `AIStrategyEngine['hasLLMApiKey']({ skillLevel: BotSkillLevel.Medium, name: 'test' })` with `process.env.ANTHROPIC_API_KEY = 'sk-test'`. Assert `false`.
- **AC2 (unit, Easy with key)** Same call with `skillLevel: BotSkillLevel.Easy`. Assert `true`. Verifies no Easy regression.
- **AC3 (unit, Hard with key)** Same call with `skillLevel: BotSkillLevel.Hard`. Assert `true`. Verifies no Hard regression.
- **AC4 (unit, Medium without key)** Same call with `skillLevel: BotSkillLevel.Medium` and `ANTHROPIC_API_KEY` unset. Assert `false`. Verifies the existing "no credentials → no brain" path is preserved for Medium.
- **AC5 (unit, no botConfig)** `hasLLMApiKey(null)` returns `false`. Existing behavior preserved (the early `if (!botConfig) return false;` runs before the skill check).
- **AC6 (integration, brain is null for Medium)** Construct a Medium-skill `botConfig` and call `AIStrategyEngine.takeTurn` with `ANTHROPIC_API_KEY` set in the test env. Stub `LoggingProviderAdapter.chat` to throw if invoked. Assert `takeTurn` completes without the stub throwing — i.e., no provider call attempted.
- **AC7 (integration, advisor short-circuits)** Same setup as AC6, plus construct a snapshot where the bot is at a city with a viable drive-by pickup candidate that would pass all 5 of `maybeFireAdvisor`'s pre-filter conditions. Assert the returned route is unchanged (advisor did not run).
- **AC8 (replay, no LLM transcript entries)** Run a 50-turn all-Medium harness game with `ANTHROPIC_API_KEY` set. Assert `logs/llm-<gameId>.ndjson` is empty or absent. Currently this file contains ~5–20 `caller: "route-enrichment-advisor"` entries per Medium game.

## Files touched

- `src/server/services/ai/AIStrategyEngine.ts` — single skill-level early-return inside `hasLLMApiKey` (and the `BotSkillLevel` import, if not already present in that file).
- `src/server/__tests__/ai/AIStrategyEngine.test.ts` (or equivalent existing test file) — AC1–AC5 unit tests.
- `src/server/__tests__/ai/MovementPhasePlanner.test.ts` (or equivalent) — AC6, AC7 integration tests.
- Possibly a new `src/server/__tests__/ai/jira268MediumNoLlm.test.ts` if AC6/AC7 don't fit cleanly into existing files.

## Not in scope

- Refactoring `LLMStrategyBrain` construction or the per-skill default-model map (`LLM_DEFAULT_MODELS`). The entry `LLM_DEFAULT_MODELS[Anthropic][Medium] = 'claude-sonnet-4-6'` becomes unreachable from the bot pipeline after this fix, but is intentionally left in place — removing it would force callers that explicitly pass `BotSkillLevel.Medium` into a constructor (e.g., tests, future tooling) to set the model manually. Leaving the default avoids that paper cut.
- Renaming `hasLLMApiKey` to `shouldHaveLLMBrain` (see "Why this location" above).
- Gating `BuildAdvisor` separately on skill. After this fix, `brain` is null for Medium and the existing `brain != null` check at `TurnExecutorPlanner.ts:410` short-circuits BuildAdvisor too. The `isBuildAdvisorEnabled()` env flag remains as an orthogonal kill switch.
- The harness 3-hour-per-game slowdown. The LLM-leak finding was incidental to that investigation; the harness slowness has a separate (undiagnosed) root cause and gets its own ticket.
- `BOT_TURN_DELAY_MS` constant at `BotTurnTrigger.ts:55`. Pacing concern, not LLM-policy concern.
- Easy and Hard skill behavior. Both retain LLM calls as today.

## Cross-references

- **JIRA-220** — `TripPlanner.planTrip` Medium-skill deterministic dispatch. That fix established the "Medium = deterministic" contract for the primary planning path; this ticket extends the same contract to the advisor sub-paths that were missed.
- **JIRA-214 Project 2** — `RouteEnrichmentAdvisor` introduction. The advisor's `brain != null` gate at `MovementPhasePlanner.ts:753` was correct at the time (pre-JIRA-220, all skills used LLM); it became insufficient when JIRA-220 split Medium off from the LLM-using skills.
- **JIRA-129** — `BuildAdvisor` introduction. Same observation: env-gated AND `brain != null` gated, both unaware of skill.
