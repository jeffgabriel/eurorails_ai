# JIRA-268 — Medium-skill bots make `claude-sonnet-4-6` LLM calls via `RouteEnrichmentAdvisor` despite the JIRA-220 contract that Medium is deterministic; the brain-construction predicate `AIStrategyEngine.hasLLMApiKey` checks only `ANTHROPIC_API_KEY` and has no skill-level check, so `brain` is non-null for Medium whenever the env key is set, and `MovementPhasePlanner.maybeFireAdvisor`'s gate (`if (!brain || !gridPoints) return route;`) does not short-circuit on skill, so the advisor fires after pickup/drop/delivery (behavioral)

JIRA-220 made trip planning fully deterministic for Medium skill — `TripPlanner.planTrip` at `src/server/services/ai/TripPlanner.ts:219` dispatches to `planTripDeterministic` and never reaches the LLM path below for `skillLevel === Medium`. That fix correctly removed LLM cost from the *primary* planning path. It did not address downstream advisor call sites that take `brain` as a parameter and gate purely on brain presence, not on skill.

`RouteEnrichmentAdvisor.enrich` is one such site. It fires from `MovementPhasePlanner.maybeFireAdvisor` after each pickup / drop / delivery action when the bot is at a city offering additional loads, and issues a `claude-sonnet-4-6` call (the default model for Medium per `LLM_DEFAULT_MODELS` in `GameTypes.ts`) to decide whether to splice a drive-by pickup into the route. Per-call latency observed at 8.6–15.7 seconds.

## Source

LLM transcript NDJSON files in `logs/`:

- `logs/llm-46e424ad-9090-4d6f-ab44-918b1fdf70d7.ndjson` — 17 calls, all `caller: "route-enrichment-advisor"`, all `model: "claude-sonnet-4-6"`, latencies 10s–15s.
- `logs/llm-53e833e8-85c6-4e3a-8556-1826f204841d.ndjson` — 11 calls, same caller/model.
- `logs/llm-29c0255f-1374-4304-a003-8f2dfc4ed257.ndjson` — 3 calls, same.
- `logs/llm-92c1feac-5dd9-42e0-b3a4-bf0192d74933.ndjson` — 3 calls, same.
- `logs/llm-086fa2ce-a6c9-4a88-b91a-9653fc7fdcf9.ndjson` — 5 calls, same.

Each call's `playerName` field (`s1`, `s2`, `s3`) corresponds to Medium-skill bots in the user's normal 1-human-vs-3-Medium-bots autorun configuration. Bot configs do not override `provider` or `model`, so the LLM defaults resolve to Anthropic / sonnet-4-6 for Medium.

Discovered 2026-05-26 while investigating why the bot-vs-bot harness takes ~3 hours per game vs. ~30 minutes for autorun. The harness slowdown turned out to be a different issue (not yet diagnosed), but the LLM-leak finding was incidentally confirmed: Medium *does* call Sonnet whenever `ANTHROPIC_API_KEY` is set in the env.

## Plain-English walkthrough of the current gate chain

When `AIStrategyEngine.takeTurn` runs for a bot:

1. `AIStrategyEngine.ts:297` constructs `brain`:
   ```ts
   const brain = AIStrategyEngine.hasLLMApiKey(botConfig)
     ? AIStrategyEngine.createBrain(botConfig!)
     : null;
   ```
2. `AIStrategyEngine.ts:1511-1519` (`hasLLMApiKey`):
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
   This checks only `process.env.ANTHROPIC_API_KEY` (or `ANTHROPIC_USE_CLAUDE_CODE`). It does not look at `botConfig.skillLevel` at any point.
3. With env key set, `hasLLMApiKey` returns `true` for **any** skill, including Medium. `brain` is non-null.
4. `brain` is passed down through `TurnExecutorPlanner.run` → `MovementPhasePlanner.run` (`brain?: LLMStrategyBrain | null` param, line 88) → `MovementPhasePlanner.maybeFireAdvisor` (line 748).
5. `MovementPhasePlanner.ts:753` gate:
   ```ts
   if (!brain || !gridPoints || gridPoints.length === 0) return route;
   ```
   Skill is not checked. Brain non-null + grid loaded → gate passes.
