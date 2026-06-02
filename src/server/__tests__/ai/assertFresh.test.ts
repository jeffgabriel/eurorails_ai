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
