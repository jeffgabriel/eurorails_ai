# JIRA-41: Debug Overlay Demand Ranking Out of Sync with Player Hand

**Severity:** Medium
**Source:** Game `85a69b96` analysis (JIRA-35 Bug 3)

## Problem

The debug overlay's demand ranking display may show stale data that doesn't match the player's current hand. The server-side `demandRanking` in `bot:turn-complete` is correct (updates after card draws), but the client-side overlay may not re-render properly when the same ranking repeats across turns.

## Evidence

Flash player's demand ranking in the NDJSON log is identical across T19-T23 (9 items, same scores). This is correct server-side — no new demand card was drawn, so the ranking shouldn't change. The ranking only updates at T24 after the Steel@Venezia delivery at T23 (which triggers a new card draw).

The server-side `demandRanking` in `bot:turn-complete` has 9 items (3 cards x 3 demands each). If the debug overlay shows different cards than what's in the ranking, the issue is client-side: the overlay may not re-render when the same ranking repeats, or may hold stale state from a previous emission.

## Investigation

Check whether:
- The overlay re-renders on every `bot:turn-complete` emission even when data is identical
- State is correctly reset between turns
- Card count matches between overlay display and `demandRanking` array

## Files

- `src/client/components/DebugOverlay.ts`
