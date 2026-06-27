/**
 * Unit tests for MapHighlighter.
 *
 * All Phaser objects are mocked so these tests run in Node/JSDOM without a canvas.
 */
import { MapHighlighter } from '../components/MapHighlighter';
import { EventCardType } from '../../shared/types/EventCard';

// ---------------------------------------------------------------------------
// Phaser mock helpers
// ---------------------------------------------------------------------------

function makeTween() {
  return {
    stop: jest.fn(),
    onComplete: null as null | (() => void),
  };
}

function makeGraphics() {
  return {
    fillStyle: jest.fn().mockReturnThis(),
    fillCircle: jest.fn().mockReturnThis(),
    setAlpha: jest.fn().mockReturnThis(),
    destroy: jest.fn(),
    alpha: 1,
  };
}

function makeTweenInstance(onComplete?: () => void) {
  return { stop: jest.fn(), _onComplete: onComplete };
}

function makeScene() {
  const tweenAdd = jest.fn().mockImplementation((config: {
    onComplete?: () => void;
    targets: unknown;
    alpha: number;
    duration: number;
    ease: string;
  }) => {
    const t = makeTweenInstance(config.onComplete);
    if (config.onComplete) {
      // Simulate immediate completion for tests
      config.onComplete();
    }
    return t;
  });

  const graphicsAdd = jest.fn().mockImplementation(() => makeGraphics());

  return {
    scene: {
      add: {
        graphics: graphicsAdd,
      },
      tweens: {
        add: tweenAdd,
      },
    },
    tweenAdd,
    graphicsAdd,
  };
}

