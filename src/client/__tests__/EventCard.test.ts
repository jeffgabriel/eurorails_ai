/**
 * Unit tests for EventCard and EventCardOverlay Phaser components.
 *
 * Phaser objects cannot be instantiated in Node/JSDOM, so we unit-test the
 * pure logic and verify that the correct scene methods are called with the
 * expected arguments during construction.
 */

import { EventCard as EventCardComponent } from '../components/EventCard';
import { EventCardOverlay } from '../components/EventCardOverlay';
import {
  EventCard,
  EventCardType,
  EventCardDrawnPayload,
} from '../../shared/types/EventCard';

// ---------------------------------------------------------------------------
// Scene mock factory
// ---------------------------------------------------------------------------

function makeText() {
  return {
    setOrigin: jest.fn().mockReturnThis(),
    setStroke: jest.fn().mockReturnThis(),
    setVisible: jest.fn().mockReturnThis(),
    setDepth: jest.fn().mockReturnThis(),
    on: jest.fn().mockReturnThis(),
    destroy: jest.fn(),
  };
}

function makeRectangle() {
  return {
    setOrigin: jest.fn().mockReturnThis(),
    setStrokeStyle: jest.fn().mockReturnThis(),
    setFillStyle: jest.fn().mockReturnThis(),
    setInteractive: jest.fn().mockReturnThis(),
    setDepth: jest.fn().mockReturnThis(),
    on: jest.fn().mockReturnThis(),
    destroy: jest.fn(),
  };
}

function makeTimerEvent(): Phaser.Time.TimerEvent {
  return {
    remove: jest.fn(),
  } as unknown as Phaser.Time.TimerEvent;
}

function makeCamera(width = 1280, height = 720) {
  return { main: { width, height } };
}

function makeScene(overrides: Record<string, unknown> = {}) {
  const timerEvent = makeTimerEvent();

  const scene = {
    add: {
      rectangle: jest.fn().mockReturnValue(makeRectangle()),
      text: jest.fn().mockReturnValue(makeText()),
      existing: jest.fn(),
    },
    cameras: makeCamera(),
    time: {
      addEvent: jest.fn().mockReturnValue(timerEvent),
    },
    ...overrides,
  };

  return { scene, timerEvent };
}

// ---------------------------------------------------------------------------
// ContainerLite mock
// ---------------------------------------------------------------------------

jest.mock('phaser3-rex-plugins/plugins/containerlite.js', () => {
  return class MockContainerLite {
    name = '';
    depth = 0;
    private children: unknown[] = [];

    constructor(
      public scene: unknown,
      public x: number,
      public y: number
    ) {}

    setSize(_w: number, _h: number): this {
      return this;
    }

    setDepth(d: number): this {
      this.depth = d;
      return this;
    }

    add(child: unknown): this {
      this.children.push(child);
      return this;
    }

    getChildren(): unknown[] {
      return this.children;
    }

    destroy(): void {}
  };
});

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

const sampleCard: EventCard = {
  id: 125,
  type: EventCardType.Derailment,
  title: 'Derailment!',
  description: 'All trains within 3 mileposts of Praha lose 1 turn and 1 load.',
  effectConfig: {
    type: EventCardType.Derailment,
    cities: ['Praha'],
    radius: 3,
  },
};

