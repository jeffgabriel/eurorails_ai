# Main-Merge Overlap Checklist

After merging `origin/main` (89 commits) into `compounds/guardrail-updates`,
the table below flags places where **both branches addressed the same defect
but with different approaches**, or where main's changes invalidate / supersede
work we already did on our side. Each row needs a Jeff judgment call during PR
review.

Format: **our commit / approach** vs. **main's commit / approach**, plus the
resolution that landed in the merge.

---

## Confirmed overlaps

### 1. Kaliningrad single-entry-point

| | Our side | Main side |
|---|---|---|
| Commit | `e0e4a99` feat(ai): per-city `MaxConnections` cap override | `f38dab9` Move kalingrad so it has more than one entry point |
| Approach | Add `MaxConnections=1` field to gridPoints data + wire through `MapTopology.GridPointData` + `TurnValidator.cityEntryLimit()`; reject 2nd player's build attempt at Kaliningrad | Move Kaliningrad from `{19, 63}` to `{20, 63}` so the adjacency graph admits multiple entries — no policy gate needed |
| Verdict | **Main supersedes ours.** Geometry fix > policy hack. |
| Resolution in merge | Took main's `gridPoints.json` (Kaliningrad now at `{20, 63}`). **Our `MaxConnections` mechanism is still in `MapTopology` + `TurnValidator`** — latent / unused. |
| Open question for Jeff | Do you want the MaxConnections mechanism deleted (it's dead code after your fix), or kept as a generic facility for future cities with similar problems? |
| Side effect | 3 tests still reference the old `(19, 63)` coords: `TurnValidator › computeSaturatedCityKeys`, `TurnValidator › CITY_ENTRY_LIMIT`, `loadGridPoints — MaxConnections override`. These show as new baseline failures. Easy 1-line fix once we decide the mechanism's fate. |

### 2. MapTopology relocation

| | Our side | Main side |
|---|---|---|
| Commit | `1ad22c7` refactor(ai): relocate MapTopology from `services/ai/` to `services/` | `edda820` refactor(MapTopology): relocate MapTopology out of `ai/` to `services/` |
| Approach | Identical intent + final destination. Done in parallel. |
| Verdict | **No real overlap** — same change made twice independently. |
| Resolution in merge | Clean. Same file location, content reconciled with main's terrain-cost-consolidation imports. |
| Open question for Jeff | None. |

### 3. `computeEffectivePathLength` for `milepostsMoved` accounting

| | Our side | Main side |
|---|---|---|
| Commit | `b48459e` fix(ai): JIRA-192 guardrail 8 counts effective mileposts | `9365175` fix(AIStrategyEngine): use computeEffectivePathLength for milepostsMoved logging |
| Approach | Both call `computeEffectivePathLength(step.path, getMajorCityLookup())` for log accounting. |
| Verdict | **Same fix.** Main precomputes the lookup once per turn (`majorCityLookupForLog`); ours called the getter inline per step. |
| Resolution in merge | Took main's precomputed version (minor optimization). Test guard `step.path.length > 0` also from main. |
| Open question for Jeff | None — your version is the marginally better one. |

### 4. PlayerService method consolidation — JIRA-196 capacity-check semantics

| | Our side | Main side |
|---|---|---|
| Commits (our side) | JIRA-196 inline DB FOR UPDATE check in `TurnExecutor.handlePickupLoad` (and equivalents in drop / build / discard) | `add-shared-service-methods` series (PRs #229, #230) — extracted `pickupLoadForPlayer`, `dropLoadForPlayer`, `buildTrackForPlayer`, `discardHandForPlayer`, `purchaseTrainType` on `PlayerService` |
| Approach | Both gate capacity / cash with a real DB `SELECT ... FOR UPDATE`. Main moved the gate into `PlayerService` so the bot path and human path share a single implementation. Our side had the same gate inline. |
| Verdict | **Main supersedes ours.** Same semantics, better location. |
| Resolution in merge | Took main's `PlayerService.*` migration in `TurnExecutor`. Our two JIRA-196 tests (`Fix A: succeeds when snapshot loads are pre-mutated but DB has capacity`, `Fix A: rejects via DB FOR UPDATE check when DB is truly at capacity`) are `it.skip`'d — they tested DB behavior that's now inside `PlayerService` and has its own coverage there. |
| Open question for Jeff | Confirm that `PlayerService.pickupLoadForPlayer`'s capacity gate has equivalent integration coverage. If not, the JIRA-196 cases need re-homing to a `PlayerService` test. |

### 5. Snapshot.bot.loads sync after drop

| | Our side | Main side |
|---|---|---|
| Our side | `[...slice(0,idx), ...slice(idx+1)]` — remove ONE occurrence (matches the literal "remove the first occurrence" comment) | `snapshot.bot.loads.filter(l => l !== loadType)` — remove ALL occurrences |
| Verdict | **Main is correct, ours had a latent bug.** Postgres `array_remove(loads, $1)` removes ALL matching elements; our snapshot-mirror was removing one — DB and snapshot diverged when the bot carried multiple loads of the same type. Main's `filter` matches the DB behavior. |
| Resolution in merge | Took main's `filter`. |
| Open question for Jeff | None — but worth knowing this latent bug existed on our side before the merge. |

---

## Possible overlaps — Jeff should verify

### 6. InitialBuildService race conditions

| | Our side | Main side |
|---|---|---|
| Commits | `34f1d17` extract `InitialBuildRunner`, `320bb82` integrate it | `082b3d8` move staleness guard inside FOR UPDATE; `8ff386e` add SELECT FOR UPDATE to prevent race |
| Approach | We *extracted* the InitialBuild flow into a new `InitialBuildRunner` service (refactor only). Main *fixed* a race-condition bug in `InitialBuildService` itself. |
| Verdict | **Possibly orthogonal, possibly conflicting.** Main's race fix lives in `InitialBuildService`; our `InitialBuildRunner` calls into it. The merge keeps both. Worth verifying that the FOR UPDATE transaction main added is still in the critical path after our extract. |
| Open question for Jeff | Read `InitialBuildRunner.advanceTurn` flow and confirm the staleness-guard / FOR UPDATE behavior from your commits is exercised when the bot uses InitialBuildRunner. |

### 7. ContextBuilder god-object decomposition

| | Our side | Main side |
|---|---|---|
| Approach | Split 4000+ line `ContextBuilder.ts` into focused sub-modules under `services/ai/context/` (DemandEngine, NetworkContext, BuildContext, DemandContext, UpgradeContext). `ContextBuilder` is now a thin façade. | Kept `ContextBuilder.ts` monolithic (~2864 lines); made small additions for event-card context. |
| Verdict | **No defect overlap, but architectural divergence.** Main has changes we may have dropped during the merge. |
| Resolution in merge | Took HEAD's refactor entirely (`git checkout --ours`). Any small additions main made to `ContextBuilder` for event-card serialization are lost — but since the bot is event-card-unaware (Phase 4 deferred), this is fine until Phase 4. |
| Open question for Jeff | When Phase 4 (event-card integration) happens, the additions you made to `ContextBuilder.ts` for event-card serialization will need to be re-applied to the split sub-modules. |

---

## No overlap — additive on main, additive on ours

These flag changes from main that we kept intact, with no equivalent on our side:

- Event card system (`EventCardService`, `ActiveEffectManager`, `AreaOfEffectService`, `TrackService.removeSegmentsCrossingRiver`, action restriction enforcement) — **Phase 4 deferred**, bot remains event-card-unaware.
- Shared utility consolidations: `cityPositionResolver`, `trainProperties`, `terrainCosts`, `waterCrossings` — we adopted main's shared utils.
- Socket broadcasting for event effects (`emit*` methods) — present in `socketService`, not invoked by bot.
- Migration 036 (`games.active_event` column) — applied; bot doesn't read it.

---

## Test infrastructure debt

After the merge, the new baseline has 59 failing tests (up from 41 pre-merge).
Breakdown of the +18 net delta:

| Cluster | Count | Cause |
|---|---|---|
| `Event card lifecycle integration` | 9 | Need test DB + new migrations applied |
| `Migration 036: games.active_event` | 7 | Need test DB |
| `PlayerService Integration Tests` | 8 | Need test DB |
| `TurnValidator` / `loadGridPoints` (Kaliningrad coords) | 3 | Tests reference old `{19, 63}` — fix when MaxConnections mechanism's fate is decided |
| `AIStrategyEngine.takeTurn` (JIRA-170, JIRA-97) | 3 | Test isolation / mock-leak issues; tests pass in isolation but fail in full-suite run |
| **Total new** | **30** | |
| **Baseline tests now passing** | -12 | Various — improvements from main's refactor + our test-side cleanups |
| **Net delta** | **+18** | |

The 24 DB-required tests will go green automatically once the test database has main's new migrations applied.
