# JIRA-247 — A3 `origin_is_current_position` should proceed to Phase B build, not PassTurn (technical)

Companion to `jira-247-a3OriginEqualsCurrentPosLivelock-behavioral.md`.

## Defect locus

`src/server/services/ai/MovementPhasePlanner.ts:482-491`:

```ts
} else {
  const previewBuildOrigin = a3OriginResult[0].from;
  const currentPos = context.position;

  if (
    currentPos &&
    previewBuildOrigin.row === currentPos.row &&
    previewBuildOrigin.col === currentPos.col
  ) {
    trace.a3.terminationReason = 'origin_is_current_position';
  } else {
    // ... ActionResolver.resolveMove(...) — A3 moves bot to the build origin
  }
}
```

The `origin_is_current_position` branch is dead — it sets a termination reason and falls through to `break` (line 524), emitting an empty plan that the executor materializes as PassTurn.

Semantically, `origin_is_current_position` means "no MoveTrain is needed; the bot can build right here." But the code treats it the same as a failure. Phase B never runs because the outer loop has already broken.

JIRA-244's Fix B added a similar reachability check for the `a3OriginResult.length === 0` case (lines 468-481) and correctly uses `continue` to retry A2 — that fix is structurally adjacent and works. The fix here is symmetric: instead of breaking out, transition into Phase B's build composition with the current position as the build origin.

## Fix shape

Two minimal options. **Recommended: option A.** Smaller diff, no contract changes, follows JIRA-244 Fix B's pattern.

### Option A — `continue` to A2 with a hint that Phase B should compose the build from currentPos

A2's outer loop already supports composing a BuildTrack action when the next stop is reachable but requires building. Set a flag (or just rely on the existing trace state) that the outer composition's Phase B step picks up after A2 settles.

The simplest implementation: replicate JIRA-244 Fix B's `continue` pattern, but set a different termination reason so Phase B knows to compose a build (not just a move). The trace.a3.terminationReason can carry the signal:

```ts
} else {
  const previewBuildOrigin = a3OriginResult[0].from;
  const currentPos = context.position;

  if (
    currentPos &&
    previewBuildOrigin.row === currentPos.row &&
    previewBuildOrigin.col === currentPos.col
  ) {
    // JIRA-247: bot is already at the build origin. Phase B will compose
    // a BuildTrack action against the active route's next stop.
    // Set the trace and continue — the outer composition loop will run Phase B.
    trace.a3.terminationReason = 'a3_build_origin_is_current_pos';
    trace.build.target = a3BuildTarget.targetCity;
    continue;
  }

  // ... existing ActionResolver.resolveMove(...) path
}
```

This matches JIRA-244 Fix B's pattern: set the termination reason, then `continue` the outer loop. The next iteration of A2 will check whether the bot can now process the route's current stop (still no — Stockholm is still off-network), then fall through to the same A3 again — but Phase B's BuildTrack composer runs as part of the outer turn composition (separate code path that consumes `trace.build.target`).

**Verification needed**: confirm that Phase B's composer actually fires on subsequent A2/A3 passes when `trace.build.target` is set but no movement plan was added. If not, option A also needs to push a BuildTrack plan into `plans` directly here.

### Option B — Synthesize a BuildTrack plan inline

If option A's outer-loop interplay is too fragile, set the BuildTrack target and exit cleanly without breaking. The composer is invoked by the surrounding code after A2/A3 returns. As long as `trace.build.target` is populated, the BuildTrack step composes downstream.

```ts
if (
  currentPos &&
  previewBuildOrigin.row === currentPos.row &&
  previewBuildOrigin.col === currentPos.col
) {
  trace.a3.terminationReason = 'a3_build_origin_is_current_pos';
  trace.build.target = a3BuildTarget.targetCity;
  // Do not continue or break — let the outer break path complete.
  // The downstream BuildTrack composer reads trace.build.target.
  break;
}
```

`break` is intentional here — A2/A3 are done for this turn; the downstream composer handles BuildTrack.

### Which option to ship

Read `BuildPhasePlanner.ts` (or whichever module composes the Phase B `BuildTrack` action) to verify which option matches its expectations. The build target flow is:

1. A2/A3 sets `trace.build.target = <city>`.
2. Outer composition (probably in `TurnExecutorPlanner` or `MovementPhasePlanner.composeOutput`) reads the target and synthesizes a BuildTrack action with the right segment list.

If step 2 unconditionally runs when `trace.build.target` is set, option B is sufficient. If step 2 requires another A2 pass first, option A is needed.

The implementing task should grep for `trace.build.target` consumers and choose accordingly.

## Tests

`src/server/__tests__/ai/MovementPhasePlanner.test.ts`:
- AC1/AC2 — direct unit tests of the A3 `origin_is_current_position` branch. Mock `computeBuildSegments` to return `[{ from: currentPos, to: ... }, ...]` and assert the composition trace produces a BuildTrack action.
- AC4 — regression: existing `a3_target_already_reachable` test (length===0 case) still passes.
- AC5 — regression: when origin ≠ currentPos, the existing MoveTrain branch still fires.

`src/server/__tests__/ai/computeBuildSegments` if any exists — not touched.

## Risk

- **Outer-loop interaction**: option A's `continue` could create a fast loop if A2's next pass also terminates the same way. Mitigate by guarding with a one-shot flag in the trace (e.g., `trace.a3.movePreprended = true` already exists for the move case — add `trace.a3.buildFromCurrentPos = true` and check it at the top of A2 to break out after one composition).
- **Phase B composer assumptions**: must verify the composer handles "no move + build from currentPos" correctly. This is the only material risk. If the composer assumes A3 always did the move first, additional plumbing is needed.

## Not in scope

- The JIRA-246 low-cash gate (separate fix).
- Changing `computeBuildSegments`'s return contract (rejected — fix locally in A3).
- Refactoring A2/A3 separation (existing structure preserved).