const samplePayload: EventCardDrawnPayload = {
  gameId: 'game-abc',
  card: sampleCard,
  drawingPlayerId: 'player-1',
  drawingPlayerName: 'Alice',
  affectedZone: [],
  affectedPlayerIds: ['player-2', 'player-3'],
  effectSummary: 'Players near Praha derailed.',
  duration: 'persistent',
  timestamp: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// EventCard component tests
// ---------------------------------------------------------------------------

describe('EventCard component', () => {
  it('creates a background rectangle', () => {
    const { scene } = makeScene();
    new EventCardComponent(scene as unknown as Phaser.Scene, 0, 0, sampleCard);

    expect(scene.add.rectangle).toHaveBeenCalledWith(
      0,
      0,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number)
    );
  });

  it('renders card ID in the header text', () => {
    const { scene } = makeScene();
    new EventCardComponent(scene as unknown as Phaser.Scene, 0, 0, sampleCard);

    const textCalls: string[][] = scene.add.text.mock.calls.map(
      (call: unknown[]) => [String(call[2])]
    );
    const headerCall = textCalls.find(([text]) => text.includes('#125'));
    expect(headerCall).toBeDefined();
  });

  it('renders card title in uppercase', () => {
    const { scene } = makeScene();
    new EventCardComponent(scene as unknown as Phaser.Scene, 0, 0, sampleCard);

    const textCalls: string[] = scene.add.text.mock.calls.map(
      (call: unknown[]) => String(call[2])
    );
    const titleCall = textCalls.find(t => t.includes('DERAILMENT!'));
    expect(titleCall).toBeDefined();
  });

  it('renders card description', () => {
    const { scene } = makeScene();
    new EventCardComponent(scene as unknown as Phaser.Scene, 0, 0, sampleCard);

    const textCalls: string[] = scene.add.text.mock.calls.map(
      (call: unknown[]) => String(call[2])
    );
    const descCall = textCalls.find(t =>
      t.includes('All trains within 3 mileposts')
    );
    expect(descCall).toBeDefined();
  });

  it('sets the component name based on card id', () => {
    const { scene } = makeScene();
    const component = new EventCardComponent(
      scene as unknown as Phaser.Scene,
      0,
      0,
      sampleCard
    );
    expect(component.name).toBe('event-card-125');
  });

  it('includes the type icon in the header text', () => {
    const { scene } = makeScene();
    new EventCardComponent(scene as unknown as Phaser.Scene, 0, 0, sampleCard);

    const textCalls: string[] = scene.add.text.mock.calls.map(
      (call: unknown[]) => String(call[2])
    );
    // Derailment uses the ⚠️ icon
    const iconCall = textCalls.find(t => t.includes('⚠️'));
    expect(iconCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// EventCardOverlay component tests
// ---------------------------------------------------------------------------

describe('EventCardOverlay component', () => {
  it('creates a full-screen backdrop rectangle', () => {
    const { scene } = makeScene();
    new EventCardOverlay(
      scene as unknown as Phaser.Scene,
      samplePayload,
      jest.fn()
    );

    // The backdrop uses the full camera width/height
    const rectCalls = scene.add.rectangle.mock.calls;
    const backdropCall = rectCalls.find(
      (call: unknown[]) =>
        call[2] === scene.cameras.main.width &&
        call[3] === scene.cameras.main.height
    );
    expect(backdropCall).toBeDefined();
  });

  it('renders the drawing player name in metadata', () => {
    const { scene } = makeScene();
    new EventCardOverlay(
      scene as unknown as Phaser.Scene,
      samplePayload,
      jest.fn()
    );

    const textCalls: string[] = scene.add.text.mock.calls.map(
      (call: unknown[]) => String(call[2])
    );
    const metaCall = textCalls.find(t => t.includes('Alice'));
    expect(metaCall).toBeDefined();
  });

  it('renders affected player IDs in metadata', () => {
    const { scene } = makeScene();
    new EventCardOverlay(
      scene as unknown as Phaser.Scene,
      samplePayload,
      jest.fn()
    );

    const textCalls: string[] = scene.add.text.mock.calls.map(
      (call: unknown[]) => String(call[2])
    );
    const metaCall = textCalls.find(
      t => t.includes('player-2') && t.includes('player-3')
    );
    expect(metaCall).toBeDefined();
  });

  it('creates a dismiss button that is interactive', () => {
    const { scene } = makeScene();
    new EventCardOverlay(
      scene as unknown as Phaser.Scene,
      samplePayload,
      jest.fn()
    );

    // One of the rectangles should be interactive (the dismiss button bg)
    const allRects = (scene.add.rectangle.mock.results as { value: ReturnType<typeof makeRectangle> }[]);
    const interactiveRect = allRects.find(r => r.value.setInteractive.mock.calls.length > 0);
    expect(interactiveRect).toBeDefined();
  });

  it('calls onDismiss when the dismiss button is clicked', () => {
    const { scene } = makeScene();
    const onDismiss = jest.fn();
    new EventCardOverlay(
      scene as unknown as Phaser.Scene,
      samplePayload,
      onDismiss
    );

    // Find the button rectangle with a pointerdown listener
    const allRects = (scene.add.rectangle.mock.results as { value: ReturnType<typeof makeRectangle> }[]);
    const buttonRect = allRects
      .map(r => r.value)
      .find(rect => rect.setInteractive.mock.calls.length > 0);

    expect(buttonRect).toBeDefined();
    if (!buttonRect) return;

    // Extract the pointerdown handler and invoke it
    const pointerdownCall = (buttonRect.on.mock.calls as unknown[][]).find(
      (call) => call[0] === 'pointerdown'
    );
    expect(pointerdownCall).toBeDefined();
    if (!pointerdownCall) return;

    const fakePointer = { event: { stopPropagation: jest.fn() } };
    (pointerdownCall[1] as (p: unknown) => void)(fakePointer);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('starts the 30-second auto-dismiss timer on creation', () => {
    const { scene } = makeScene();
    new EventCardOverlay(
      scene as unknown as Phaser.Scene,
      samplePayload,
      jest.fn()
    );

    expect(scene.time.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ delay: 30_000 })
    );
  });

  it('calls onDismiss via auto-dismiss timer callback', () => {
    const { scene } = makeScene();
    const onDismiss = jest.fn();
    new EventCardOverlay(
      scene as unknown as Phaser.Scene,
      samplePayload,
      onDismiss
    );

    // Retrieve and invoke the timer callback directly
    const addEventCall = scene.time.addEvent.mock.calls[0][0] as {
      callback: () => void;
      callbackScope: unknown;
    };
    addEventCall.callback.call(addEventCall.callbackScope);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('cancels auto-dismiss timer when dismiss button is clicked', () => {
    const { scene, timerEvent } = makeScene();
    const onDismiss = jest.fn();
    new EventCardOverlay(
      scene as unknown as Phaser.Scene,
      samplePayload,
      onDismiss
    );

    // Simulate dismiss button click
    const allRects = (scene.add.rectangle.mock.results as { value: ReturnType<typeof makeRectangle> }[]);
    const buttonRect = allRects
      .map(r => r.value)
      .find(rect => rect.setInteractive.mock.calls.length > 0);

    if (!buttonRect) throw new Error('Button rect not found');

    const pointerdownCall = (buttonRect.on.mock.calls as unknown[][]).find(
      (call) => call[0] === 'pointerdown'
    );
    if (!pointerdownCall) throw new Error('pointerdown handler not found');

    const fakePointer = { event: { stopPropagation: jest.fn() } };
    (pointerdownCall[1] as (p: unknown) => void)(fakePointer);

    // Timer should have been cleared
    expect((timerEvent as unknown as { remove: jest.Mock }).remove).toHaveBeenCalledWith(false);
  });

  it('sets a high depth value to render above other game objects', () => {
    const { scene } = makeScene();
    const overlay = new EventCardOverlay(
      scene as unknown as Phaser.Scene,
      samplePayload,
      jest.fn()
    );

    expect(overlay.depth).toBeGreaterThanOrEqual(100);
  });
});
