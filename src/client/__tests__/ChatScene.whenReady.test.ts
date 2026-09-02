import { ChatScene } from '../scenes/ChatScene';

// ChatScene's create() drives real Phaser rendering (this.add.*, DOM input
// elements, etc.) — out of scope for a unit test (see ChatScene.test.ts).
// Here we stub only the heavy UI-construction methods so the REAL init()/
// create()/whenReady() control flow under test (the thing this task changed)
// still runs end to end.
jest.mock('../services/ChatStateService', () => ({
  chatStateService: {
    initialized: true,
    initialize: jest.fn().mockResolvedValue(undefined),
  },
}));

function createTestableChatScene(): ChatScene {
  const scene = new ChatScene();

  jest.spyOn(scene as any, 'createBackground').mockImplementation(() => {});
  jest.spyOn(scene as any, 'createMessagesArea').mockImplementation(() => {});
  jest.spyOn(scene as any, 'createHeader').mockImplementation(() => {});
  jest.spyOn(scene as any, 'createInputArea').mockImplementation(() => {});
  jest.spyOn(scene as any, 'setupChatListeners').mockImplementation(() => {});
  jest.spyOn(scene as any, 'setupResizeListener').mockImplementation(() => {});
  jest.spyOn(scene as any, 'setupInputHandlers').mockImplementation(() => {});
  jest.spyOn(scene as any, 'joinChat').mockResolvedValue(undefined);

  (scene as any).add = { container: jest.fn().mockReturnValue({}) };
  (scene as any).scale = { width: 1024 };

  return scene;
}

describe('ChatScene.whenReady', () => {
  it('returns a Promise even before init()/create() have run', () => {
    const scene = createTestableChatScene();

    const result = scene.whenReady();

    expect(result).toBeInstanceOf(Promise);
  });

  it('resolves only after create() has finished, not before', async () => {
    const scene = createTestableChatScene();
    scene.init({ gameId: 'game-1', userId: 'user-1' });

    let resolved = false;
    scene.whenReady().then(() => {
      resolved = true;
    });

    // Give any wrongly-early resolution a chance to flush before create() runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect((scene as any).isReady).toBe(false);

    await scene.create();
    await Promise.resolve();

    expect(resolved).toBe(true);
    expect((scene as any).isReady).toBe(true);
  });

  it('creates a fresh promise on each init(), independent of prior lifecycles', async () => {
    const scene = createTestableChatScene();

    scene.init({ gameId: 'game-1', userId: 'user-1' });
    await scene.create();
    await expect(scene.whenReady()).resolves.toBeUndefined();

    // Re-entry / hot-reload: a second init() must produce a promise that is
    // NOT already resolved, even though the first lifecycle's was.
    scene.init({ gameId: 'game-1', userId: 'user-1' });
    expect((scene as any).isReady).toBe(false);

    let secondResolved = false;
    scene.whenReady().then(() => {
      secondResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    await scene.create();
    await Promise.resolve();
    expect(secondResolved).toBe(true);
  });

  it('resolves waiters that called whenReady() before the first init()', async () => {
    const scene = createTestableChatScene();

    // e.g. GameScene.openChatDM() awaiting readiness before ChatScene launches.
    let earlyResolved = false;
    scene.whenReady().then(() => {
      earlyResolved = true;
    });

    scene.init({ gameId: 'game-1', userId: 'user-1' });
    await Promise.resolve();
    await Promise.resolve();
    expect(earlyResolved).toBe(false);

    await scene.create();
    await Promise.resolve();
    expect(earlyResolved).toBe(true);
  });

  it('keeps isReady set to true after create(), for backward-compatible callers', async () => {
    const scene = createTestableChatScene();
    scene.init({ gameId: 'game-1', userId: 'user-1' });

    expect((scene as any).isReady).toBe(false);
    await scene.create();
    expect((scene as any).isReady).toBe(true);
  });
});
