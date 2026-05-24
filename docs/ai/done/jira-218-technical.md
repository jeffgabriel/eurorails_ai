# JIRA-218 — Technical: Agent SDK inherits `process.env.ANTHROPIC_API_KEY` and bills API credits

> Behavioral symptom: `jira-218-behavioral.md`. Read that first.

## Root cause

`@anthropic-ai/claude-agent-sdk` (v0.2.126 / build `e44c1d97`) spawns a child `claude` Code subprocess. The `query()` call's `options.env` field controls the subprocess's environment, and per the SDK type definition:

```
node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1220-1234

/**
 * Environment variables to pass to the Claude Code process.
 * Defaults to `process.env`.
 * ...
 */
env?: { [envVar: string]: string | undefined };
```

When `env` is omitted (which our adapter does), the spawned subprocess inherits the parent's full `process.env` — including `ANTHROPIC_API_KEY`. The child `claude` Code binary, on seeing `ANTHROPIC_API_KEY` in its env, prefers it as the auth credential and routes calls through the API-billing path rather than the OAuth/subscription path. The user's `~/.claude/.credentials.json` is ignored in that case.

Our adapter at `src/server/services/ai/providers/ClaudeAgentSdkAdapter.ts:66-75` calls:

```ts
const stream = query({
  prompt: combinedPrompt,
  options: {
    model: request.model,
    tools: [],
    allowedTools: [],
    abortController,
  },
});
```

There is no `env` override. The SDK therefore inherits `process.env`, the subprocess sees `ANTHROPIC_API_KEY`, and bills the API account.

## Why the spec missed this

The spec's Mock Fidelity guard (B5 in `master-spec.md`) flagged that the implementing agent should verify the SDK's `query()` signature against the actual installed SDK before coding. That verification was performed for `prompt`, `model`, `allowedTools`, and `abortController`. The `env` option was not enumerated as a Mock Fidelity item because the spec assumed the SDK's auth precedence would prefer the OAuth credential file over `ANTHROPIC_API_KEY`. The actual precedence is the reverse — and is determined by what the spawned `claude` binary does with its inherited env, not by anything our adapter sees directly.

This is the kind of subtle integration boundary that doesn't show up in unit tests where the SDK is mocked: every test in `ClaudeAgentSdkAdapter.test.ts` mocks `query()` with controlled async iterators, so the auth-inheritance pathway never executes.

## Why the integration verification (AC10) didn't catch it either

AC10 instructed the developer to manually run a turn with the env var set and confirm `credential_mode=subscription` in the log. Both halves of that check passed, because the log line is emitted from `LLMStrategyBrain` constructor based purely on the resolver's return value — it does NOT verify that the actual outbound request was billed against the subscription. The check was checking adapter-selection, not actual auth path.

## Fix plan

Make the adapter pass an explicit `env` to `query()` that omits `ANTHROPIC_API_KEY` (and `ANTHROPIC_AUTH_TOKEN` for symmetry, even though that var is no longer used by our code, in case some other process sets it).

### Code change

In `src/server/services/ai/providers/ClaudeAgentSdkAdapter.ts`, build the env override once and pass it to every `query()` call:

```ts
// Inside chat(), before the query() call:
const subprocessEnv = { ...process.env };
delete subprocessEnv.ANTHROPIC_API_KEY;
delete subprocessEnv.ANTHROPIC_AUTH_TOKEN;

const stream = query({
  prompt: combinedPrompt,
  options: {
    model: request.model,
    tools: [],
    allowedTools: [],
    abortController,
    env: subprocessEnv,
  },
});
```

The `subprocessEnv` build can be lifted out of the `chat()` body to module scope or computed lazily at first use, but the simple per-call construction is fine — it's one small object spread per LLM call, which already costs hundreds of milliseconds of network time.

### Constructor-time guard

Add one defensive log at construction time when both env vars are present, so this class of confusion is visible in logs the next time it happens to anyone:

