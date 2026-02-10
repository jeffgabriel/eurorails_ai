import { LeaderboardManager } from '../../components/LeaderboardManager';
import { GameState, Player, TrainType, TrainState } from '../../../shared/types/GameTypes';

// --- Phaser Mocks ---

function createMockText(x: number, y: number, text: string): any {
  const obj: any = {
    x,
    y,
    text,
    type: 'Text',
    width: text.length * 8, // approximate width
    setOrigin: jest.fn().mockReturnThis(),
    setInteractive: jest.fn().mockReturnThis(),
    setScale: jest.fn().mockReturnThis(),
    setAlpha: jest.fn().mockReturnThis(),
    on: jest.fn().mockReturnThis(),
    destroy: jest.fn(),
  };
  return obj;
}

function createMockRectangle(): any {
  return {
    type: 'Rectangle',
    setOrigin: jest.fn().mockReturnThis(),
    setInteractive: jest.fn().mockReturnThis(),
    setFillStyle: jest.fn().mockReturnThis(),
    setAlpha: jest.fn().mockReturnThis(),
    on: jest.fn().mockReturnThis(),
    destroy: jest.fn(),
  };
}

function createMockContainer(): any {
  const items: any[] = [];
  return {
    type: 'Container',
    add: jest.fn((objs: any[]) => {
      if (Array.isArray(objs)) items.push(...objs);
      else items.push(objs);
    }),
    removeAll: jest.fn(() => { items.length = 0; }),
    getAll: jest.fn(() => items),
    destroy: jest.fn(),
    _items: items,
  };
}

const textObjects: any[] = [];
const rectangleObjects: any[] = [];

function createMockScene(): any {
  textObjects.length = 0;
  rectangleObjects.length = 0;

  return {
    add: {
      text: jest.fn((x: number, y: number, text: string, _style?: any) => {
        const obj = createMockText(x, y, text);
        textObjects.push(obj);
        return obj;
      }),
      rectangle: jest.fn((..._args: any[]) => {
        const obj = createMockRectangle();
        rectangleObjects.push(obj);
        return obj;
      }),
      container: jest.fn(() => createMockContainer()),
    },
    scale: { width: 800 },
    tweens: {
      add: jest.fn(),
      killTweensOf: jest.fn(),
    },
    time: {
      delayedCall: jest.fn(),
    },
    events: {
      emit: jest.fn(),
    },
  };
}

// --- Test Helpers ---

function makeTrainState(): TrainState {
  return {
    position: null,
    remainingMovement: 9,
    movementHistory: [],
    loads: [],
  };
}

function makeHumanPlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 'human-1',
    userId: 'user-1',
    name: 'Alice',
    color: '#FF0000',
    money: 50,
    trainType: TrainType.Freight,
    turnNumber: 1,
    trainState: makeTrainState(),
    hand: [],
    ...overrides,
  };
}

function makeBotPlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 'bot-1',
    name: 'Bot Alpha',
    color: '#0000FF',
    money: 50,
    trainType: TrainType.Freight,
    turnNumber: 1,
    trainState: makeTrainState(),
    hand: [],
    isBot: true,
    botConfig: { archetype: 'backbone_builder', skillLevel: 'hard' },
    ...overrides,
  };
}

function makeGameState(players: Player[], currentPlayerIndex = 0): GameState {
  return {
    id: 'game-1',
    players,
    currentPlayerIndex,
    status: 'active',
    maxPlayers: 6,
  };
}

// --- Tests ---

