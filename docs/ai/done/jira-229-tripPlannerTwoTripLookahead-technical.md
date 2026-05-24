# JIRA-229 — Lite two-trip look-ahead aggregate scoring (technical)

Companion to `jira-229-tripPlannerTwoTripLookahead-behavioral.md`. Read that first for evidence and acceptance.

## Current implementation

### `scoreCandidate` (`DeterministicTripPlanner.ts` ~line 572)

Computes per-trip metrics via `simulateTrip`, then:

```ts
const net = candidate.payout - result.totalBuildCost;
const turns = Math.max(1, result.turnsToComplete);
const score = net - opts.ocpt * turns;
return { ...candidate, buildCost: result.totalBuildCost, turns, net, score, feasible: result.feasible };
```

The `.score` field is the per-trip rank key.

### `pickTop1` (`DeterministicTripPlanner.ts`, called by `planTripDeterministic`)

Sorts `feasibleCandidates` by `.score` descending and returns the first entry (plus the next two for runner-up reasoning).

### `buildCityToCoords` + `hexDistance`

Already imported and used by `cheapPrune` (lines 539-558). Both available in the same module — no new imports needed.

## Fix plan

Add a new ranking field `aggregateScore` to each `ScoredCandidate`. Compute it after `scoreCandidate` runs on all survivors but before `pickTop1` picks. Sort by `aggregateScore` instead of `score`.

### 1. Extend the `ScoredCandidate` interface

```ts
interface ScoredCandidate extends Candidate {
  buildCost: number;
  turns: number;
  net: number;
  score: number;          // legacy per-trip score, kept for backward compat / logging
  feasible: boolean;
  // New:
  aggregateScore: number;      // primary rank key
  aggregateFollowup: ScoredCandidate | null;  // best follow-up, or null if standalone
  aggregateEmptyLegTurns: number;             // empty-leg turns from this trip's end to followup's start
}
```

### 2. New function `computeAggregateScore`

Operates on already-scored feasible candidates. O(N²) over feasible count, typically N=30-100, so ~1k-10k operations per replan — cheap.

```ts
function computeAggregateScore(
  c1: ScoredCandidate,
  allFeasible: ScoredCandidate[],
  cityToCoords: Map<string, GridCoord[]>,
  speed: number,
): { aggregate: number; followup: ScoredCandidate | null; emptyLegTurns: number } {
  const c1Cards = new Set(c1.rows.map(r => r.cardIndex));
  const c1EndCity = c1.stops[c1.stops.length - 1].city;
  const c1EndCoords = nearestCityCoord(c1EndCity, { row: 0, col: 0 }, cityToCoords);

  // The bot WILL do a follow-up trip when feasible follow-ups exist, so the
  // chained aggregate is the bot's actual expected trajectory. Standalone
  // is only the right metric when no disjoint follow-up is feasible (endgame).
  let bestAggregate: number | null = null;
  let bestFollowup: ScoredCandidate | null = null;
  let bestEmptyLegTurns = 0;

  for (const c2 of allFeasible) {
    if (c2 === c1) continue;
    // Card overlap rejects same-cardIndex follow-ups
    const overlap = c2.rows.some(r => c1Cards.has(r.cardIndex));
    if (overlap) continue;

    const c2StartCity = c2.stops[0].city;
    const c2StartCoords = nearestCityCoord(
      c2StartCity,
      c1EndCoords ?? { row: 0, col: 0 },
      cityToCoords,
    );

    let emptyLegTurns = 0;
    if (c1EndCoords && c2StartCoords) {
      const hops = hexDistance(c1EndCoords.row, c1EndCoords.col, c2StartCoords.row, c2StartCoords.col);
      emptyLegTurns = Math.ceil(hops / speed);
    }

    const aggregateTurns = Math.max(c1.turns + emptyLegTurns + c2.turns, 1);
    const aggregateNet = c1.net + c2.net;
    const aggregate = aggregateNet / aggregateTurns;

    if (bestAggregate === null || aggregate > bestAggregate) {
      bestAggregate = aggregate;
      bestFollowup = c2;
      bestEmptyLegTurns = emptyLegTurns;
    }
  }

  // Endgame fallback: no disjoint follow-up. Use c1's standalone velocity.
  if (bestAggregate === null) {
    return { aggregate: c1.net / Math.max(c1.turns, 1), followup: null, emptyLegTurns: 0 };
  }

  return { aggregate: bestAggregate, followup: bestFollowup, emptyLegTurns: bestEmptyLegTurns };
}
```

### 3. Compute aggregate in `planTripDeterministic` after `scoreCandidate` loop

```ts
// Existing:
const feasible: ScoredCandidate[] = [];
for (const cand of survivors) {
  const scored = scoreCandidate(cand, startPos, snapshot, opts);
  if (scored.feasible) feasible.push(scored);
}

// NEW: compute aggregate for each feasible candidate
const cityToCoords = buildCityToCoords();
for (const c1 of feasible) {
  const result = computeAggregateScore(c1, feasible, cityToCoords, speed);
  c1.aggregateScore = result.aggregate;
  c1.aggregateFollowup = result.followup;
  c1.aggregateEmptyLegTurns = result.emptyLegTurns;
}

// Existing top-1 pick — change sort key:
const top1 = pickTop1(feasible);
```

### 4. Modify `pickTop1` to rank by `aggregateScore`

```ts
export function pickTop1(feasible: ScoredCandidate[]): ScoredCandidate[] {
  // Sort by aggregate descending; tiebreak by net descending; secondary tiebreak by id for determinism
  return [...feasible].sort((a, b) => {
    if (b.aggregateScore !== a.aggregateScore) return b.aggregateScore - a.aggregateScore;
    if (b.net !== a.net) return b.net - a.net;
    return a.id.localeCompare(b.id);
  });
}
```

