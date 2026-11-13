import { ChatScene } from '../scenes/ChatScene';
import { chatStateService } from '../services/ChatStateService';

// Same approach as ChatScene.whenReady.test.ts: stub the heavy UI builders so the
// real init()/create()/open()/handleResize() control flow runs.
jest.mock('../services/ChatStateService', () => ({
  chatStateService: {
    initialized: true,
    initialize: jest.fn().mockResolvedValue(undefined),
    onMessage: jest.fn(() => jest.fn()),
    onUnreadCount: jest.fn(() => jest.fn()),
    onError: jest.fn(() => jest.fn()),
    onMessageFlagged: jest.fn(() => jest.fn()),
  },
}));

jest.mock('../utils/deviceDiagnostics', () => ({
  diag: { log: jest.fn(), isEnabled: () => false },
}));

const mockedChatState = chatStateService as unknown as Record<string, jest.Mock>;

function createTestableChatScene(width = 1024, height = 700): any {
  const scene = new ChatScene() as any;

  jest.spyOn(scene, 'createBackground').mockImplementation(() => {});
  jest.spyOn(scene, 'createMessagesArea').mockImplementation(() => {});
  jest.spyOn(scene, 'createHeader').mockImplementation(() => {});
  jest.spyOn(scene, 'createInputArea').mockImplementation(() => {});
  jest.spyOn(scene, 'setupChatListeners').mockImplementation(() => {});
  jest.spyOn(scene, 'setupResizeListener').mockImplementation(() => {});
  jest.spyOn(scene, 'setupInputHandlers').mockImplementation(() => {});
  jest.spyOn(scene, 'joinChat').mockResolvedValue(undefined);
  jest.spyOn(scene, 'markVisibleMessagesAsRead').mockImplementation(() => {});

  const container = {
    x: 0,
    setX(x: number) {
      this.x = x;
      return this;
    },
  };
  scene.add = {
    container: jest.fn((x: number) => {
      container.x = x;
      return container;
    }),
  };
  scene.scale = { width, height };
  scene.scene = { restart: jest.fn(), bringToTop: jest.fn() };
  scene.tweens = { add: jest.fn(), killTweensOf: jest.fn() };
  scene.time = { delayedCall: jest.fn((_ms: number, cb: () => void) => cb()) };
  return scene;
}

async function createReady(scene: any): Promise<void> {
  scene.init({ gameId: 'game-1', userId: 'user-1' });
  await scene.create();
}

describe('ChatScene resize handling', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('keeps the closed panel parked off the new right edge when the canvas widens', async () => {
    const scene = createTestableChatScene(1024);
    await createReady(scene);
    expect(scene.container.x).toBe(1024);

    // e.g. closing DevTools
    scene.scale.width = 1400;
    scene.handleResize(1400, 700);

    expect(scene.container.x).toBe(1400);
    expect(scene.scene.restart).not.toHaveBeenCalled();
  });

  it('opening after a resize rebuilds first instead of opening a stale layout', async () => {
    const scene = createTestableChatScene(1024);
    await createReady(scene);

    scene.scale.width = 1400;
    await scene.open();

    expect(scene.isOpen).toBe(false);
    expect(scene.scene.restart).toHaveBeenCalledWith({ gameId: 'game-1', userId: 'user-1', openOnReady: {} });
  });

  it('opens normally when the size has not changed', async () => {
    const scene = createTestableChatScene(1024);
    await createReady(scene);

    await scene.open();

    expect(scene.isOpen).toBe(true);
    expect(scene.scene.restart).not.toHaveBeenCalled();
  });

  it('opens at the end of a rebuilt create(), after isOpen is reset', async () => {
    const scene = createTestableChatScene(1400);
    scene.init({ gameId: 'game-1', userId: 'user-1', openOnReady: {} });
    await scene.create();

    expect(scene.isOpen).toBe(true);
  });

  it('a DM opened after a resize is rebuilt and reopened as the same DM', async () => {
    const scene = createTestableChatScene(1024);
    await createReady(scene);

    scene.scale.width = 1400;
    await scene.openDM('user-2', 'Bob');

    expect(scene.scene.restart).toHaveBeenCalledWith({
      gameId: 'game-1',
      userId: 'user-1',
      openOnReady: { dm: { userId: 'user-2', name: 'Bob' } },
    });
  });

  it('resize while open closes, then rebuilds and reopens', async () => {
    const scene = createTestableChatScene(1024);
    await createReady(scene);
    await scene.open();

    scene.scale.width = 1400;
    scene.handleResize(1400, 700);

    expect(scene.isOpen).toBe(false);
    expect(scene.scene.restart).toHaveBeenCalledWith({ gameId: 'game-1', userId: 'user-1', openOnReady: {} });
  });

  it('re-running chat listener setup replaces the previous listeners', () => {
    const scene = new ChatScene() as any;
    scene.gameId = 'game-1';
    const unsubs: jest.Mock[] = [];
    const track = () => {
      const fn = jest.fn();
      unsubs.push(fn);
      return fn;
    };
    mockedChatState.onUnreadCount.mockImplementation(track);
    mockedChatState.onError.mockImplementation(track);
    mockedChatState.onMessageFlagged.mockImplementation(track);

    scene.setupChatListeners();
    const firstRound = [...unsubs];
    scene.setupChatListeners();

    expect(firstRound).toHaveLength(3);
    firstRound.forEach((unsub) => expect(unsub).toHaveBeenCalledTimes(1));
  });
});
