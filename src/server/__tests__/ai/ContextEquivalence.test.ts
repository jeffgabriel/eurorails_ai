/**
 * ContextEquivalence.test.ts — Context-level behavioural oracle.
 *
 * JIRA-195 Slice 1: Proves that the new single-pass ContextBuilder.build()
 * (which accepts memory as a parameter) produces deep-equal GameContext to
 * the current build-then-patch sequence.
 *
 * Fixtures (F1/F2/F3) are synthetic (WorldSnapshot, BotMemoryState) triples
 * stored under fixtures/contextEquivalence/. They can be regenerated from a
 * real game DB using scripts/captureContextFixtures.ts.
 *
 * Test shape:
 *   For each fixture, run:
 *     1. Legacy path: ContextBuilder.build(snapshot, skillLevel, gridPoints) + patch-up block
 *     2. New path:    ContextBuilder.build(snapshot, memory, skillLevel, gridPoints)
 *   Then: expect(newContext).toEqual(legacyContext)
 *
 * Divergences:
 *   If a field differs between the two paths and the divergence is an intentional
 *   bug fix (not a regression), document it with ACCEPTABLE_DIVERGENCE below.
 *   Any undocumented divergence is a regression and must be fixed before merge.
 *
 * Status: TEST-001 (pre-BE-001)
 *   Before BE-001 lands, both paths use the same build() signature. The
 *   "new path" here simulates what it will do once memory is accepted: it
 *   applies the same patch-up logic inline. This confirms the fixture
 *   infrastructure is working and the test framework is sound.
 *
 *   After BE-001: update the "new path" call to:
 *     ContextBuilder.build(snapshot, memory, skillLevel, gridPoints)
 *   and delete the simulateNewPath helper's patch-up simulation.
 */

import path from 'path';
import fs from 'fs';
import { ContextBuilder } from '../../services/ai/ContextBuilder';
import { BotSkillLevel, WorldSnapshot, BotMemoryState, GameContext } from '../../../shared/types/GameTypes';

// ── Fixture loading ─────────────────────────────────────────────────────────

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'contextEquivalence');

interface ContextFixture {
  _comment?: string;
  snapshot: WorldSnapshot;
  memory: BotMemoryState;
}

function loadFixture(name: 'F1' | 'F2' | 'F3'): ContextFixture {
  const filePath = path.join(FIXTURE_DIR, `${name}.json`);
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as ContextFixture;
}

// ── Mocks ────────────────────────────────────────────────────────────────────

// MapTopology functions are called internally by ContextBuilder. Mock to
// avoid loading the full map geometry in unit tests.
jest.mock('../../services/ai/MapTopology', () => ({
  estimatePathCost: jest.fn(() => 10),
  estimateHopDistance: jest.fn(() => 5),
  hexDistance: jest.fn((r1: number, c1: number, r2: number, c2: number): number => {
    // Cube coordinate hex distance approximation (sufficient for equivalence checks)
    const x1 = c1 - Math.floor(r1 / 2);
    const z1 = r1;
    const y1 = -x1 - z1;
    const x2 = c2 - Math.floor(r2 / 2);
    const z2 = r2;
    const y2 = -x2 - z2;
    return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
  }),
  computeLandmass: jest.fn(() => new Set()),
  computeFerryRouteInfo: jest.fn(() => ({ requiresFerry: false, departurePorts: [], arrivalPorts: [], ferryCost: 0 })),
  makeKey: jest.fn((r: number, c: number) => `${r},${c}`),
  loadGridPoints: jest.fn(() => new Map()),
  getFerryPairPort: jest.fn(() => null),
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => [
    { cityName: 'Wien', center: { row: 37, col: 55 }, outposts: [] },
    { cityName: 'Berlin', center: { row: 24, col: 52 }, outposts: [] },
    { cityName: 'Paris', center: { row: 29, col: 32 }, outposts: [] },
    { cityName: 'Hamburg', center: { row: 18, col: 40 }, outposts: [] },
    { cityName: 'München', center: { row: 41, col: 48 }, outposts: [] },
    { cityName: 'Ruhr', center: { row: 23, col: 37 }, outposts: [] },
    { cityName: 'Bruxelles', center: { row: 24, col: 30 }, outposts: [] },
    { cityName: 'Milano', center: { row: 46, col: 40 }, outposts: [] },
  ]),
  getFerryEdges: jest.fn(() => []),
}));

jest.mock('../../services/ai/connectedMajorCities', () => ({
  getConnectedMajorCities: jest.fn(() => []),
}));

// ── Legacy path (pre-BE-001 behaviour) ─────────────────────────────────────

/**
 * Simulate the legacy build-then-patch sequence that currently lives in
 * AIStrategyEngine.takeTurn():
 *
 *   1. ContextBuilder.build(snapshot, skillLevel, gridPoints)
 *   2. context.deliveryCount = memory.deliveryCount ?? 0
 *   3. context.upgradeAdvice = ContextBuilder.computeUpgradeAdvice(...)
 *   4. context.enRoutePickups = ContextBuilder.computeEnRoutePickups(...) [if activeRoute]
 *   5. context.previousTurnSummary = assembled from lastAction/lastReasoning/lastPlanHorizon
 *
 * This matches AIStrategyEngine.ts:221-247 (pre-turn block) and ts:421-438
 * (post-auto-delivery block — same logic, so we test both via the same helper).
 *
 * After BE-001 lands this helper documents the OLD behaviour for comparison.
 */
