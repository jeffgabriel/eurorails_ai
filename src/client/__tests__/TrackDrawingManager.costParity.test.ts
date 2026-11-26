import 'jest-canvas-mock';
import { TrackDrawingManager } from '../components/TrackDrawingManager';
import { mapConfig } from '../config/mapConfig';
import { getWaterCrossingExtraCost } from '../../shared/config/waterCrossings';
import { TERRAIN_BUILD_COSTS } from '../../shared/config/terrainCosts';
import { FullGameState, GridPoint, TerrainType } from '../../shared/types/GameTypes';
import { TrackSegment, PlayerTrackState } from '../../shared/types/TrackTypes';

/**
 * Parity test for issue #307 (shared track-cost module, no behaviour change).
 *
 * `legacyCalculateTrackCost` is a copy of TrackDrawingManager.calculateTrackCost
 * as it was before the refactor. The manager's current implementation (which
 * delegates to src/shared/services/trackBuildCost.ts) must return the same
 * value for every edge of the real map, in several track states.
 */

function legacyIsConnectedPointOfMajorCity(gridPoints: GridPoint[][], point: GridPoint): boolean {
  for (let r = 0; r < gridPoints.length; r++) {
    if (!gridPoints[r]) continue;
    for (let c = 0; c < gridPoints[r].length; c++) {
      const gridPoint = gridPoints[r][c];
      if (!gridPoint?.city || gridPoint.city.type !== TerrainType.MajorCity) continue;
      if (gridPoint.city.connectedPoints?.some(cp => cp.row === point.row && cp.col === point.col)) {
        return true;
      }
    }
  }
  return false;
}

function legacyCalculateTrackCost(
  gridPoints: GridPoint[][],
  playerSegments: TrackSegment[] | undefined,
  currentSegments: TrackSegment[],
  from: GridPoint,
  to: GridPoint,
): number {
  let cost = TERRAIN_BUILD_COSTS[to.terrain];

  const isToMajorCity = to.city?.type === TerrainType.MajorCity || legacyIsConnectedPointOfMajorCity(gridPoints, to);
  const isFromMajorCity = from.city?.type === TerrainType.MajorCity || legacyIsConnectedPointOfMajorCity(gridPoints, from);

  if (isToMajorCity && !isFromMajorCity) {
    const isFirstConnection = !playerSegments?.some(segment =>
      (segment.from.row === to.row && segment.from.col === to.col) ||
      (segment.to.row === to.row && segment.to.col === to.col),
    ) && !currentSegments.some(segment =>
      (segment.from.row === to.row && segment.from.col === to.col) ||
      (segment.to.row === to.row && segment.to.col === to.col),
    );
    if (isFirstConnection) {
      cost = 5;
    }
  }

  if (to.terrain === TerrainType.FerryPort && to.ferryConnection) {
    const ferryConnection = to.ferryConnection;
    const connectedPoints = new Set<string>();
    const addPointsFromSegments = (segments: TrackSegment[]): void => {
      segments.forEach(segment => {
        connectedPoints.add(`${segment.from.row},${segment.from.col}`);
        connectedPoints.add(`${segment.to.row},${segment.to.col}`);
      });
    };
    if (playerSegments) {
      addPointsFromSegments(playerSegments);
    }
    addPointsFromSegments(currentSegments);
    const ferryPoints = new Set([
      `${ferryConnection.connections[0].row},${ferryConnection.connections[0].col}`,
      `${ferryConnection.connections[1].row},${ferryConnection.connections[1].col}`,
    ]);
    const isFirstConnection = !Array.from(ferryPoints).some(point => connectedPoints.has(point));
    cost = isFirstConnection ? ferryConnection.cost : 0;
  }

  cost += getWaterCrossingExtraCost(from, to);
  return cost;
}

function buildGrid(): GridPoint[][] {
  const grid: GridPoint[][] = [];
  for (const point of mapConfig.points) {
    if (!grid[point.row]) grid[point.row] = [];
    grid[point.row][point.col] = point;
  }
  return grid;
}

function neighborsOf(grid: GridPoint[][], point: GridPoint): GridPoint[] {
  const deltas: Array<[number, number]> = point.row % 2 === 0
    ? [[-1, -1], [-1, 0], [0, -1], [0, 1], [1, -1], [1, 0]]
    : [[-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0], [1, 1]];
  const result: GridPoint[] = [];
  for (const [dr, dc] of deltas) {
    const neighbor = grid[point.row + dr]?.[point.col + dc];
    if (neighbor) result.push(neighbor);
  }
  return result;
}

function touching(point: GridPoint): TrackSegment {
  const end = { x: point.x, y: point.y, row: point.row, col: point.col, terrain: point.terrain };
  return { from: end, to: end, cost: 0 };
}

