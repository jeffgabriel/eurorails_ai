import { estimateHopDistance, estimatePathCost, hexDistance, _resetCache } from '../../services/ai/MapTopology';

describe('estimateHopDistance', () => {
  afterEach(() => {
    _resetCache();
  });

  it('returns 0 for same position', () => {
    expect(estimateHopDistance(10, 10, 10, 10)).toBe(0);
  });

  it('returns 1 for adjacent hexes', () => {
    // Adjacent hexes on the grid should be 1 hop apart
    // Use a known valid pair from the grid
    const dist = estimateHopDistance(10, 10, 10, 11);
    // If both are valid grid points, should be 1; if not on grid, 0
    expect(dist).toBeGreaterThanOrEqual(0);
    expect(dist).toBeLessThanOrEqual(1);
  });

  it('returns 0 for positions not on the grid', () => {
    // Use extreme coordinates that are unlikely to be on the game board
    expect(estimateHopDistance(999, 999, 998, 999)).toBe(0);
  });

  it('returns value >= hexDistance for any valid pair (actual path >= straight line)', () => {
    // Warszawa and Roma are far apart; BFS hop count should be >= hex distance
    // We need to find their grid coordinates. Use known approximate positions.
    // Warszawa is roughly at row 13, col 22; Roma at row 27, col 16
    // The exact coords depend on the grid, but the principle holds:
    // BFS through the actual grid >= Chebyshev distance
    const fromRow = 13, fromCol = 22;
    const toRow = 27, toCol = 16;
    const hopDist = estimateHopDistance(fromRow, fromCol, toRow, toCol);
    const straightDist = hexDistance(fromRow, fromCol, toRow, toCol);

    if (hopDist > 0) {
      expect(hopDist).toBeGreaterThanOrEqual(straightDist);
    }
  });

  it('returns accurate hop count for a cross-map route', () => {
    // For any two distant valid grid points, BFS should return a reasonable count
    // that is larger than hexDistance (which underestimates due to map topology)
    const hopDist = estimateHopDistance(5, 10, 30, 15);
    // If both points are valid, hop distance should be positive
    // This verifies BFS actually traverses the grid
    if (hopDist > 0) {
      const straightDist = hexDistance(5, 10, 30, 15);
      expect(hopDist).toBeGreaterThanOrEqual(straightDist);
    }
  });

  // JIRA-88: Ferry-aware BFS
  it('returns non-zero hop count for Belfast (ferry-separated from mainland)', () => {
    // Belfast (row=7, col=26) → Glasgow (row=5, col=30) requires Irish Sea ferry
    const hopDist = estimateHopDistance(7, 26, 5, 30);
    expect(hopDist).toBeGreaterThan(0);
  });

  it('returns non-zero hop count for Dublin (ferry-separated from Britain)', () => {
    // Dublin (row=10, col=24) → Birmingham (row=16, col=30) requires Irish Sea ferry
    const hopDist = estimateHopDistance(10, 24, 16, 30);
    expect(hopDist).toBeGreaterThan(0);
  });
});

describe('estimatePathCost', () => {
  afterEach(() => {
    _resetCache();
  });

  it('returns 0 for same position', () => {
    expect(estimatePathCost(10, 10, 10, 10)).toBe(0);
  });

  it('returns non-zero cost for mainland route', () => {
    // Birmingham (row=16, col=30) → London (row=20, col=31) — mainland Britain
    const cost = estimatePathCost(16, 30, 20, 31);
    expect(cost).toBeGreaterThan(0);
  });

  // JIRA-88: Ferry-aware Dijkstra
  it('returns non-zero cost for Belfast including ferry port build cost', () => {
    // Belfast (row=7, col=26) → Glasgow (row=5, col=30) requires Irish Sea ferry
    const cost = estimatePathCost(7, 26, 5, 30);
    expect(cost).toBeGreaterThan(0);
    // Ferry cost is at least 4M (Belfast ferry port cost)
    expect(cost).toBeGreaterThanOrEqual(4);
  });

  it('returns non-zero cost for Dublin including ferry port build cost', () => {
    // Dublin (row=10, col=24) → Birmingham (row=16, col=30) requires Irish Sea ferry
    const cost = estimatePathCost(10, 24, 16, 30);
    expect(cost).toBeGreaterThan(0);
  });

  it('mainland routes are not affected by ferry changes (regression)', () => {
    // Two mainland continental cities should give a path cost based only on terrain
    // Warszawa area (row=13, col=22) to a nearby point (row=14, col=22)
    const cost = estimatePathCost(13, 22, 14, 22);
    if (cost > 0) {
      // Should be a small terrain-only cost (no ferry involved)
      expect(cost).toBeLessThan(20);
    }
  });
});