```ts
// In ClaudeAgentSdkAdapter constructor, after the existing log line:
if (process.env.ANTHROPIC_API_KEY) {
  console.warn(
    '[ClaudeAgentSdkAdapter] ANTHROPIC_API_KEY is set in process.env. ' +
    'It will be REMOVED from the spawned Claude Code subprocess env to force ' +
    'subscription auth. Subscription billing only.',
  );
}
```

### Tests

Add to `src/server/__tests__/ai/providers/ClaudeAgentSdkAdapter.test.ts`:

1. **`chat()` passes options.env without ANTHROPIC_API_KEY**: Set `process.env.ANTHROPIC_API_KEY = 'sk-test-leakage'`, mock `query()` to capture its argument, call `chat()`, assert the captured argument's `options.env` does NOT contain `ANTHROPIC_API_KEY` (`expect(capturedArgs.options.env).not.toHaveProperty('ANTHROPIC_API_KEY')`). Restore env after.
2. **`chat()` passes options.env without ANTHROPIC_AUTH_TOKEN**: Same pattern with the legacy bearer var.
3. **`chat()` preserves other env vars**: Set a sentinel like `process.env.SOME_OTHER_VAR = 'preserved'`, assert it appears in `options.env` after the call. This guards against a future "reset env to {}" regression that would break PATH lookups, HOME, etc., and prevent the spawned binary from finding `~/.claude/.credentials.json`.
4. **Constructor warns when ANTHROPIC_API_KEY is set**: Set the env var, spy on `console.warn`, instantiate the adapter, assert the warn fires once with the expected message.
5. **Constructor does NOT warn when ANTHROPIC_API_KEY is unset**: Inverse case.

The existing 22 unit tests should remain green — none of them assert anything about `options.env` today.

### Manual verification (must repeat AC10 pattern)

The original AC10 was insufficient because it only checked adapter selection, not billing. Replace it with:

1. Set `ANTHROPIC_USE_CLAUDE_CODE=1`, ensure `ANTHROPIC_API_KEY` is also set in `.env` (this is the explicit reproduction condition).
2. Note your current Anthropic API credit balance from console.anthropic.com.
3. Restart `npm run dev`.
4. Trigger 5–10 turns of a `provider: 'anthropic'` bot (e.g., the Haiku bot in the reported game).
5. Wait at least 5 minutes for usage to surface in the Anthropic console.
6. Refresh the credit balance page. **Pass**: balance is unchanged (or only changed by an amount accountable to non-bot calls). **Fail**: balance has decreased.

This verification is the only one that distinguishes "subscription path advertised" from "subscription path actually used".

## Affected files

- `src/server/services/ai/providers/ClaudeAgentSdkAdapter.ts` (modify chat() + constructor)
- `src/server/__tests__/ai/providers/ClaudeAgentSdkAdapter.test.ts` (add 5 tests)

No type changes, no other adapters touched, no resolver / brain / engine changes, no env-var changes.

## Out of scope

- Removing or changing `ANTHROPIC_API_KEY` precedence in `resolveAnthropicCredential`. The current resolver is correct: it picks subscription mode when the new var is set; the API key just happens to also be present in the env for OpenAI-style fallback in other code paths and shouldn't be touched on the resolver side.
- A startup-time refusal to boot when both env vars are present together. The adapter-side env scrub is sufficient and less surprising.
- Changes to `AnthropicAdapter` (the api-key path). It is unrelated.
- Changes to non-Anthropic providers.
- Re-evaluating the SDK choice (Agent SDK vs subprocess `claude -p`). The original chat decision (Option B) stands; the issue is a missed config option, not the wrong route.

## Memory implication

The user-feedback memory note `project_anthropic_subscription_auth.md` should be updated AFTER the fix lands to record this gotcha: "the Agent SDK inherits process.env by default and will silently use ANTHROPIC_API_KEY if present — must scrub it from `options.env` per call". I'll defer that update until the fix is merged so the memory reflects shipped behavior, not in-flight changes.