describe('TrackDrawingManager.calculateTrackCost parity with pre-#307 implementation', () => {
  const grid = buildGrid();
  const landPoints = mapConfig.points.filter(p => p.terrain !== TerrainType.Water);
  const majorCityPoints = landPoints.filter(p => p.city?.type === TerrainType.MajorCity);
  const ferryPorts = landPoints.filter(p => p.ferryConnection);

  // Every directed edge whose endpoints are special (city / ferry) or that crosses
  // water, plus a deterministic sample of the remaining plain edges.
  const edges: Array<[GridPoint, GridPoint]> = [];
  let plainCounter = 0;
  for (const from of landPoints) {
    for (const to of neighborsOf(grid, from)) {
      const interesting =
        !!from.city || !!to.city || !!from.ferryConnection || !!to.ferryConnection ||
        to.terrain === TerrainType.Water || getWaterCrossingExtraCost(from, to) > 0;
      if (interesting || plainCounter++ % 5 === 0) {
        edges.push([from, to]);
      }
    }
  }

  // Track that touches every other major-city milepost and one port of every other ferry.
  const touchedMajor = majorCityPoints.filter((_, i) => i % 2 === 0).map(touching);
  // Among the selected ferries, alternate which end is touched (first port, second port,
  // first port, ...) so both "same port" and "far port" already-connected cases are covered.
  const touchedFerry = (mapConfig.ferryConnections ?? [])
    .filter((_, ferryIndex) => ferryIndex % 2 === 0)
    .map((ferry, selectedIndex) => {
      const port = ferry.connections[selectedIndex % 2];
      return touching(grid[port.row][port.col]);
    });
  const someTrack: TrackSegment[] = [...touchedMajor, ...touchedFerry];

  function createManager(): TrackDrawingManager {
    const graphics = {
      setDepth: jest.fn(), lineStyle: jest.fn(), beginPath: jest.fn(), moveTo: jest.fn(),
      lineTo: jest.fn(), strokePath: jest.fn(), fillStyle: jest.fn(), fillCircle: jest.fn(),
      strokeCircle: jest.fn(), setAlpha: jest.fn(), clear: jest.fn(),
    };
    const scene = {
      add: { graphics: () => graphics },
      events: { on: jest.fn(), emit: jest.fn() },
      input: { on: jest.fn(), off: jest.fn() },
      cameras: { main: { getWorldPoint: jest.fn((x: number, y: number) => ({ x, y })) } },
      scale: { width: 1024, height: 768 },
    } as unknown as Phaser.Scene;
    const container = { add: jest.fn() } as unknown as Phaser.GameObjects.Container;
    const gameState = {
      players: [{ id: 'player1', color: '#FF0000' }, { id: 'player2', color: '#0000FF' }],
      currentPlayerIndex: 0,
    } as FullGameState;
    return new TrackDrawingManager(scene, container, gameState, grid);
  }

  function trackState(playerId: string, segments: TrackSegment[]): PlayerTrackState {
    return {
      playerId,
      gameId: 'parity',
      segments,
      totalCost: 0,
      turnBuildCost: 0,
      lastBuildTimestamp: new Date(),
    };
  }

  function expectParity(
    committed: TrackSegment[] | undefined,
    pending: TrackSegment[],
    otherPlayer: TrackSegment[] = [],
  ): void {
    const manager = createManager() as any;
    if (committed) manager.playerTracks.set('player1', trackState('player1', committed));
    if (otherPlayer.length > 0) manager.playerTracks.set('player2', trackState('player2', otherPlayer));
    manager.currentSegments = pending;

    const mismatches: string[] = [];
    for (const [from, to] of edges) {
      const actual: number = manager.calculateTrackCost(from, to);
      const expected = legacyCalculateTrackCost(grid, committed, pending, from, to);
      if (actual !== expected) {
        mismatches.push(`(${from.row},${from.col})->(${to.row},${to.col}): legacy ${expected}, now ${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  }

  it('covers a representative set of real-map edges', () => {
    expect(edges.length).toBeGreaterThan(2000);
    expect(majorCityPoints.length).toBeGreaterThan(50);
    expect(ferryPorts.length).toBe(18);
    expect(edges.some(([from, to]) => getWaterCrossingExtraCost(from, to) === 2)).toBe(true);
    expect(edges.some(([from, to]) => getWaterCrossingExtraCost(from, to) === 3)).toBe(true);
  });

  it('matches with no track state for the current player', () => {
    expectParity(undefined, []);
  });

  it('matches with an empty committed network', () => {
    expectParity([], []);
  });

  it('matches when committed track touches major cities and ferry ports', () => {
    expectParity(someTrack, []);
  });

  it('matches when only pending (uncommitted) segments touch major cities and ferry ports', () => {
    expectParity([], someTrack);
  });

  it('matches when committed and pending segments are split', () => {
    expectParity(touchedMajor, touchedFerry);
  });

  it('ignores other players\' track', () => {
    expectParity([], [], someTrack);
  });
});