async function buildLegacyPath(
  snapshot: WorldSnapshot,
  memory: BotMemoryState,
  skillLevel: BotSkillLevel,
  gridPoints: [],
): Promise<GameContext> {
  // Step 1: Build without memory
  const context = await ContextBuilder.build(snapshot, skillLevel, gridPoints);

  // Step 2-5: Apply patch-up blocks (AIStrategyEngine.ts:222-246)
  context.deliveryCount = memory.deliveryCount ?? 0;

  context.upgradeAdvice = ContextBuilder.computeUpgradeAdvice(
    snapshot, context.demands, context.canBuild, context.deliveryCount,
  );

  if (memory.activeRoute?.stops) {
    context.enRoutePickups = ContextBuilder.computeEnRoutePickups(
      snapshot, memory.activeRoute.stops, gridPoints,
    );
  }

  if (memory.lastReasoning || memory.lastPlanHorizon) {
    const parts: string[] = [];
    if (memory.lastAction) parts.push(`Action: ${memory.lastAction}`);
    if (memory.lastReasoning) parts.push(`Reasoning: ${memory.lastReasoning}`);
    if (memory.lastPlanHorizon) parts.push(`Plan: ${memory.lastPlanHorizon}`);
    context.previousTurnSummary = parts.join('. ');
  }

  return context;
}

/**
 * New single-pass build path (BE-001 implementation).
 *
 * Calls ContextBuilder.build() with memory so all memory-dependent fields
 * (deliveryCount, upgradeAdvice, enRoutePickups, previousTurnSummary) are
 * computed inside build() in a single pass — no patch-up blocks needed.
 *
 * The deep-equality assertions prove this is behaviourally equivalent to
 * the legacy build-then-patch sequence.
 */
async function buildNewPath(
  snapshot: WorldSnapshot,
  memory: BotMemoryState,
  skillLevel: BotSkillLevel,
  gridPoints: [],
): Promise<GameContext> {
  return ContextBuilder.build(snapshot, skillLevel, gridPoints, memory);
}

// ── Acceptable divergences ──────────────────────────────────────────────────

/**
 * ACCEPTABLE_DIVERGENCE registry.
 *
 * After BE-001, the new single-pass build will compute memory-dependent fields
 * inside build() rather than in the patch-up block. For most fields the output
 * is identical. Documented divergences below are intentional bug fixes:
 *
 * - 'canUpgrade': JIRA-207A tightened BuildContext.checkCanUpgrade to require
 *   deliveriesCompleted >= UPGRADE_DELIVERY_THRESHOLD in addition to cash.
 *   The legacy path calls ContextBuilder.build() WITHOUT memory, so
 *   snapshot.bot.deliveriesCompleted is not set (defaults to 0 → gate fails).
 *   The new path calls with memory, which sets deliveriesCompleted correctly
 *   before checkCanUpgrade runs. The divergence is an intentional improvement:
 *   the legacy path under-evaluated upgrade eligibility, the new path does not.
 */
