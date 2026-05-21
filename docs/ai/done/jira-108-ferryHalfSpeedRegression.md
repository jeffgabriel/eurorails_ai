JIRA-108: Ferry Half-Speed Not Enforced — BE-006 Regression

Problem
- Commit 9a9c77b (BE-006, 2026-03-02) hardcoded `ferryHalfSpeed = false` in WorldSnapshotService, breaking half-speed enforcement on ferry turns.
- Bots get full 9mp budget instead of 5mp after ferry crossings.
- Evidence: game 579b9389, player 6d720889 (Freight) — t13: 10 mileposts moved, t14: 6 mileposts moved (limit should be 5).

Root Cause
- BE-006 moved ferry detection from WorldSnapshotService to ActionResolver.resolveMove().
- resolveMove() correctly halves speed internally for its own pathfinding, but never communicates this back to TurnComposer.
- TurnComposer reads context.speed (now always full speed) for its movement budget, so the A2 chain grants extra movement: 9 - 5 = 4mp bonus on top of the correct 5mp primary move.
- BE-006's rationale ("false-positive half-speed when bot is at a ferry port but not crossing") was wrong — in our system, landing on a ferry terminal forces a crossing. The original terrain detection was correct.

Fix
Restore the WorldSnapshotService terrain detection removed by BE-006:
- Revert `const ferryHalfSpeed = false` back to the FerryPort terrain check.
- Bot at FerryPort → ferryHalfSpeed = true → context.speed halved → TurnComposer budget correct.
- Keep ActionResolver's ferry teleportation logic (correctly handles position teleport).
- ~8 lines of previously working code to restore.

Affected Files
- WorldSnapshotService.ts:155 — ferryHalfSpeed hardcoded false (primary fix)
- TurnComposer.ts:78,329 — reads context.speed for budget (fixed indirectly)
- ActionResolver.ts:252-261 — ferry teleportation (keep as-is)
