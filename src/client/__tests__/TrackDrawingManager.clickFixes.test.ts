import { TrackDrawingManager } from '../components/TrackDrawingManager';
import { MapRenderer } from '../components/MapRenderer';
import { FullGameState, GridPoint, TerrainType, TrainType } from '../../shared/types/GameTypes';

jest.mock('../utils/deviceDiagnostics', () => ({
  diag: { log: jest.fn(), isEnabled: () => false },
}));

const H = MapRenderer.HORIZONTAL_SPACING;
const V = MapRenderer.VERTICAL_SPACING;
const M = MapRenderer.GRID_MARGIN;

/** Grid laid out exactly like the real map (odd rows offset by half a column). */
function buildGrid(rows: number, cols: number): GridPoint[][] {
  const grid: GridPoint[][] = [];
  for (let row = 0; row < rows; row++) {
    grid[row] = [];
    for (let col = 0; col < cols; col++) {
      const isCity = row === 2 && col === 2;
      grid[row][col] = {
        id: `${row}-${col}`,
        x: M + col * H + (row % 2 === 1 ? H / 2 : 0),
        y: M + row * V,
        row,
        col,
        terrain: isCity ? TerrainType.MajorCity : TerrainType.Clear,
        ...(isCity ? { city: { type: TerrainType.MajorCity, name: 'Test City', availableLoads: [] } } : {}),
      } as GridPoint;
    }
  }
  return grid;
}

function makeGraphics() {
  return {
    setDepth: jest.fn(),
    lineStyle: jest.fn(),
    beginPath: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    strokePath: jest.fn(),
    clear: jest.fn(),
    fillStyle: jest.fn(),
    fillCircle: jest.fn(),
    strokeCircle: jest.fn(),
    setAlpha: jest.fn(),
    destroy: jest.fn(),
  };
}

