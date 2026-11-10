import { CameraController } from '../components/CameraController';

jest.mock('../utils/deviceDiagnostics', () => ({
  diag: { log: jest.fn(), isEnabled: () => false },
}));

type Handler = (...args: any[]) => void;

interface FakePointer {
  x: number;
  y: number;
  isDown: boolean;
}

function makeScene(withSecondTouch: boolean) {
  const handlers: Record<string, Handler[]> = {};
  const camera = {
    zoom: 1,
    scrollX: 0,
    scrollY: 0,
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
  const pointer1: FakePointer = { x: 0, y: 0, isDown: false };
  const pointer2: FakePointer | undefined = withSecondTouch ? { x: 0, y: 0, isDown: false } : undefined;
  const scene: any = {
    cameras: { main: camera },
    input: {
      on: (ev: string, fn: Handler) => {
        (handlers[ev] ||= []).push(fn);
      },
      hitTestPointer: () => [],
      pointer1,
      pointer2,
    },
    game: { events: { on: jest.fn() } },
  };
  const emit = (ev: string, ...args: any[]): void => (handlers[ev] || []).forEach((fn) => fn(...args));
  return { scene, camera, pointer1, pointer2, emit };
}

/** Inverse of Phaser's camera transform, as used by CameraController. */
function worldAt(camera: any, sx: number, sy: number): { x: number; y: number } {
  const ox = camera.width * camera.originX;
  const oy = camera.height * camera.originY;
  return {
    x: (sx - ox) / camera.zoom + camera.scrollX + ox,
    y: (sy - oy) / camera.zoom + camera.scrollY + oy,
  };
}

describe('CameraController pinch zoom', () => {
  const gameState: any = { id: 'g', players: [], cameraState: { zoom: 1, scrollX: 500, scrollY: 400 } };

  beforeAll(() => {
    (global as any).requestAnimationFrame = (cb: () => void) => cb();
  });

  function setup(withSecondTouch: boolean) {
    const env = makeScene(withSecondTouch);
    const controller = new CameraController(env.scene, 4000, 3000, gameState);
    const saveSpy = jest.spyOn(controller, 'saveCameraState').mockResolvedValue(undefined);
    controller.setupCamera();
    return { ...env, controller, saveSpy };
  }

  it('zooms in when two fingers spread, keeping the midpoint anchored', () => {
    const { camera, pointer1, pointer2, emit, saveSpy } = setup(true);
    const mid = { x: 400, y: 300 };
    pointer1.isDown = true;
    Object.assign(pointer1, { x: 350, y: 300 });
    emit('pointerdown', pointer1);
    pointer2!.isDown = true;
    Object.assign(pointer2!, { x: 450, y: 300 });
    emit('pointerdown', pointer2);

    const anchorBefore = worldAt(camera, mid.x, mid.y);

    // Spread fingers to double the distance
    Object.assign(pointer1, { x: 300 });
    Object.assign(pointer2!, { x: 500 });
    emit('pointermove', pointer2);

    expect(camera.zoom).toBeCloseTo(2.0);
    const anchorAfter = worldAt(camera, mid.x, mid.y);
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y);

    // Lift one finger: pinch ends and camera state is saved once
    pointer2!.isDown = false;
    emit('pointerup', pointer2);
    expect(saveSpy).toHaveBeenCalledTimes(1);

    // The remaining finger does not pan until it is lifted and pressed again
    const scrollX = camera.scrollX;
    Object.assign(pointer1, { x: 100 });
    emit('pointermove', pointer1);
    expect(camera.scrollX).toBe(scrollX);
  });

  it('clamps pinch zoom to the max zoom', () => {
    const { camera, pointer1, pointer2, emit } = setup(true);
    pointer1.isDown = true;
    Object.assign(pointer1, { x: 390, y: 300 });
    emit('pointerdown', pointer1);
    pointer2!.isDown = true;
    Object.assign(pointer2!, { x: 410, y: 300 });
    emit('pointerdown', pointer2);

    Object.assign(pointer1, { x: 0 });
    Object.assign(pointer2!, { x: 800 });
    emit('pointermove', pointer2);
    expect(camera.zoom).toBe(2.0);
  });

  it('mouse-only devices (no second touch pointer) keep normal drag panning', () => {
    const { camera, pointer1, emit } = setup(false);
    const mouse = { x: 400, y: 300, isDown: true };
    emit('pointerdown', mouse);
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(Date.now() + 1000);
    Object.assign(mouse, { x: 300 });
    emit('pointermove', mouse);
    nowSpy.mockRestore();

    expect(camera.zoom).toBe(1);
    expect(camera.scrollX).toBe(600); // 500 - (-100 / zoom 1)
    expect(pointer1.isDown).toBe(false);
  });
});