describe('LeaderboardManager - Bot Display', () => {
  let mockScene: any;
  let targetContainer: any;

  beforeEach(() => {
    mockScene = createMockScene();
    targetContainer = createMockContainer();
  });

  it('should render bot icon (🤖) for bot players', () => {
    const gameState = makeGameState([makeHumanPlayer(), makeBotPlayer()]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    lm.update(targetContainer);

    const botIconTexts = textObjects.filter((t) => t.text === '\u{1F916}');
    expect(botIconTexts).toHaveLength(1);
  });

  it('should NOT render bot icon for human players', () => {
    const gameState = makeGameState([makeHumanPlayer(), makeHumanPlayer({ id: 'human-2', name: 'Bob' })]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    lm.update(targetContainer);

    const botIconTexts = textObjects.filter((t) => t.text === '\u{1F916}');
    expect(botIconTexts).toHaveLength(0);
  });

  it('should render archetype badge for bot players with botConfig', () => {
    const gameState = makeGameState([makeBotPlayer({ botConfig: { archetype: 'freight_optimizer', skillLevel: 'medium' } })]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    lm.update(targetContainer);

    const badgeTexts = textObjects.filter((t) => t.text === 'FO');
    expect(badgeTexts).toHaveLength(1);
  });

  it('should render different abbreviation per archetype', () => {
    const archetypes = [
      { archetype: 'backbone_builder', expected: 'BB' },
      { archetype: 'trunk_sprinter', expected: 'TS' },
      { archetype: 'continental_connector', expected: 'CC' },
      { archetype: 'opportunist', expected: 'OP' },
    ];

    for (const { archetype, expected } of archetypes) {
      mockScene = createMockScene();
      targetContainer = createMockContainer();
      const gameState = makeGameState([makeBotPlayer({ id: `bot-${archetype}`, botConfig: { archetype, skillLevel: 'easy' } })]);
      const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
      lm.update(targetContainer);

      const badgeTexts = textObjects.filter((t) => t.text === expected);
      expect(badgeTexts).toHaveLength(1);
    }
  });

  it('should render brain icon (🧠) for bot players', () => {
    const gameState = makeGameState([makeHumanPlayer(), makeBotPlayer()]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    lm.update(targetContainer);

    const brainTexts = textObjects.filter((t) => t.text === '\u{1F9E0}');
    expect(brainTexts).toHaveLength(1);
  });

  it('should NOT render brain icon for human players', () => {
    const gameState = makeGameState([makeHumanPlayer()]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    lm.update(targetContainer);

    const brainTexts = textObjects.filter((t) => t.text === '\u{1F9E0}');
    expect(brainTexts).toHaveLength(0);
  });

  it('should make brain icon interactive', () => {
    const gameState = makeGameState([makeBotPlayer()]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    lm.update(targetContainer);

    const brainTexts = textObjects.filter((t) => t.text === '\u{1F9E0}');
    expect(brainTexts).toHaveLength(1);
    expect(brainTexts[0].setInteractive).toHaveBeenCalledWith({ useHandCursor: true });
  });

  it('should call onBrainClick callback when brain icon is clicked', () => {
    const gameState = makeGameState([makeBotPlayer({ id: 'bot-99' })]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    const brainClickHandler = jest.fn();
    lm.setOnBrainClick(brainClickHandler);
    lm.update(targetContainer);

    const brainTexts = textObjects.filter((t) => t.text === '\u{1F9E0}');
    // Simulate pointerdown by calling the registered handler
    const pointerdownCall = brainTexts[0].on.mock.calls.find(
      (call: any[]) => call[0] === 'pointerdown'
    );
    expect(pointerdownCall).toBeDefined();
    pointerdownCall[1](); // invoke the handler
    expect(brainClickHandler).toHaveBeenCalledWith('bot-99');
  });

  it('should emit bot:inspect scene event when brain icon is clicked', () => {
    const gameState = makeGameState([makeBotPlayer({ id: 'bot-42' })]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    lm.update(targetContainer);

    const brainTexts = textObjects.filter((t) => t.text === '\u{1F9E0}');
    const pointerdownCall = brainTexts[0].on.mock.calls.find(
      (call: any[]) => call[0] === 'pointerdown'
    );
    pointerdownCall[1]();
    expect(mockScene.events.emit).toHaveBeenCalledWith('bot:inspect', 'bot-42');
  });

  it('should widen leaderboard when bots are present', () => {
    const gameState = makeGameState([makeHumanPlayer(), makeBotPlayer()]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    lm.update(targetContainer);

    // The background rectangle should be 200px wide (not 150) when bots present
    const bgCall = (mockScene.add.rectangle as jest.Mock).mock.calls[0];
    // args: x, y, width, height, color, alpha
    expect(bgCall[2]).toBe(200);
  });

  it('should use narrow width when no bots present', () => {
    const gameState = makeGameState([makeHumanPlayer()]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    lm.update(targetContainer);

    const bgCall = (mockScene.add.rectangle as jest.Mock).mock.calls[0];
    expect(bgCall[2]).toBe(150);
  });

  it('should render player name for both human and bot', () => {
    const gameState = makeGameState([makeHumanPlayer({ name: 'Alice' }), makeBotPlayer({ name: 'Bot Alpha' })]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    lm.update(targetContainer);

    const nameTexts = textObjects.filter((t) => t.text === 'Alice' || t.text === 'Bot Alpha');
    expect(nameTexts).toHaveLength(2);
  });

  it('should render money for both human and bot', () => {
    const gameState = makeGameState([makeHumanPlayer({ money: 100 }), makeBotPlayer({ money: 75 })]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    lm.update(targetContainer);

    const moneyTexts = textObjects.filter((t) => t.text === '100M' || t.text === '75M');
    expect(moneyTexts).toHaveLength(2);
  });

  it('should handle triggerBotPulse by adding tween animation', () => {
    const gameState = makeGameState([makeBotPlayer({ id: 'bot-pulse' })]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    lm.update(targetContainer);

    const tweenCountBefore = mockScene.tweens.add.mock.calls.length;
    lm.triggerBotPulse('bot-pulse');

    expect(mockScene.tweens.add.mock.calls.length).toBeGreaterThan(tweenCountBefore);
    // The pulse tween is the last one added
    const lastCall = mockScene.tweens.add.mock.calls[mockScene.tweens.add.mock.calls.length - 1][0];
    expect(lastCall.yoyo).toBe(true);
    expect(lastCall.repeat).toBe(-1);
  });

  it('should schedule pulse removal after 3 seconds', () => {
    const gameState = makeGameState([makeBotPlayer({ id: 'bot-pulse' })]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    lm.update(targetContainer);

    lm.triggerBotPulse('bot-pulse');

    expect(mockScene.time.delayedCall).toHaveBeenCalledWith(3000, expect.any(Function));
  });

  it('should render multiple bots correctly', () => {
    const gameState = makeGameState([
      makeHumanPlayer(),
      makeBotPlayer({ id: 'bot-1', name: 'Bot A', botConfig: { archetype: 'backbone_builder', skillLevel: 'easy' } }),
      makeBotPlayer({ id: 'bot-2', name: 'Bot B', botConfig: { archetype: 'opportunist', skillLevel: 'hard' } }),
    ]);
    const lm = new LeaderboardManager(mockScene as any, gameState, jest.fn());
    lm.update(targetContainer);

    // Should have 2 bot icons, 2 brain icons, 2 archetype badges
    const botIcons = textObjects.filter((t) => t.text === '\u{1F916}');
    const brainIcons = textObjects.filter((t) => t.text === '\u{1F9E0}');
    const bbBadge = textObjects.filter((t) => t.text === 'BB');
    const opBadge = textObjects.filter((t) => t.text === 'OP');

    expect(botIcons).toHaveLength(2);
    expect(brainIcons).toHaveLength(2);
    expect(bbBadge).toHaveLength(1);
    expect(opBadge).toHaveLength(1);
  });
});