describe('TrackDrawingManager click fixes', () => {
  let graphics: ReturnType<typeof makeGraphics>[];
  let tween: { stop: jest.Mock };
  let scene: any;
  let manager: TrackDrawingManager;
  let grid: GridPoint[][];

  const gameState = {
    id: 'g',
    players: [
      {
        id: 'p1',
        name: 'P1',
        color: '#FF0000',
        money: 50,
        trainType: TrainType.Freight,
        turnNumber: 3,
        trainState: { position: null, movementHistory: [], remainingMovement: 9, loads: [] },
        hand: [],
      },
    ],
    currentPlayerIndex: 0,
    status: 'active',
    maxPlayers: 6,
  } as unknown as FullGameState;

  const pointerAt = (p: { x: number; y: number }) => ({ x: p.x, y: p.y, leftButtonDown: () => true, event: null });

  /** Startglow graphics is the third graphics object created (drawing, preview, glow). */
  const glow = () => graphics[2];

  beforeEach(() => {
    jest.useFakeTimers();
    graphics = [];
    tween = { stop: jest.fn() };
    scene = {
      add: {
        graphics: () => {
          const g = makeGraphics();
          graphics.push(g);
          return g;
        },
      },
      events: { on: jest.fn(), emit: jest.fn() },
      input: { on: jest.fn(), off: jest.fn(), keyboard: null },
      cameras: { main: { zoom: 1, getWorldPoint: jest.fn((x: number, y: number) => ({ x, y })) } },
      scale: { width: 1280, height: 2000 },
      tweens: { add: jest.fn(() => tween) },
    };
    grid = buildGrid(6, 6);
    manager = new TrackDrawingManager(scene, { add: jest.fn() } as any, gameState, grid);
    (manager as any).isDrawingMode = true;
    (manager as any).updateValidConnectionPoints = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('hover cache (stale preview)', () => {
    it('recomputes the preview after the cursor leaves a milepost and returns to it', () => {
      const start = grid[2][2];
      const target = grid[2][3];
      (manager as any).lastClickedPoint = start;
      const findPreviewPath = jest
        .spyOn(manager as any, 'findPreviewPath')
        .mockImplementation(() => [start, target]);
      jest.spyOn(manager as any, 'calculateTrackCost').mockReturnValue(1);

      const hover = (p: { x: number; y: number }) => {
        (manager as any).handleDrawingHover(pointerAt(p));
        jest.advanceTimersByTime(20);
      };

      hover(target);
      expect((manager as any).previewPath).toHaveLength(2);

      // Drift off the milepost: centroid of start, target and the milepost below them
      // is ~29px from each, beyond the 25px drawing snap radius.
      hover({ x: (start.x + target.x) / 2, y: start.y + V / 3 });
      expect((manager as any).previewPath).toHaveLength(0);

      // Back onto the same milepost: must rebuild, not short-circuit on the stale cache
      hover(target);
      expect(findPreviewPath).toHaveBeenCalledTimes(2);
      expect((manager as any).previewPath).toHaveLength(2);
    });
  });

  describe('snap radius', () => {
    it('drawing accepts a click 22px from a milepost; the default radius does not', () => {
      const p = grid[2][2];
      expect(manager.getGridPointAtPosition(p.x + 22, p.y)).toBeNull();
      expect(manager.getGridPointAtPosition(p.x + 22, p.y, TrackDrawingManager.DRAW_SNAP_RADIUS)).toBe(p);
    });
  });

  describe('bottom UI exclusion', () => {
    it('uses the provided bottom UI height instead of a fixed 200px', () => {
      scene.scale.height = 665;
      manager.setBottomUiHeightProvider(() => 50);
      // Point the start city near y=470 by moving the camera mapping
      const city = grid[2][2];
      scene.cameras.main.getWorldPoint = jest.fn(() => ({ x: city.x, y: city.y }));

      (manager as any).handleDrawingClick(pointerAt({ x: 449, y: 474 }));
      expect((manager as any).lastClickedPoint).toBe(city);
    });

    it('still ignores clicks over the bottom UI', () => {
      scene.scale.height = 665;
      manager.setBottomUiHeightProvider(() => 50);
      (manager as any).handleDrawingClick(pointerAt({ x: 449, y: 640 }));
      expect((manager as any).lastClickedPoint).toBeNull();
    });
  });

  describe('drawing hints', () => {
    it('explains a rejected start click, with a cooldown', () => {
      const hint = jest.fn();
      manager.setOnDrawingHint(hint);
      const notOnNetwork = grid[4][4];

      (manager as any).handleDrawingClick(pointerAt(notOnNetwork));
      (manager as any).handleDrawingClick(pointerAt(notOnNetwork));
      expect(hint).toHaveBeenCalledTimes(1);
      expect(hint.mock.calls[0][0]).toMatch(/major city/i);

      jest.setSystemTime(Date.now() + TrackDrawingManager.HINT_COOLDOWN_MS + 1);
      (manager as any).handleDrawingClick(pointerAt(notOnNetwork));
      expect(hint).toHaveBeenCalledTimes(2);
    });
  });

  describe('start milepost glow', () => {
    it('glows when a valid start is selected', () => {
      const city = grid[2][2];
      (manager as any).handleDrawingClick(pointerAt(city));
      expect(glow().fillCircle).toHaveBeenCalledWith(city.x, city.y, expect.any(Number));
      expect(scene.tweens.add).toHaveBeenCalledWith(expect.objectContaining({ targets: glow(), repeat: -1 }));
    });

    it('does not glow for a rejected start', () => {
      (manager as any).handleDrawingClick(pointerAt(grid[4][4]));
      expect(glow().fillCircle).not.toHaveBeenCalled();
    });

    it('clears when a segment is committed', () => {
      const city = grid[2][2];
      const target = grid[2][3];
      (manager as any).handleDrawingClick(pointerAt(city));
      glow().clear.mockClear();

      (manager as any).previewPath = [city, target];
      jest.spyOn(manager as any, 'isValidCost').mockReturnValue(true);
      jest.spyOn(manager as any, 'calculateTrackCost').mockReturnValue(1);
      jest.spyOn(manager as any, 'drawTrackSegment').mockImplementation(() => undefined);
      (manager as any).handleDrawingClick(pointerAt(target));

      expect(tween.stop).toHaveBeenCalled();
      expect(glow().clear).toHaveBeenCalled();
    });

    it('clears when drawing mode is turned off', () => {
      (manager as any).handleDrawingClick(pointerAt(grid[2][2]));
      glow().clear.mockClear();
      (manager as any).cleanupDrawingMode();
      expect(glow().clear).toHaveBeenCalled();
      expect((manager as any).lastClickedPoint).toBeNull();
    });
  });
});
