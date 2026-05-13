# JIRA-203 — Technical fix plan

Companion to `jira-203-behavioral.md`.

## Root cause

The lockup is a feedback loop between three modules. Each module behaves correctly in isolation; the failure is that no component breaks the loop.

### 1. BuildRouteResolver / `computeBuildSegments` propose builds that enter capped cities

`src/server/services/ai/BuildRouteResolver.ts` and `src/server/services/ai/computeBuildSegments.ts` do not reference `CITY_ENTRY_LIMIT`, `TerrainType.SmallCity`, `TerrainType.MediumCity`, or `snapshot.allPlayerTracks` for player-count purposes. Their topology constraints account for opponent-occupied edges (via `occupiedEdges`) but not for the per-city player-count cap that the game rules impose:

- Small cities: max 2 players may build into the city
- Medium cities: max 3 players may build into the city

In game `1e87e2aa-…ab517e71`, Flash is at `(36,42)` with target city Bern. The resolver returns two candidates on T33+:

```
llmGuided      cost=4 segs=[(36,42→36,41),(36,41→37,40)] reachesTarget=true
dijkstraDirect cost=4 segs=[(36,42→36,41),(36,41→37,40)] reachesTarget=true
```

Both terminate at `(37,40)` — a small city already touched by 2 other players. The resolver has no signal that this milepost is unbuildable.

### 2. TurnValidator correctly rejects, but only strips Phase B

`src/server/services/ai/TurnValidator.ts` lines 145–184 (`checkCityEntryLimit`) iterates each `BuildTrack` segment, looks up `terrain` on `seg.to`, and counts distinct players (excluding self) already at that milepost via `snapshot.allPlayerTracks`. With the bot included, total > limit → fails the gate with `detail: "Cannot build into small city at (37,40) — 2 player limit reached"`.

`src/server/services/ai/AIStrategyEngine.ts` lines 387–403 handles the failed validation:

```ts
if (!validationResult.valid) {
  // …
  const strippedSteps = (decision.plan.type === 'MultiAction' ? decision.plan.steps : [decision.plan])
    .filter(s => s.type !== AIActionType.BuildTrack && s.type !== AIActionType.UpgradeTrain);
  decision.plan = strippedSteps.length === 0
    ? { type: AIActionType.PassTurn as const }
    : strippedSteps.length === 1
      ? strippedSteps[0]
      : { type: 'MultiAction' as const, steps: strippedSteps };
  // …
}
```

When the only Phase B step is `BuildTrack` and Phase A produced no move (because `MovementPhasePlanner` already terminated with `origin_is_current_position` — train sits at the build origin), `strippedSteps.length === 0` and the plan collapses to `PassTurn`. No mechanism marks the route as needing replanning or signals the resolver to avoid the capped city.

### 3. No guardrail catches the loop

`src/server/services/ai/GuardrailEnforcer.ts`:

- **Force DELIVER (G1)** — requires `context.canDeliver.length > 0`. Flash carries Beer for Torino, but Torino is not in `connectedMajorCities` (`[Holland, London, Wien]`), so `canDeliver` stays empty.
- **Unaffordable-Stuck** (line 91) — requires `!hasActiveRoute`. Flash has an active 4-stop route, `currentStopIndex=1`, with stops still ahead, so `hasActiveRoute = true` and the guardrail is gated off (per the recent JIRA-199 tightening at lines 472–475 of AIStrategyEngine).
- **Broke-and-stuck** (line 111) — requires `snapshot.bot.money < 5`. Flash has $60M.

State across consecutive turns is identical: same position, same cash, same loads, same demand cards, same active route, same resolver output, same validator rejection, same strip-to-PassTurn. The loop has no exit.

## Fix plan

Two complementary fixes. Fix A is the minimal change that prevents the resolver from ever proposing the illegal build; Fix B is a defence-in-depth recovery that catches any future case where Phase B gets stripped repeatedly.

### Fix A — Make BuildRouteResolver respect CITY_ENTRY_LIMIT (primary)

In `BuildRouteResolver.ts` (and the underlying `computeBuildSegments.ts` if it's the level where edge filtering happens), treat capped small/medium-city destination mileposts as forbidden — same shape as the existing `occupiedEdges` exclusion:

1. From `snapshot.allPlayerTracks`, build a map `cityKey → Set<playerId>` of distinct other players already at each city milepost.
2. For each candidate destination milepost where `terrain ∈ {SmallCity, MediumCity}`, compute `wouldExceedLimit = otherPlayers.size + 1 > (terrain === SmallCity ? 2 : 3)`.
3. If true, exclude any segment whose `to` lands on that milepost from the candidate pool (drop the candidate, or refuse to extend the path through it).

Reuse the player-counting logic from `TurnValidator.checkCityEntryLimit` — extracting it to a helper (e.g. `MapTopology.cityIsAtPlayerLimit(snapshot, row, col)`) keeps the resolver and validator in agreement, eliminating the divergence that produced this bug.

### Fix B — Recover when Phase B is stripped on an active route (defence-in-depth)

In `AIStrategyEngine.ts`, immediately after the Phase B strip block (around line 403), if the resulting plan is `PassTurn` AND `hasActiveRoute` is true, mark the route as un-actionable for this turn. Either:

1. **Abandon the route**: set `routeWasAbandoned = true` so the next turn enters the no-active-route branch and re-plans from scratch.
2. **Force DiscardHand** as a new guardrail (`Phase-B-Stripped-Stuck`) that fires when validation has stripped Phase B to PassTurn with an active route still present. Same shape as `Broke-and-stuck` / `Unaffordable-Stuck` but triggered by validator rejection rather than affordability.

Option 1 is the lighter touch — it leaves card management to existing flows. Option 2 is more aggressive but matches the existing guardrail pattern.

Either way, the "next turn" must produce a different plan than the one that was just rejected. Both options achieve that by changing the bot's input state.

## Acceptance criteria

- A bot with an active route whose next-stop build path passes through a small or medium city already at the player-count limit must not propose a build that terminates at that capped city. The resolver must either route around it, fail with `no_path`, or surface a different candidate.
- If the resolver cannot find any legal path (capped destination + no detour), the bot must not emit `PassTurn` for more than a small constant number of turns (≤ 3) before either abandoning the route, replanning, or discarding the hand.
- An integration test reproducing the Flash T33 lockup conditions (active route to a Bern-like off-network city, build path blocked by a capped small city, $60M cash, no on-network delivery, no broke-stuck trigger) must terminate within a bounded turn count and produce some non-PassTurn action (BuildTrack on an alternative path, DiscardHand, or route abandon).
- Existing `TurnValidator.checkCityEntryLimit` tests continue to pass — the validator behavior is unchanged.
- Existing Phase B strip tests continue to pass — the strip behavior is unchanged in the no-active-route case.

## Out of scope

- Changing the CITY_ENTRY_LIMIT rule or the validator's enforcement (validator is correct).
- Redesigning the entire active-route abandonment policy. The fix is the lockup-escape, not a general route-management overhaul.
- Honeymoon (2-player) variation rules — small city limit there is 1 player, but this game is not Honeymoon.
- Generalising to "any hard-gate validation failure" — the observed lockup is specifically CITY_ENTRY_LIMIT. Other gates may have their own resolver-divergence bugs but they were not observed in this game.