### 5. Update reasoning string

In the reasoning composer (where "Picked: ..." is built), add an aggregate line:

```
Picked: single-fresh — payout 25M, build 11M, 6 turns, NET 14M, score -16.0
Aggregate: 2.55 M/turn (chained with pair:66-Hops+108-Bauxite:A-then-B, empty-leg 1 turns)
```

When `aggregateFollowup === null`:

```
Aggregate: 3.86 M/turn (standalone — no feasible follow-up)
```

Runner-ups also list their aggregate score:

```
Runner-up #2: single:35:Ham, aggregate 2.33 M/turn, NET 27M, 7 turns. Lost by 0.22.
```

(Replacing the existing `score X.X` with `aggregate X.XX M/turn` for clarity.)

### What does NOT change

- `scoreCandidate` body — still computes `net`, `turns`, `score = net - OCPT * turns`. The `.score` is retained for backward compat and any caller that imports it (verify no external callers exist).
- `cheapPrune` — unchanged, prune logic unaffected.
- Candidate enumeration (`genSingles`, `genPairs`, `genTriples`) — unchanged.
- `OCPT_BY_PHASE` values — unchanged. OCPT is no longer the rank key but stays as documentation and as the input to legacy `.score` (which may still be useful for filter logic in future tickets).
- Phase classification — unchanged.

## Tests

### Unit — `DeterministicTripPlanner.aggregateLookahead.test.ts` (new file)

**AC1 (pair wins when its follow-up beats single's follow-up)**

Reproduce the T120 game-36eab81a scenario:
- 2 feasible candidates: single `S1` (net=14, turns=6, ends at "Leipzig"), pair `P1` (net=28, turns=11, ends at "Wroclaw")
- 1 more candidate `C2` for follow-up (net=10, turns=5, supply at "Bremen")
- Mock city coords so Leipzig→Bremen is ~6 hops, Wroclaw→Bremen is ~4 hops, speed=12
- Single S1: aggregate = (14+10) / (6 + 1 + 5) = 24/12 = 2.0
- Pair P1: aggregate = (28+10) / (11 + 1 + 5) = 38/17 = 2.24
- Assert: pickTop1 returns P1 first.

**AC2 (single wins when it's genuinely best)**

- 2 feasible: single `S` (net=40, turns=5, M/turn=8.0), pair `P` (net=42, turns=12, M/turn=3.5)
- Follow-up candidate `C2` (net=20, turns=5)
- Single S aggregate = (40+20)/(5+1+5) = 60/11 = 5.45
- Pair P aggregate = (42+20)/(12+1+5) = 62/18 = 3.44
- Assert: pickTop1 returns S first. Single's lead is genuine.

**AC3 (card overlap rejects same-card follow-ups)**

- 2 candidates: `single:5:Ham` and `single:5:Bauxite` (both card 5)
- They CANNOT chain — same cardIndex.
- Each falls back to standalone net/turns.
- Assert: aggregateFollowup === null for both, aggregateScore === net/turns.

**AC4 (no feasible follow-up → standalone fallback)**

- 1 feasible candidate only.
- aggregateScore === net/turns.
- aggregateFollowup === null.
- Reasoning string mentions "standalone".

**AC5 (carry candidate works as c1)**

- Candidate has only deliver stops (no pickup) — a carry.
- Start city = first deliver's city, end city = last deliver's city.
- Aggregate computation still runs correctly.

**AC6 (empty-leg uses real grid coords)**

- Mock the city-coords lookup to return specific (row, col) pairs.
- Verify `hexDistance` is called with those coords.
- Verify `emptyLegTurns = ceil(hops / speed)`.

**AC7 (regression — T120 game-36eab81a scenario)**

- Build a snapshot/context matching T120: cap-3 superfreight, late phase, 9-card hand including Hops/Bauxite.
- After enumerate + prune + score, the aggregate ranker MUST select `pair:66-Hops+108-Bauxite:A-then-B` over `single:66:Hops`.

### Existing tests to keep green

- `DeterministicTripPlanner.test.ts` — all 71+ existing tests. The `.score` field still computed; only ranking changes. Existing tests that assert which candidate wins may need updates if they construct fixtures where aggregate ranking differs from score ranking. Audit on first run.

## Risk

**Behavioral change is significant** — 37% of picks would flip per the pressure test. Mitigation:
- Pressure test showed 0/9 flips going the wrong direction (every flip improves aggregate velocity).
- Existing test suite catches any regression in established behavior.
- If real-game replays show regression, OCPT-floor filter can be re-added as a guardrail.

**Reasoning string format change** could break log-parsing tools. Mitigation:
- Add aggregate line WITHOUT removing the score line.
- Runner-up format change is the only breaking change; check `scripts/ai/` and any external log parsers for dependency on the old format.

**Coordinate lookup edge case** — `nearestCityCoord` might return `null` for unknown cities. Mitigation: empty-leg defaults to 0 in that case (handled in the code above), so unknown-city candidates get a slight aggregate advantage (zero empty leg). Acceptable — rare and conservative.

## Confirmation

After shipping, replay a game and inspect a `composition.reasoning` block:

```
[deterministic-top-1] pair:66-Hops+108-Bauxite:A-then-B chosen.
  Phase: late (OCPT=5)
  Picked: pair-fresh — payout 43M, build 15M, 11 turns, NET 28M, score -27.0
  Aggregate: 2.55 M/turn (chained with single:120:Wood, empty-leg 1 turns)
  Stops: ...
  Runner-up #2: single:66:Hops, aggregate 2.33 M/turn, NET 14M, 6 turns. Lost by 0.22.
```

The `Aggregate:` line replaces score as the rank key. The chained follow-up surfaces what trip the planner believes will come next.