const ACCEPTABLE_DIVERGENCES: string[] = ['canUpgrade'];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ContextEquivalence — legacy build-then-patch vs new single-pass build', () => {
  const skillLevel = BotSkillLevel.Medium;
  const gridPoints: [] = []; // fixtures use empty hexGrid; real grids tested via ContextBuilder.test.ts

  describe('F1 — initial build (turn 1, memory empty, deliveryCount=0)', () => {
    let fixture: ContextFixture;

    beforeAll(() => {
      fixture = loadFixture('F1');
    });

    it('fixture loads and has expected shape', () => {
      expect(fixture.snapshot).toBeDefined();
      expect(fixture.memory).toBeDefined();
      expect(fixture.snapshot.gameStatus).toBe('initialBuild');
      expect(fixture.memory.deliveryCount).toBe(0);
      expect(fixture.memory.activeRoute).toBeNull();
    });

    it('legacy and new paths produce deep-equal GameContext', async () => {
      const legacy = await buildLegacyPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);
      const newCtx = await buildNewPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);

      // Check documented divergences are handled
      if (ACCEPTABLE_DIVERGENCES.length > 0) {
        for (const field of ACCEPTABLE_DIVERGENCES) {
          // Remove divergent fields before comparing (they are acceptable fixes)
          delete (legacy as unknown as Record<string, unknown>)[field];
          delete (newCtx as unknown as Record<string, unknown>)[field];
        }
      }

      expect(newCtx).toEqual(legacy);
    });

    it('deliveryCount is 0 in both paths (memory empty on initial build)', async () => {
      const ctx = await buildNewPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);
      expect(ctx.deliveryCount).toBe(0);
    });

    it('upgradeAdvice is undefined during initialBuild (gate: gameStatus check)', async () => {
      const ctx = await buildNewPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);
      expect(ctx.upgradeAdvice).toBeUndefined();
    });

    it('enRoutePickups is undefined/empty when no activeRoute', async () => {
      const ctx = await buildNewPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);
      expect(!ctx.enRoutePickups || ctx.enRoutePickups.length === 0).toBe(true);
    });

    it('previousTurnSummary is undefined when memory has no lastReasoning or lastPlanHorizon', async () => {
      const ctx = await buildNewPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);
      expect(ctx.previousTurnSummary).toBeUndefined();
    });
  });

  describe('F2 — mid-game with active route (deliveryCount=3, activeRoute populated)', () => {
    let fixture: ContextFixture;

    beforeAll(() => {
      fixture = loadFixture('F2');
    });

    it('fixture loads and has expected shape', () => {
      expect(fixture.snapshot).toBeDefined();
      expect(fixture.memory).toBeDefined();
      expect(fixture.snapshot.gameStatus).toBe('active');
      expect(fixture.memory.deliveryCount).toBeGreaterThan(0);
      expect(fixture.memory.activeRoute).not.toBeNull();
    });

    it('legacy and new paths produce deep-equal GameContext', async () => {
      const legacy = await buildLegacyPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);
      const newCtx = await buildNewPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);

      if (ACCEPTABLE_DIVERGENCES.length > 0) {
        for (const field of ACCEPTABLE_DIVERGENCES) {
          delete (legacy as unknown as Record<string, unknown>)[field];
          delete (newCtx as unknown as Record<string, unknown>)[field];
        }
      }

      expect(newCtx).toEqual(legacy);
    });

    it('deliveryCount is injected from memory', async () => {
      const ctx = await buildNewPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);
      expect(ctx.deliveryCount).toBe(fixture.memory.deliveryCount);
    });

    it('previousTurnSummary is assembled from lastAction/lastReasoning/lastPlanHorizon', async () => {
      const ctx = await buildNewPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);
      // F2 has both lastReasoning and lastPlanHorizon set
      expect(ctx.previousTurnSummary).toBeDefined();
      const summary = ctx.previousTurnSummary!;
      if (fixture.memory.lastAction) {
        expect(summary).toContain(`Action: ${fixture.memory.lastAction}`);
      }
      if (fixture.memory.lastReasoning) {
        expect(summary).toContain(`Reasoning: ${fixture.memory.lastReasoning}`);
      }
      if (fixture.memory.lastPlanHorizon) {
        expect(summary).toContain(`Plan: ${fixture.memory.lastPlanHorizon}`);
      }
    });

    it('enRoutePickups is computed from activeRoute.stops when present', async () => {
      const ctx = await buildNewPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);
      // enRoutePickups may be empty if no loads are available near stops, but the field
      // should always be defined (not undefined) when activeRoute.stops is populated.
      // The fixture has an empty hexGrid so no cities are found in the scan — result is []
      expect(ctx.enRoutePickups).toBeDefined();
      expect(Array.isArray(ctx.enRoutePickups)).toBe(true);
    });
  });

  describe('F3 — post-auto-delivery (deliveryCount=5, lastAction=DeliverLoad, no activeRoute)', () => {
    let fixture: ContextFixture;

    beforeAll(() => {
      fixture = loadFixture('F3');
    });

    it('fixture loads and has expected shape', () => {
      expect(fixture.snapshot).toBeDefined();
      expect(fixture.memory).toBeDefined();
      expect(fixture.snapshot.gameStatus).toBe('active');
      expect(fixture.memory.deliveryCount).toBeGreaterThanOrEqual(4);
      expect(fixture.memory.activeRoute).toBeNull();
    });

    it('legacy and new paths produce deep-equal GameContext', async () => {
      const legacy = await buildLegacyPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);
      const newCtx = await buildNewPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);

      if (ACCEPTABLE_DIVERGENCES.length > 0) {
        for (const field of ACCEPTABLE_DIVERGENCES) {
          delete (legacy as unknown as Record<string, unknown>)[field];
          delete (newCtx as unknown as Record<string, unknown>)[field];
        }
      }

      expect(newCtx).toEqual(legacy);
    });

    it('deliveryCount=5 satisfies the MIN_DELIVERIES_BEFORE_UPGRADE gate', async () => {
      const ctx = await buildNewPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);
      // deliveryCount=5 >= MIN_DELIVERIES_BEFORE_UPGRADE (2), so upgradeAdvice is eligible
      // (still may be undefined depending on trainType / money / turn, but gate is open)
      expect(ctx.deliveryCount).toBe(5);
    });

    it('previousTurnSummary contains DeliverLoad when lastAction=DeliverLoad', async () => {
      const ctx = await buildNewPath(fixture.snapshot, fixture.memory, skillLevel, gridPoints);
      expect(ctx.previousTurnSummary).toBeDefined();
      expect(ctx.previousTurnSummary).toContain('Action: DeliverLoad');
    });
  });
});
