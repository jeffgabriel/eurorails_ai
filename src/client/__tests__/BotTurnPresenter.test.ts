import { BotTurnPresenter, BotTurnPresenterDeps, BotTurnCompletePayload } from '../components/BotTurnPresenter';
import type { GridPoint } from '../../shared/types/GameTypes';

function createGridPoints(): GridPoint[][] {
  const grid: GridPoint[][] = [];
  for (let row = 0; row < 5; row++) {
    grid[row] = [];
    for (let col = 0; col < 5; col++) {
      grid[row][col] = { x: row * 100, y: col * 100 } as unknown as GridPoint;
    }
  }
  return grid;
}

function createDeps(overrides: Partial<BotTurnPresenterDeps> = {}): BotTurnPresenterDeps & {
  gameToastManager: { show: jest.Mock };
  botTrainAnimator: {
    isAnimating: jest.Mock;
    cancelAnimation: jest.Mock;
    animateTimeline: jest.Mock;
    animateAlongPath: jest.Mock;
  };
  whisperPanel: { addBotTurn: jest.Mock };
  llmTranscriptOverlay: { ingestBotTurnComplete: jest.Mock };
} {
  const gameToastManager = { show: jest.fn() };
  const botTrainAnimator = {
    isAnimating: jest.fn().mockReturnValue(false),
    cancelAnimation: jest.fn(),
    animateTimeline: jest.fn().mockResolvedValue(null),
    animateAlongPath: jest.fn().mockResolvedValue(null),
  };
  const whisperPanel = { addBotTurn: jest.fn() };
  const llmTranscriptOverlay = { ingestBotTurnComplete: jest.fn() };

  return {
    gameToastManager: gameToastManager as any,
    botTrainAnimator: botTrainAnimator as any,
    whisperPanel: whisperPanel as any,
    llmTranscriptOverlay: llmTranscriptOverlay as any,
    getMapGridPoints: jest.fn().mockReturnValue(createGridPoints()),
    getTrainSprite: jest.fn().mockReturnValue({ setPosition: jest.fn() }),
    updateTrainPosition: jest.fn(),
    resolveBotDisplay: jest.fn().mockReturnValue({ name: 'Bot Alice', color: 0x00ff00 }),
    ...overrides,
  } as any;
}

