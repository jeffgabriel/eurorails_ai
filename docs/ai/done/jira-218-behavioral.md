# JIRA-218 — `ClaudeAgentSdkAdapter` silently bills API credits despite subscription log lines

## Symptom

With `ANTHROPIC_USE_CLAUDE_CODE=1` set, both expected log lines appear at brain construction:

```
[LLMStrategyBrain] anthropic credential_mode=subscription
[ClaudeAgentSdkAdapter] using Claude subscription credentials
```

— and yet the developer's Anthropic API credit balance continues to decline as the bot takes turns. The user reported watching credits draw down in real time.

## Single observed instance

- **Game**: `6a8ac1a5-fa0d-40ea-9def-61f0e84aa716`
- **Bot**: player `2a961882-75a6-4b7e-a011-f0f9604b6545` (`Haiku`, `provider: 'anthropic'`, `skillLevel: 'easy'`)
- **Branch / commit**: `compounds/guardrail-updates` at `b48131e`
- **Environment**: developer's local dev server (`npm run dev`, started 2026-05-05 07:17 AM after `.env` was edited at 07:16 with `ANTHROPIC_USE_CLAUDE_CODE=1`).
- **Both env vars present in `.env`**: `ANTHROPIC_USE_CLAUDE_CODE=1` AND `ANTHROPIC_API_KEY=<value>`.
- The other three bots in the same game (`Nano` openai, `Pro`/`Flash` google) are unrelated to this report — they hit OpenAI / Google APIs by design.

## What the user expected

When the brain logs `credential_mode=subscription` and the adapter logs `using Claude subscription credentials`, every Anthropic-bound LLM call from that brain should be billed against the developer's Claude Max subscription, not against `ANTHROPIC_API_KEY` credits.

## What the user observed

The log lines appear, but the API credit balance still draws down at the same rate as before the `b48131e` change. There is no log evidence that the subscription path is doing anything — but the adapter object is verifiably the `ClaudeAgentSdkAdapter` (the constructor's log line proves construction).

## Scope

This ticket is scoped to the **single observation above**. It is NOT a claim that:

- Every adapter is broken.
- The bearer-token deletion was wrong.
- The previous `AnthropicAdapter` path is broken (it's not — it's still the default and works as designed).
- Any non-Anthropic provider bot is affected.

If repro on a fresh dev environment also shows API credit draw-down with the env var set, this ticket can be widened. Until then, treat as one observed defect.

## Reproduction steps

1. Check out `compounds/guardrail-updates` at `b48131e` (current HEAD).
2. Confirm `.env` contains BOTH `ANTHROPIC_USE_CLAUDE_CODE=1` AND `ANTHROPIC_API_KEY=<your-key>`.
3. Confirm `claude` CLI is authenticated locally (`~/.claude/.credentials.json` exists).
4. Restart `npm run dev`.
5. Open game `6a8ac1a5-fa0d-40ea-9def-61f0e84aa716` and trigger a turn for the `Haiku` bot (player `2a961882-75a6-4b7e-a011-f0f9604b6545`).
6. Observe the dev server log: both `credential_mode=subscription` and `using Claude subscription credentials` lines appear.
7. Check the developer's Anthropic console (console.anthropic.com → Billing → Usage). Observe API credit draw-down for the same minute the turn occurred.

## Out of scope for this ticket

- Designing or implementing a fix.
- Adding a runtime check / startup guard that refuses to start if both env vars are set together.
- Changing the precedence rule in `resolveAnthropicCredential`.
- Changing what `claude_code_subscription_mode` means semantically.

The technical ticket (`jira-218-technical.md`) covers diagnosis and fix plan.
