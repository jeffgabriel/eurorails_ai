import { CameraController } from '../components/CameraController';

jest.mock('../utils/deviceDiagnostics', () => ({
  diag: { log: jest.fn(), isEnabled: () => false },
}));

type Handler = (...args: any[]) => void;

function makeEnv() {
  const handlers: Record<string, Handler[]> = {};
  let underPointer: any[] = [];
  const camera = {
    zoom: 1,
    scrollX: 500,
    scrollY: 400,
    width: 800,
    height: 600,
    originX: 0.5,
    originY: 0.5,
    dirty: false,
    setBounds: jest.fn(),
    setZoom(z: number) {
      this.zoom = z;
    },
  };
  const scene: any = {
    cameras: { main: camera },
    input: {
      on: (ev: string, fn: Handler) => {
        (handlers[ev] ||= []).push(fn);
      },
      hitTestPointer: () => underPointer,
    },
    game: { events: { on: jest.fn() } },
  };
  const mapContainer: any = { setInteractive: jest.fn(), on: jest.fn(), parentContainer: null };
  const boardContainer: any = { parentContainer: mapContainer };
  // Per-milepost coordinate hit zone: nested inside the map (mapContainer > boardContainer > zone)
  const milepostZone: any = { type: 'Zone', parentContainer: boardContainer };
  const uiButton: any = { type: 'Text', parentContainer: { parentContainer: null } };

  const emit = (ev: string, ...args: any[]): void => (handlers[ev] || []).forEach((fn) => fn(...args));
  const setUnderPointer = (objs: any[]): void => {
    underPointer = objs;
  };
  return { scene, camera, mapContainer, milepostZone, uiButton, emit, setUnderPointer };
}

describe('CameraController treats objects inside the map as map, not UI', () => {
  const gameState: any = { id: 'g', players: [], cameraState: { zoom: 1, scrollX: 500, scrollY: 400 } };
  let nowSpy: jest.SpyInstance<number, []>;
  let now: number;

  beforeAll(() => {
    (global as any).requestAnimationFrame = (cb: () => void) => cb();
  });

  beforeEach(() => {
    now = 1_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    jest.clearAllMocks();
  });

  function setup() {
    const env = makeEnv();
    const controller = new CameraController(env.scene, 4000, 3000, gameState);
    jest.spyOn(controller, 'saveCameraState').mockResolvedValue(undefined);
    controller.setMapContainer(env.mapContainer);
    controller.setupCamera();
    return env;
  }

  it('wheel-zooms when the pointer is over a milepost hit zone', () => {
    const { camera, milepostZone, emit } = setup();
    emit('wheel', { x: 400, y: 300 }, [milepostZone], 0, -100);
    expect(camera.zoom).toBeCloseTo(1.05);
  });

  it('wheel-zooms when the pointer is over the bare map container', () => {
    const { camera, mapContainer, emit } = setup();
    emit('wheel', { x: 400, y: 300 }, [mapContainer], 0, -100);
    expect(camera.zoom).toBeCloseTo(1.05);
  });

  it('still skips wheel zoom over real UI elements', () => {
    const { camera, uiButton, emit } = setup();
    emit('wheel', { x: 400, y: 300 }, [uiButton], 0, -100);
    expect(camera.zoom).toBe(1);
  });

  it('starts a camera drag when the press lands on a milepost hit zone', () => {
    const { camera, mapContainer, milepostZone, emit, setUnderPointer } = setup();
    setUnderPointer([milepostZone, mapContainer]);
    emit('pointerdown', { x: 400, y: 300 });
    now += 100;
    emit('pointermove', { x: 350, y: 300 });
    expect(camera.scrollX).toBe(550);
  });

  it('does not start a camera drag when the press lands on UI', () => {
    const { camera, uiButton, emit, setUnderPointer } = setup();
    setUnderPointer([uiButton]);
    emit('pointerdown', { x: 400, y: 300 });
    now += 100;
    emit('pointermove', { x: 350, y: 300 });
    expect(camera.scrollX).toBe(500);
  });
});