describe('BotTurnPresenter', () => {
  describe('present', () => {
    it('ingests the payload into the LLM transcript overlay regardless of botPlayerId', () => {
      const deps = createDeps();
      const presenter = new BotTurnPresenter(deps);
      const payload: BotTurnCompletePayload = {};

      presenter.present(payload);

      expect(deps.llmTranscriptOverlay.ingestBotTurnComplete).toHaveBeenCalledWith(payload);
    });

    it('gracefully handles a payload with no botPlayerId, throwing nothing and skipping toasts/animation', () => {
      const deps = createDeps();
      const presenter = new BotTurnPresenter(deps);

      expect(() => presenter.present({ reasoning: 'orphaned payload' })).not.toThrow();
      expect(deps.gameToastManager.show).not.toHaveBeenCalled();
      expect(deps.botTrainAnimator.animateTimeline).not.toHaveBeenCalled();
      expect(deps.whisperPanel.addBotTurn).not.toHaveBeenCalled();
    });

    it('shows a strategy toast using the resolved bot name and color', () => {
      const deps = createDeps();
      const presenter = new BotTurnPresenter(deps);

      presenter.present({ botPlayerId: 'bot-1', reasoning: 'Heading to Paris for cheese' });

      expect(deps.gameToastManager.show).toHaveBeenCalledWith(
        'Bot Alice: Heading to Paris for cheese',
        { color: 0x00ff00, duration: 10000 },
      );
    });

    it('shows a distinct failure toast when reasoning is tagged [llm-failed]', () => {
      const deps = createDeps();
      const presenter = new BotTurnPresenter(deps);

      presenter.present({ botPlayerId: 'bot-1', reasoning: '[llm-failed] falling back to heuristic' });

      expect(deps.gameToastManager.show).toHaveBeenCalledWith(
        expect.stringContaining('LLM failed'),
        { color: 0x8b0000, shake: true },
      );
    });

    it('shows a delivery toast, deduplicated by loadType+city', () => {
      const deps = createDeps();
      const presenter = new BotTurnPresenter(deps);

      presenter.present({
        botPlayerId: 'bot-1',
        loadsDelivered: [
          { loadType: 'Cheese', city: 'Paris', payment: 12 },
          { loadType: 'Cheese', city: 'Paris', payment: 12 },
        ],
      });

      const deliveryToasts = deps.gameToastManager.show.mock.calls.filter(([msg]: [string]) =>
        msg.includes('delivered'),
      );
      expect(deliveryToasts).toHaveLength(1);
    });

    it('shows a pickup toast listing every load picked up', () => {
      const deps = createDeps();
      const presenter = new BotTurnPresenter(deps);

      presenter.present({
        botPlayerId: 'bot-1',
        loadsPickedUp: [{ loadType: 'Wine', city: 'Bordeaux' }],
      });

      expect(deps.gameToastManager.show).toHaveBeenCalledWith(
        expect.stringContaining('picked up Wine at Bordeaux'),
        { color: 0x00ff00 },
      );
    });

    it('shows a build toast when segments were built toward a target city', () => {
      const deps = createDeps();
      const presenter = new BotTurnPresenter(deps);

      presenter.present({ botPlayerId: 'bot-1', segmentsBuilt: 2, buildTargetCity: 'Berlin', cost: 6 });

      expect(deps.gameToastManager.show).toHaveBeenCalledWith(
        expect.stringContaining('built 2 track segments toward Berlin'),
        { color: 0x00ff00 },
      );
    });

    it('shows upgrade and discard toasts for those actions', () => {
      const deps = createDeps();
      const presenter = new BotTurnPresenter(deps);

      presenter.present({ botPlayerId: 'bot-1', action: 'UpgradeTrain' });
      presenter.present({ botPlayerId: 'bot-1', action: 'DiscardHand' });

      expect(deps.gameToastManager.show).toHaveBeenCalledWith('Bot Alice upgraded their train', { color: 0x00ff00 });
      expect(deps.gameToastManager.show).toHaveBeenCalledWith(
        '😢 Bot Alice discarded their hand',
        { color: 0x00ff00, shake: true },
      );
    });

    it('skips flat-payload action toasts when an actionTimeline is present (toasts fire mid-animation instead)', () => {
      const deps = createDeps();
      const presenter = new BotTurnPresenter(deps);

      presenter.present({
        botPlayerId: 'bot-1',
        actionTimeline: [{ type: 'move', path: [{ row: 0, col: 0 }, { row: 1, col: 1 }] }],
        loadsPickedUp: [{ loadType: 'Wine', city: 'Bordeaux' }],
      });

      const pickupToasts = deps.gameToastManager.show.mock.calls.filter(([msg]: [string]) => msg.includes('picked up'));
      expect(pickupToasts).toHaveLength(0);
    });
  });

  describe('animation orchestration', () => {
    it('cancels an in-progress animation for the same bot before starting a new one', () => {
      const deps = createDeps();
      deps.botTrainAnimator.isAnimating.mockReturnValue(true);
      const presenter = new BotTurnPresenter(deps);

      presenter.present({ botPlayerId: 'bot-1', movementPath: [{ row: 0, col: 0 }, { row: 1, col: 1 }] });

      expect(deps.botTrainAnimator.cancelAnimation).toHaveBeenCalledWith('bot-1');
    });

    it('animates via animateTimeline when actionTimeline is present, and updates the final position', async () => {
      const deps = createDeps();
      deps.botTrainAnimator.animateTimeline.mockResolvedValue({ row: 2, col: 2, x: 20, y: 20 });
      const presenter = new BotTurnPresenter(deps);

      presenter.present({
        botPlayerId: 'bot-1',
        actionTimeline: [{ type: 'move', path: [{ row: 0, col: 0 }, { row: 2, col: 2 }] }],
      });

      expect(deps.botTrainAnimator.animateTimeline).toHaveBeenCalledWith(
        'bot-1',
        expect.any(Array),
        expect.any(Array),
        expect.any(Function),
        expect.any(Function),
      );

      await Promise.resolve();
      await Promise.resolve();

      expect(deps.updateTrainPosition).toHaveBeenCalledWith('bot-1', 20, 20, 2, 2, { persist: false });
    });

    it('falls back to animateAlongPath when no actionTimeline is present', async () => {
      const deps = createDeps();
      deps.botTrainAnimator.animateAlongPath.mockResolvedValue({ row: 1, col: 1, x: 100, y: 100 });
      const presenter = new BotTurnPresenter(deps);

      presenter.present({
        botPlayerId: 'bot-1',
        movementPath: [{ row: 0, col: 0 }, { row: 1, col: 1 }],
      });

      expect(deps.botTrainAnimator.animateTimeline).not.toHaveBeenCalled();
      expect(deps.botTrainAnimator.animateAlongPath).toHaveBeenCalledWith(
        'bot-1',
        [{ row: 0, col: 0 }, { row: 1, col: 1 }],
        expect.any(Array),
        expect.any(Function),
      );

      await Promise.resolve();
      await Promise.resolve();

      expect(deps.updateTrainPosition).toHaveBeenCalledWith('bot-1', 100, 100, 1, 1, { persist: false });
    });

    it('does not animate a flat path shorter than 2 points', () => {
      const deps = createDeps();
      const presenter = new BotTurnPresenter(deps);

      presenter.present({ botPlayerId: 'bot-1', movementPath: [{ row: 0, col: 0 }] });

      expect(deps.botTrainAnimator.animateAlongPath).not.toHaveBeenCalled();
    });

    it('fires per-step toasts from the actionTimeline onAction callback', () => {
      const deps = createDeps();
      let capturedOnAction: ((step: any) => void) | undefined;
      deps.botTrainAnimator.animateTimeline.mockImplementation((_id: string, _tl: any, _gp: any, _getSprite: any, onAction: any) => {
        capturedOnAction = onAction;
        return Promise.resolve(null);
      });
      const presenter = new BotTurnPresenter(deps);

      presenter.present({
        botPlayerId: 'bot-1',
        actionTimeline: [{ type: 'deliver', loadType: 'Cheese', city: 'Paris', payment: 12, cardId: 1 }],
      });

      expect(capturedOnAction).toBeDefined();
      capturedOnAction!({ type: 'deliver', loadType: 'Cheese', city: 'Paris', payment: 12 });

      expect(deps.gameToastManager.show).toHaveBeenCalledWith(
        expect.stringContaining('delivered Cheese to Paris'),
        { color: 0x00ff00, flourish: true },
      );
    });

    it('fires a toast for every timeline step type (pickup/build/upgrade/discard)', () => {
      const deps = createDeps();
      let capturedOnAction: ((step: any) => void) | undefined;
      deps.botTrainAnimator.animateTimeline.mockImplementation((_id: string, _tl: any, _gp: any, _getSprite: any, onAction: any) => {
        capturedOnAction = onAction;
        return Promise.resolve(null);
      });
      const presenter = new BotTurnPresenter(deps);

      presenter.present({
        botPlayerId: 'bot-1',
        actionTimeline: [{ type: 'pickup', loadType: 'Wine', city: 'Bordeaux' }],
      });
      capturedOnAction!({ type: 'pickup', loadType: 'Wine', city: 'Bordeaux' });
      expect(deps.gameToastManager.show).toHaveBeenCalledWith('Bot Alice picked up Wine at Bordeaux', { color: 0x00ff00 });

      capturedOnAction!({ type: 'build', segmentsBuilt: 2, cost: 4 });
      expect(deps.gameToastManager.show).toHaveBeenCalledWith('Bot Alice built 2 track segments (4M)', { color: 0x00ff00 });

      capturedOnAction!({ type: 'upgrade', trainType: 'FastFreight' });
      expect(deps.gameToastManager.show).toHaveBeenCalledWith('Bot Alice upgraded their train', { color: 0x00ff00 });

      capturedOnAction!({ type: 'discard' });
      expect(deps.gameToastManager.show).toHaveBeenCalledWith('😢 Bot Alice discarded their hand', { color: 0x00ff00, shake: true });
    });

    it('ignores a step type it does not recognize without throwing', () => {
      const deps = createDeps();
      let capturedOnAction: ((step: any) => void) | undefined;
      deps.botTrainAnimator.animateTimeline.mockImplementation((_id: string, _tl: any, _gp: any, _getSprite: any, onAction: any) => {
        capturedOnAction = onAction;
        return Promise.resolve(null);
      });
      const presenter = new BotTurnPresenter(deps);

      presenter.present({ botPlayerId: 'bot-1', actionTimeline: [{ type: 'move', path: [] }] });

      expect(() => capturedOnAction!({ type: 'move', path: [] } as any)).not.toThrow();
    });

    it('does nothing on action steps once gameToastManager is absent', () => {
      const deps = createDeps({ gameToastManager: undefined });
      let capturedOnAction: ((step: any) => void) | undefined;
      deps.botTrainAnimator.animateTimeline.mockImplementation((_id: string, _tl: any, _gp: any, _getSprite: any, onAction: any) => {
        capturedOnAction = onAction;
        return Promise.resolve(null);
      });
      const presenter = new BotTurnPresenter(deps);

      presenter.present({ botPlayerId: 'bot-1', actionTimeline: [{ type: 'deliver', loadType: 'Cheese', city: 'Paris', payment: 12, cardId: 1 }] });

      expect(() => capturedOnAction!({ type: 'deliver', loadType: 'Cheese', city: 'Paris', payment: 12 })).not.toThrow();
    });

    it('passes a lazy getSprite accessor to animateTimeline that reads the current sprite on demand', () => {
      const deps = createDeps();
      const presenter = new BotTurnPresenter(deps);

      presenter.present({
        botPlayerId: 'bot-1',
        actionTimeline: [{ type: 'move', path: [{ row: 0, col: 0 }, { row: 1, col: 1 }] }],
      });

      const getSprite = deps.botTrainAnimator.animateTimeline.mock.calls[0][3];
      (deps.getTrainSprite as jest.Mock).mockClear();
      getSprite();
      expect(deps.getTrainSprite).toHaveBeenCalledWith('bot-1');
    });

    it('passes a lazy getSprite accessor to animateAlongPath that reads the current sprite on demand', () => {
      const deps = createDeps();
      const presenter = new BotTurnPresenter(deps);

      presenter.present({
        botPlayerId: 'bot-1',
        movementPath: [{ row: 0, col: 0 }, { row: 1, col: 1 }],
      });

      const getSprite = deps.botTrainAnimator.animateAlongPath.mock.calls[0][3];
      (deps.getTrainSprite as jest.Mock).mockClear();
      getSprite();
      expect(deps.getTrainSprite).toHaveBeenCalledWith('bot-1');
    });
  });

  describe('whisper entries', () => {
    it('adds a whisper entry with fields resolved from the payload', () => {
      const deps = createDeps();
      const presenter = new BotTurnPresenter(deps);

      presenter.present({
        botPlayerId: 'bot-1',
        turnNumber: 5,
        action: 'Move',
        reasoning: 'Heading north',
        cost: 3,
        segmentsBuilt: 1,
        movementData: { mileposts: 4 },
      });

      expect(deps.whisperPanel.addBotTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          turnNumber: 5,
          botPlayerId: 'bot-1',
          botName: 'Bot Alice',
          action: 'Move',
          reasoning: 'Heading north',
          cost: 3,
          segmentsBuilt: 1,
          milepostsMoved: 4,
        }),
      );
    });

    it('does not add a whisper entry when no whisperPanel dependency is present', () => {
      const deps = createDeps({ whisperPanel: undefined });
      const presenter = new BotTurnPresenter(deps);

      expect(() => presenter.present({ botPlayerId: 'bot-1', reasoning: 'test' })).not.toThrow();
    });
  });
});
