import { cleanDatabase } from "../db";

/**
 * Integration-only test isolation.
 *
 * Real-DB integration suites share one physical Postgres (eurorails_test). Without
 * a clean starting point, rows left by an earlier file (or an earlier, interrupted
 * run) leak into later suites and cause order/accumulation-dependent flakes
 * (e.g. "full game" / "insufficient players" / referential-integrity checks that
 * assume exact row counts).
 *
 * Truncating every non-migration table once per test FILE (beforeAll) gives each
 * suite a deterministic clean slate while preserving any per-file fixtures a suite
 * builds in its own beforeAll. This runs ONLY for the `server-integration` jest
 * project — the unit `server` project does not load it, so the 3500+ unit tests
 * pay nothing.
 *
 * Ordering: listed after `setup.ts` in setupFilesAfterEnv, so this beforeAll runs
 * after setup.ts's beforeAll has ensured the database exists and is migrated.
 */
beforeAll(async () => {
  await cleanDatabase();
});