function makeContainer() {
  return {
    add: jest.fn(),
    remove: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Zone fixtures
// ---------------------------------------------------------------------------
const zone1 = ['10,5', '10,6', '11,5'];
const zone2 = ['20,10', '20,11'];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MapHighlighter', () => {
  let highlighter: MapHighlighter;
  let sceneFixture: ReturnType<typeof makeScene>;
  let container: ReturnType<typeof makeContainer>;

  beforeEach(() => {
    sceneFixture = makeScene();
    container = makeContainer();
    highlighter = new MapHighlighter(
      sceneFixture.scene as unknown as Phaser.Scene,
      container as unknown as Phaser.GameObjects.Container
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── activate ──────────────────────────────────────────────────────────────

  describe('activate', () => {
    it('creates a Graphics object and adds it to the map container', () => {
      highlighter.activate(zone1, EventCardType.Derailment, 125);

      expect(sceneFixture.graphicsAdd).toHaveBeenCalledTimes(1);
      expect(container.add).toHaveBeenCalledTimes(1);
    });

    it('draws one circle per zone milepost', () => {
      highlighter.activate(zone1, EventCardType.Derailment, 125);

      const gfx = sceneFixture.graphicsAdd.mock.results[0].value as ReturnType<typeof makeGraphics>;
      expect(gfx.fillCircle).toHaveBeenCalledTimes(zone1.length);
    });

    it('uses red color for Derailment events', () => {
      highlighter.activate(zone1, EventCardType.Derailment, 125);

      const gfx = sceneFixture.graphicsAdd.mock.results[0].value as ReturnType<typeof makeGraphics>;
      const [color] = (gfx.fillStyle.mock.calls[0] as [number, number]);
      expect(color).toBe(0xff0000);
    });

    it('uses blue color for Flood events', () => {
      highlighter.activate(zone1, EventCardType.Flood, 126);

      const gfx = sceneFixture.graphicsAdd.mock.results[0].value as ReturnType<typeof makeGraphics>;
      const [color] = (gfx.fillStyle.mock.calls[0] as [number, number]);
      expect(color).toBe(0x0000ff);
    });

    it('uses white color for Snow events', () => {
      highlighter.activate(zone1, EventCardType.Snow, 130);

      const gfx = sceneFixture.graphicsAdd.mock.results[0].value as ReturnType<typeof makeGraphics>;
      const [color] = (gfx.fillStyle.mock.calls[0] as [number, number]);
      expect(color).toBe(0xffffff);
    });

    it('uses gold color for Strike events', () => {
      highlighter.activate(zone1, EventCardType.Strike, 121);

      const gfx = sceneFixture.graphicsAdd.mock.results[0].value as ReturnType<typeof makeGraphics>;
      const [color] = (gfx.fillStyle.mock.calls[0] as [number, number]);
      expect(color).toBe(0xffd700);
    });

    it('starts a fade-in tween from alpha 0', () => {
      highlighter.activate(zone1, EventCardType.Derailment, 125);

      const gfx = sceneFixture.graphicsAdd.mock.results[0].value as ReturnType<typeof makeGraphics>;
      expect(gfx.setAlpha).toHaveBeenCalledWith(0);
      expect(sceneFixture.tweenAdd).toHaveBeenCalledWith(
        expect.objectContaining({ alpha: 0.3, duration: expect.any(Number) })
      );
    });

    it('replaces an existing highlight for the same cardId', () => {
      highlighter.activate(zone1, EventCardType.Derailment, 125);
      // First graphics object
      const firstGfx = sceneFixture.graphicsAdd.mock.results[0].value as ReturnType<typeof makeGraphics>;

      highlighter.activate(zone2, EventCardType.Flood, 125);

      // Old graphics should be destroyed immediately (skip fade on replace)
      expect(firstGfx.destroy).toHaveBeenCalled();
      // A second graphics object should now be active
      expect(sceneFixture.graphicsAdd).toHaveBeenCalledTimes(2);
    });

    it('tracks the highlight as active after activation', () => {
      highlighter.activate(zone1, EventCardType.Derailment, 125);
      expect(highlighter.hasHighlight(125)).toBe(true);
    });

    it('skips malformed zone keys without throwing', () => {
      const badZone = ['invalid', '', '10,abc', '10,6'];
      expect(() =>
        highlighter.activate(badZone, EventCardType.Derailment, 125)
      ).not.toThrow();
    });
  });

  // ── deactivate ────────────────────────────────────────────────────────────

  describe('deactivate', () => {
    it('removes the highlight entry after deactivation', () => {
      highlighter.activate(zone1, EventCardType.Derailment, 125);
      highlighter.deactivate(125);

      expect(highlighter.hasHighlight(125)).toBe(false);
    });

    it('destroys the graphics object after the fade-out completes', () => {
      highlighter.activate(zone1, EventCardType.Derailment, 125);
      const gfx = sceneFixture.graphicsAdd.mock.results[0].value as ReturnType<typeof makeGraphics>;

      highlighter.deactivate(125);

      // Our mock scene immediately calls onComplete, so destroy should be called
      expect(gfx.destroy).toHaveBeenCalled();
    });

    it('starts a fade-out tween targeting alpha 0', () => {
      highlighter.activate(zone1, EventCardType.Derailment, 125);
      // Clear previous tween calls (fade-in)
      sceneFixture.tweenAdd.mockClear();

      highlighter.deactivate(125);

      expect(sceneFixture.tweenAdd).toHaveBeenCalledWith(
        expect.objectContaining({ alpha: 0, duration: expect.any(Number) })
      );
    });

    it('does nothing if no highlight exists for the given cardId', () => {
      expect(() => highlighter.deactivate(999)).not.toThrow();
    });

    it('does not affect highlights for other card IDs', () => {
      highlighter.activate(zone1, EventCardType.Derailment, 125);
      highlighter.activate(zone2, EventCardType.Flood, 126);

      highlighter.deactivate(125);

      expect(highlighter.hasHighlight(125)).toBe(false);
      expect(highlighter.hasHighlight(126)).toBe(true);
    });
  });

  // ── clear ─────────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('removes all highlights', () => {
      highlighter.activate(zone1, EventCardType.Derailment, 125);
      highlighter.activate(zone2, EventCardType.Flood, 126);

      highlighter.clear();

      expect(highlighter.hasHighlight(125)).toBe(false);
      expect(highlighter.hasHighlight(126)).toBe(false);
    });

    it('destroys all graphics objects immediately', () => {
      highlighter.activate(zone1, EventCardType.Derailment, 125);
      highlighter.activate(zone2, EventCardType.Flood, 126);

      const gfx1 = sceneFixture.graphicsAdd.mock.results[0].value as ReturnType<typeof makeGraphics>;
      const gfx2 = sceneFixture.graphicsAdd.mock.results[1].value as ReturnType<typeof makeGraphics>;

      highlighter.clear();

      expect(gfx1.destroy).toHaveBeenCalled();
      expect(gfx2.destroy).toHaveBeenCalled();
    });
  });

  // ── z-ordering ────────────────────────────────────────────────────────────

  describe('z-ordering', () => {
    it('adds the graphics object to the map container (not the root scene)', () => {
      highlighter.activate(zone1, EventCardType.Derailment, 125);
      // container.add should be called, not scene.add (beyond creating the graphics)
      expect(container.add).toHaveBeenCalledTimes(1);
    });
  });
});
