# JIRA-260 — Bot turn-advance bypasses the transactional effect-lifecycle path; route bot turn-end through it so consumeLostTurn + cleanupExpiredEffects fire (technical)

Companion to `jira-260-derailmentLostTurnNeverConsumed-behavioral.md`.

## Defect locus

`src/server/services/ai/BotTurnTrigger.ts:446` — `await PlayerService.updateCurrentPlayerIndex(gameId, nextIndex);`

This call passes no `client` and no `prevPlayerIndex`. Per `PlayerService.updateCurrentPlayerIndex` (`src/server/services/playerService.ts:797-800`, comment block at lines 782-784): "When neither `client` nor `prevPlayerIndex` is provided (legacy path), skips effect management entirely — existing callers are unaffected." That means `cleanupExpiredEffects` and `consumeLostTurn` are not called when a bot's turn ends.

`PlayerService.updateCurrentPlayerIndex` callers:
- `src/server/routes/playerRoutes.ts:321` — also legacy path, but it's the human end-turn HTTP route (a different gap; not in scope for this ticket because the bug user observed is the bot-only-game case).
- `src/server/services/ai/BotTurnTrigger.ts:446` — bot end-of-turn (the locus).

In games where every turn-advance goes through `BotTurnTrigger` (all-bot games), `consumeLostTurn` and `cleanupExpiredEffects` never run. Hence:
- Derailment `pendingLostTurns` entries accumulate and never clear → infinite "lost turn" loop (observed).
- Strike / Snow / Flood expirations may also never fire → restrictions persist past their intended duration (likely-related, see behavioral ticket).

## Fix shape

Open a transaction inside `BotTurnTrigger`'s end-of-turn block and call the transactional form of `updateCurrentPlayerIndex(gameId, nextIndex, client, prevPlayerIndex)`. The transactional path already does the right thing — it cleans up expired effects from the prev player and consumes the next player's lost turn, recursively advancing if the next player is also lost.

Approximate change in `BotTurnTrigger.ts:446`:

```ts
const prevIndex = game.current_player_index;
const nextIndex = (prevIndex + 1) % playerCount;
const client = await db.connect();
try {
  await client.query('BEGIN');
  await PlayerService.updateCurrentPlayerIndex(gameId, nextIndex, client, prevIndex);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

`db.connect()` is the project's `pg.Pool.connect()` wrapper — confirm exact import path during implementation (search for existing `db.connect()` usages in `playerService.ts` for the canonical pattern).

## Why this fix works for the observed bug

Trace post-fix for the game-`f3ed7b8f` scenario (Haiku + Sonnet):

1. Haiku draws Derailment on T40, gets `pendingLostTurns[<Haiku>]` added.
2. Haiku's T40 ends → BotTurnTrigger fires the transactional path with `prevIdx=Haiku, nextIdx=Sonnet`. `consumeLostTurn(<Sonnet>)` returns false (no entry) → Sonnet's turn proceeds.
3. Sonnet's T41 ends → BotTurnTrigger transactional path with `prevIdx=Sonnet, nextIdx=Haiku`. `cleanupExpiredEffects` runs; `consumeLostTurn(<Haiku>)` finds the entry → removes it AND skips Haiku → advance to Sonnet again. (Per rulebook, "the player loses one turn" — Sonnet plays the slot that would have been Haiku's.)
4. Sonnet's next turn ends → BotTurnTrigger transactional path with `prevIdx=Sonnet, nextIdx=Haiku`. `consumeLostTurn(<Haiku>)` returns false now (entry was already consumed at step 3). Haiku resumes normal play.

The recursive skip-while-lost loop already exists at `playerService.ts:846-869`; the only change is making sure the call gets there.

## Acceptance from behavioral

- **AC1** — Unit / integration test on `BotTurnTrigger`'s end-of-turn block: fixture with two players, one of them holds a `pendingLostTurns` entry, no human players. After one bot finishes, assert that on the next `consumeLostTurn` call (during the OTHER bot's turn-end), the lost-turn entry is removed from `games.active_event`.
- **AC2** — Replay-style test using a snapshot matching Haiku T41 (`pendingLostTurns: [{ playerId: <Haiku> }]`). After running BotTurnTrigger's advance machinery through one full round, assert `games.active_event[*].pendingLostTurns` no longer contains Haiku.
- **AC3** — Same as the behavioral AC3: full all-bot integration test with two bots, one drawing Derailment. After 1 full round, pendingLostTurns is empty.
- **AC4** — Mixed-game regression guard: human + bot. The human end-turn route (`playerRoutes.ts:321`) also uses the legacy path, so this fix does NOT change that path. Assert: the bot's lost turn is consumed via the EXISTING transactional path when called from somewhere else (e.g., when the next human turn-end fires from a different code path that does pass `client + prevPlayerIndex`). If no such other path exists, this AC should be deferred / dropped — the mixed-game case may currently happen to work due to incidental ordering, and a more thorough fix could land in a follow-up.
- **AC5** — Integration: replay Haiku T41 of `f3ed7b8f-8ebb-45f9-9010-90c3fbfac628`; assert PassTurn fires exactly once (the original T41), then T42 enters normal planning.

## Validation hooks to inspect during fix

- `[ActiveEffectManager] Consumed lost turn for player=<playerId> gameId=<gameId>` log line should appear once per Derailment per affected player after the fix; should NOT appear repeatedly across consecutive turns.
- `[ActiveEffectManager] Cleaned up expired effects: cardIds=<list>` should fire at the end of the drawing player's next turn for short-duration cards (Strike, Snow); verify with a Strike replay separately.
- The PassTurn-with-Derailment-reasoning entries in the NDJSON should reduce to exactly one per Derailment hit per affected player after the fix.

## Not in scope

- The matching gap at `playerRoutes.ts:321` (human end-turn HTTP route also using the legacy path). That's a separate fix surface — file a follow-up if testing shows mixed-game expirations also fail. The user's observation is the bot-only case.
- Refactoring `updateCurrentPlayerIndex` to make the transactional path the only path. The legacy path is documented and existing callers may rely on it for initial setup or migrations. Keep both.
- Cleanup of `cleanupExpiredEffects` semantics or expiry timing rules. The expire-after-turn-N rule lives in `cleanupExpiredEffects`; this fix just ensures it runs.
- Load loss accounting on Derailment. The behavioral ticket scopes this fix to lost-turn consumption; load loss has its own write-path and is not implicated by the locus here.

## Relationship to existing JIRAs

- **JIRA-256 / BE-005 / BE-007**: The pre-emption + re-snapshot work introduced by Phase 4 correctly *detects* pending lost turns. The bug is that consumption was never wired through for bot-only games. The two-layer fix (Phase 4 detection + this ticket's consumption) gives complete coverage.
- **JIRA-251** (bot blind to active rail strike): the Coastal Strike side of the same root cause may be the residual reason rejections persisted there even after JIRA-257/259 land. Worth verifying once this fix is in.
- **JIRA-257, JIRA-259**: orthogonal — those fixed planner/guardrail consultation of active effects. This fix is about the lifecycle of those effects, not their consultation.
