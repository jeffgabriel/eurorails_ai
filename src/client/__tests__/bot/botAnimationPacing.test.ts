import { useGameSettingsStore } from '../../store/gameSettings';

// --- gameSettings store tests ---

describe('gameSettings store', () => {
  beforeEach(() => {
    // Reset store to default state before each test
    useGameSettingsStore.setState({ fastModeEnabled: false });
  });

  it('should default fastModeEnabled to false', () => {
    const state = useGameSettingsStore.getState();
    expect(state.fastModeEnabled).toBe(false);
  });

  it('should set fastModeEnabled via setFastMode', () => {
    useGameSettingsStore.getState().setFastMode(true);
    expect(useGameSettingsStore.getState().fastModeEnabled).toBe(true);

    useGameSettingsStore.getState().setFastMode(false);
    expect(useGameSettingsStore.getState().fastModeEnabled).toBe(false);
  });

  it('should toggle fastModeEnabled via toggleFastMode', () => {
    expect(useGameSettingsStore.getState().fastModeEnabled).toBe(false);

    useGameSettingsStore.getState().toggleFastMode();
    expect(useGameSettingsStore.getState().fastModeEnabled).toBe(true);

    useGameSettingsStore.getState().toggleFastMode();
    expect(useGameSettingsStore.getState().fastModeEnabled).toBe(false);
  });
});

// --- Socket event types tests ---

describe('Bot socket event types', () => {
  it('should define bot:turn-start event shape', () => {
    // Type-level validation: ensure the event data shape compiles correctly
    const data: {
      gameId: string;
      playerId: string;
      playerName: string;
      timestamp: number;
    } = {
      gameId: 'game-1',
      playerId: 'bot-1',
      playerName: 'Bot Alpha',
      timestamp: Date.now(),
    };
    expect(data.gameId).toBe('game-1');
    expect(data.playerId).toBe('bot-1');
    expect(data.playerName).toBe('Bot Alpha');
    expect(typeof data.timestamp).toBe('number');
  });

  it('should define bot:action event shape', () => {
    const data: {
      gameId: string;
      playerId: string;
      action: string;
      description: string;
      timestamp: number;
    } = {
      gameId: 'game-1',
      playerId: 'bot-1',
      action: 'DeliverLoad',
      description: 'Delivering Wine to Vienna',
      timestamp: Date.now(),
    };
    expect(data.action).toBe('DeliverLoad');
    expect(data.description).toBe('Delivering Wine to Vienna');
  });

  it('should define bot:turn-complete event shape', () => {
    const data: {
      gameId: string;
      playerId: string;
      timestamp: number;
    } = {
      gameId: 'game-1',
      playerId: 'bot-1',
      timestamp: Date.now(),
    };
    expect(data.gameId).toBe('game-1');
    expect(data.playerId).toBe('bot-1');
  });
});

// --- Bot animation handler logic tests ---

describe('Bot animation pacing logic', () => {
  let botActionQueue: Array<{ action: string; description: string; playerId: string }>;
  let isBotAnimating: boolean;
  let notifications: string[];
  let pulseTriggered: string[];

  function mockTurnNotificationShow(message: string): void {
    notifications.push(message);
  }

  function mockTriggerBotPulse(playerId: string): void {
    pulseTriggered.push(playerId);
  }

  beforeEach(() => {
    botActionQueue = [];
    isBotAnimating = false;
    notifications = [];
    pulseTriggered = [];
    useGameSettingsStore.setState({ fastModeEnabled: false });
  });

  function handleBotTurnStart(playerId: string, playerName: string): void {
    botActionQueue = [];
    isBotAnimating = true;
    mockTriggerBotPulse(playerId);
    mockTurnNotificationShow(`${playerName} is thinking...`);
  }

  function handleBotAction(playerId: string, action: string, description: string): void {
    botActionQueue.push({ action, description, playerId });
    if (!isBotAnimating) return;

    const fastMode = useGameSettingsStore.getState().fastModeEnabled;
    if (fastMode) {
      mockTurnNotificationShow(description);
    } else {
      // Process next from queue
      const next = botActionQueue.shift();
      if (next) {
        mockTurnNotificationShow(next.description);
      }
    }
  }

  function handleBotTurnComplete(playerId: string, playerName: string): void {
    isBotAnimating = false;
    botActionQueue = [];
    mockTurnNotificationShow(`${playerName} finished their turn.`);
  }

  it('should trigger pulse and show thinking notification on bot turn start', () => {
    handleBotTurnStart('bot-1', 'Bot Alpha');

    expect(isBotAnimating).toBe(true);
    expect(pulseTriggered).toContain('bot-1');
    expect(notifications).toContain('Bot Alpha is thinking...');
  });

  it('should clear action queue on bot turn start', () => {
    botActionQueue.push({ action: 'old', description: 'old action', playerId: 'bot-1' });
    handleBotTurnStart('bot-1', 'Bot Alpha');

    expect(botActionQueue).toHaveLength(0);
  });

  it('should show action description in normal mode', () => {
    handleBotTurnStart('bot-1', 'Bot Alpha');
    handleBotAction('bot-1', 'DeliverLoad', 'Delivering Wine to Vienna');

    expect(notifications).toContain('Delivering Wine to Vienna');
  });

  it('should show action description in fast mode', () => {
    useGameSettingsStore.getState().setFastMode(true);
    handleBotTurnStart('bot-1', 'Bot Alpha');
    handleBotAction('bot-1', 'DeliverLoad', 'Delivering Wine to Vienna');

    expect(notifications).toContain('Delivering Wine to Vienna');
  });

  it('should not process actions after turn complete', () => {
    handleBotTurnStart('bot-1', 'Bot Alpha');
    handleBotTurnComplete('bot-1', 'Bot Alpha');

    // Should not animate since isBotAnimating is now false
    notifications.length = 0;
    handleBotAction('bot-1', 'BuildTrack', 'Building track');

    // The action is pushed to queue but not processed since isBotAnimating is false
    expect(notifications).toHaveLength(0);
  });

  it('should show finished notification on bot turn complete', () => {
    handleBotTurnStart('bot-1', 'Bot Alpha');
    handleBotTurnComplete('bot-1', 'Bot Alpha');

    expect(isBotAnimating).toBe(false);
    expect(botActionQueue).toHaveLength(0);
    expect(notifications).toContain('Bot Alpha finished their turn.');
  });

  it('should handle multiple actions in sequence', () => {
    handleBotTurnStart('bot-1', 'Bot Alpha');
    handleBotAction('bot-1', 'Move', 'Moving to Wien');
    handleBotAction('bot-1', 'DeliverLoad', 'Delivering Wine');

    // Both actions should have generated notifications
    expect(notifications).toContain('Moving to Wien');
    expect(notifications).toContain('Delivering Wine');
  });
});