6. After the 5-condition pre-filter (lines 757–817: same-city next-stop check, load availability, demand-supply match, no duplicate-deliver, free cargo slot, build cost ≤ cash, detour turns ≤ MAX_DETOUR_TURNS) passes for at least one candidate, `MovementPhasePlanner.ts:821` invokes `RouteEnrichmentAdvisor.enrich(route, snapshot, context, brain, gridPoints, currentCity, viableCandidates)`.
7. `RouteEnrichmentAdvisor.attemptEnrich` issues a Sonnet call via `brain.providerAdapter.chat({...})` with the model resolved at `LLMStrategyBrain.ts:103`:
   ```ts
   this.model = config.model ?? LLM_DEFAULT_MODELS[config.provider][config.skillLevel];
   // → LLM_DEFAULT_MODELS[Anthropic][Medium] = 'claude-sonnet-4-6'
   ```

The advisor returns either `decision: "keep"` (most common, ~13 of 17 calls in game 46e424ad) or `decision: "insert"` with one or more new DELIVER stops to splice in. The route mutation works correctly when it fires — the bug is purely that this LLM call should not be happening for Medium at all.

## Why this fires for Medium — root cause

The brain-construction predicate `hasLLMApiKey` answers "can we *afford* an LLM call (credentials present)?", not "*should* this bot use an LLM (skill says LLM-augmented)?". These were the same question pre-JIRA-220 because every skill level used LLMs and only credential availability gated. Post-JIRA-220, Medium is the first skill level for which the two questions diverge — Medium has credentials available but should not use them. The predicate was not updated to reflect that divergence.

Every downstream advisor written or refactored after JIRA-220 inherits the same gap: as long as it gates only on `brain != null`, it will fire for Medium whenever the env key is set. `RouteEnrichmentAdvisor` is the one observed in the logs; the same pattern would silently capture any future advisor added under the same convention.

## Observed trace — game 46e424ad, player s1 (Medium), T4

Single call example from `logs/llm-46e424ad-9090-4d6f-ab44-918b1fdf70d7.ndjson` line 1:

```json
{
  "callId": "7e187905-0bb0-40ed-831c-87cd04bc07ee",
  "playerName": "s1",
  "turn": 4,
  "caller": "route-enrichment-advisor",
  "method": "enrich",
  "model": "claude-sonnet-4-6",
  "userPrompt": "Bot is currently at: Budapest\nTrain state: carrying [Bauxite], 1 slot(s) free (capacity=2)\nMoney: ECU 29M\n\nRemaining route stops:\n  0: DELIVER Bauxite at Munchen (ECU 14M)\n\nAdditional loads available here:\n  - Bauxite → Bremen | payout=22M | marginalBuild=19M | marginalTurns=3 | bestSlotIndex=2\n\nShould this route be modified to capture a drive-by pickup? Respond with JSON only.",
  "responseText": "{ \"decision\": \"keep\", ... }",
  "status": "success",
  "latencyMs": 10378
}
```

Bot is Medium-skill (s1 = first Medium slot in the user's autorun layout). Single LLM call adds 10.4s of wall-clock to T4 that the deterministic pipeline does not need.

## What should happen

When `skillLevel === BotSkillLevel.Medium`:

1. No `RouteEnrichmentAdvisor` call.
2. No `BuildAdvisor` call (already env-gated off by default — not a regression risk, but the skill policy should be the gate rather than relying on an unrelated env flag).
3. No `PostDeliveryReplanner` LLM call (already correct — `TripPlanner.planTrip` short-circuits Medium to the deterministic path internally; `brain` is passed but never used by the brain-consuming code path).
4. No advisor added in the future that gates only on `brain != null` should fire for Medium without explicit per-advisor approval.

Concretely: the `LLM_DEFAULT_MODELS[Anthropic][Medium]` entry (currently `claude-sonnet-4-6`) should be unreachable from the bot-turn pipeline. If it appears in `llm-<gameId>.ndjson` for a Medium-skill game, that is a regression.

Easy and Hard behavior unchanged — both should continue to use the LLM whenever `ANTHROPIC_API_KEY` is present.

## Not in scope (single root cause)

This ticket is one architectural defect with one observable symptom (RouteEnrichmentAdvisor calls in Medium games). Per repo convention, no scope creep:

- Not adding new advisors, scoring penalties, or strategy changes to Medium.
- Not addressing the harness 3-hour-per-game timing issue. That has a different root cause and lives in a separate ticket.
- Not addressing the `BOT_TURN_DELAY_MS = 1500` per-turn sleep at `BotTurnTrigger.ts:55`. Separate concern.
- Not gating `ENABLE_BUILD_ADVISOR` on skill. BuildAdvisor is already off by default; the env gate is unrelated to the skill policy and changing it is out of scope.
- Not refactoring `LobbyService.addBot` defaults. The bug is downstream of bot creation.
