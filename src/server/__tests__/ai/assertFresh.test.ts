/**
 * Unit tests for assertFresh() — freshness identity comparison.
 *
 * Verifies:
 *   - Identical identities → Ok
 *   - Differing factsHash → Err(SnapshotMismatch)
 *   - Differing turnNumber → Err(SnapshotMismatch)
 *   - undefined derivedFromIdentity → Ok (legacy path, no check)
 *   - undefined liveIdentity → Ok (legacy path, no check)
 *   - Error carries the SNAPSHOT_MISMATCH reason from GuardrailEnforcer
 */

import { assertFresh, SnapshotMismatch } from '../../services/ai/PostDeliveryReplanner';
import { GuardrailEnforcer } from '../../services/ai/GuardrailEnforcer';
import type { SnapshotIdentity } from '../../../shared/types/GameTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIdentity(overrides: Partial<SnapshotIdentity> = {}): SnapshotIdentity {
  return {
    turnNumber: 5,
    factsHash: 'abc123def456',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('assertFresh', () => {
  describe('happy path — Ok results', () => {
    it('returns Ok when both identities are identical', () => {
      const id = makeIdentity();
      const result = assertFresh(id, id);
      expect(result.isOk()).toBe(true);
    });

    it('returns Ok when both identities have same turnNumber and factsHash', () => {
      const derived = makeIdentity({ turnNumber: 3, factsHash: 'hash-abc' });
      const live = makeIdentity({ turnNumber: 3, factsHash: 'hash-abc' });
      const result = assertFresh(derived, live);
      expect(result.isOk()).toBe(true);
    });

    it('returns Ok when derivedFromIdentity is undefined (legacy path)', () => {
      const live = makeIdentity();
      const result = assertFresh(undefined, live);
      expect(result.isOk()).toBe(true);
    });

    it('returns Ok when liveIdentity is undefined (legacy path)', () => {
      const derived = makeIdentity();
      const result = assertFresh(derived, undefined);
      expect(result.isOk()).toBe(true);
    });

    it('returns Ok when both identities are undefined (fully legacy path)', () => {
      const result = assertFresh(undefined, undefined);
      expect(result.isOk()).toBe(true);
    });
  });

  describe('mismatch path — Err results', () => {
    it('returns Err when factsHash differs (same turnNumber)', () => {
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'old-hash' });
      const live = makeIdentity({ turnNumber: 5, factsHash: 'new-hash' });
      const result = assertFresh(derived, live);
      expect(result.isErr()).toBe(true);
    });

    it('Err value is a SnapshotMismatch instance', () => {
      const derived = makeIdentity({ factsHash: 'old' });
      const live = makeIdentity({ factsHash: 'new' });
      const result = assertFresh(derived, live);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SnapshotMismatch);
    });

    it('Err carries the SNAPSHOT_MISMATCH reason from GuardrailEnforcer', () => {
      const derived = makeIdentity({ factsHash: 'old' });
      const live = makeIdentity({ factsHash: 'new' });
      const result = assertFresh(derived, live);
      const mismatch = result._unsafeUnwrapErr();
      expect(mismatch.reason).toBe(GuardrailEnforcer.SNAPSHOT_MISMATCH);
    });

    it('returns Err when turnNumber differs (same factsHash)', () => {
      const derived = makeIdentity({ turnNumber: 5, factsHash: 'same-hash' });
      const live = makeIdentity({ turnNumber: 6, factsHash: 'same-hash' });
      const result = assertFresh(derived, live);
      expect(result.isErr()).toBe(true);
    });

    it('returns Err when both turnNumber and factsHash differ', () => {
      const derived = makeIdentity({ turnNumber: 3, factsHash: 'old' });
      const live = makeIdentity({ turnNumber: 5, factsHash: 'new' });
      const result = assertFresh(derived, live);
      expect(result.isErr()).toBe(true);
    });
  });

  describe('SNAPSHOT_MISMATCH constant', () => {
    it('GuardrailEnforcer.SNAPSHOT_MISMATCH is a non-empty product-language string', () => {
      expect(typeof GuardrailEnforcer.SNAPSHOT_MISMATCH).toBe('string');
      expect(GuardrailEnforcer.SNAPSHOT_MISMATCH.length).toBeGreaterThan(10);
    });
  });
});

// ── Re-export verification (TEST-002) ─────────────────────────────────────────
// Verify that assertFresh and SnapshotMismatch re-exported from PostDeliveryReplanner
// are the real implementations (not undefined/stubs) and behave identically to
// direct imports from WorldSnapshotService.

import { assertFresh as assertFreshReExport, SnapshotMismatch as SnapshotMismatchReExport } from '../../services/ai/PostDeliveryReplanner';
import { assertFresh as assertFreshDirect, SnapshotMismatch as SnapshotMismatchDirect } from '../../services/ai/WorldSnapshotService';

describe('assertFresh — re-export from PostDeliveryReplanner (TEST-002)', () => {
  it('assertFresh re-export is a function (not undefined)', () => {
    expect(typeof assertFreshReExport).toBe('function');
  });

  it('SnapshotMismatch re-export is a class (constructable)', () => {
    expect(typeof SnapshotMismatchReExport).toBe('function');
    const instance = new SnapshotMismatchReExport('test reason');
    expect(instance).toBeInstanceOf(Error);
    expect(instance.name).toBe('SnapshotMismatch');
    expect(instance.reason).toBe('test reason');
  });

  it('re-exported assertFresh behaves identically to direct import — Ok path', () => {
    const id = makeIdentity({ factsHash: 'same' });
    const reExportResult = assertFreshReExport(id, id);
    const directResult = assertFreshDirect(id, id);
    expect(reExportResult.isOk()).toBe(true);
    expect(directResult.isOk()).toBe(true);
  });

  it('re-exported assertFresh behaves identically to direct import — Err path', () => {
    const derived = makeIdentity({ factsHash: 'old' });
    const live = makeIdentity({ factsHash: 'new' });
    const reExportResult = assertFreshReExport(derived, live);
    const directResult = assertFreshDirect(derived, live);
    expect(reExportResult.isErr()).toBe(true);
    expect(directResult.isErr()).toBe(true);
    expect(reExportResult._unsafeUnwrapErr().reason).toBe(directResult._unsafeUnwrapErr().reason);
  });

  it('SnapshotMismatch re-export instance satisfies instanceof SnapshotMismatchDirect', () => {
    // Both imports point to the same class — instanceof must be symmetric
    const instance = new SnapshotMismatchReExport('reason');
    expect(instance).toBeInstanceOf(SnapshotMismatchDirect);
  });
});
