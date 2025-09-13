// src/client/__tests__/setupTests.js
require('jest-canvas-mock');

// Only run mocks in test environment
if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
  // Minimal Scene shim (pure JS)
  class Scene {
    constructor(config) {
      Object.assign(this, config);
    }
  }

  // Phaser-ish mocks
  const mockTime = {
  delayedCall: jest.fn((delay, callback) => {
    callback();
    return { destroy: jest.fn() };
  }),
  addEvent: jest.fn(),
};

const mockText = {
  setOrigin: jest.fn().mockReturnThis(),
  setInteractive: jest.fn().mockReturnThis(),
  setText: jest.fn().mockReturnThis(),
  destroy: jest.fn(),
  x: 0,
  y: 0,
  style: {},
  canvas: document.createElement('canvas'),
  context: document.createElement('canvas').getContext('2d'),
  renderer: {},
  displayWidth: 0,
  displayHeight: 0,
  width: 0,
  height: 0,
  originX: 0,
  originY: 0,
  displayOriginX: 0,
  displayOriginY: 0,
  type: 'Text',
};

const mockAdd = {
  text: jest.fn(() => mockText),
  rectangle: jest.fn(() => ({
    setOrigin: jest.fn().mockReturnThis(),
    setInteractive: jest.fn().mockReturnThis(),
    setFillStyle: jest.fn().mockReturnThis(),
    destroy: jest.fn(),
    on: jest.fn().mockReturnThis(),
  })),
  container: jest.fn(() => ({
    add: jest.fn(),
    destroy: jest.fn(),
  })),
  dom: jest.fn(() => ({
    setOrigin: jest.fn().mockReturnThis(),
  })),
  graphics: jest.fn(() => ({
    lineStyle: jest.fn().mockReturnThis(),
    fillStyle: jest.fn().mockReturnThis(),
    beginPath: jest.fn().mockReturnThis(),
    moveTo: jest.fn().mockReturnThis(),
    lineTo: jest.fn().mockReturnThis(),
    closePath: jest.fn().mockReturnThis(),
    fill: jest.fn().mockReturnThis(),
    stroke: jest.fn().mockReturnThis(),
    arc: jest.fn().mockReturnThis(),
    fillRect: jest.fn().mockReturnThis(),
    strokeRect: jest.fn().mockReturnThis(),
    setDepth: jest.fn().mockReturnThis(),
    clear: jest.fn().mockReturnThis(),
    strokePath: jest.fn().mockReturnThis(),
  })),
};

const mockInput = { on: jest.fn(), off: jest.fn() };

const mockCameras = {
  main: {
    setBackgroundColor: jest.fn(),
    setBounds: jest.fn(),
    centerOn: jest.fn(),
    setZoom: jest.fn(),
    scrollX: 0,
    scrollY: 0,
    zoom: 1,
    ignore: jest.fn(),
  },
  add: jest.fn().mockReturnValue({
    setScroll: jest.fn(),
    ignore: jest.fn(),
  }),
};

class MockScene extends Scene {
  constructor() {
    super({ key: 'MockScene' });
    this.initializeMocks();
  }

  initializeMocks() {
    this.add = mockAdd;
    this.time = mockTime;
    this.input = mockInput;
    this.cameras = mockCameras;
    this.scene = {
      start: jest.fn(),
      stop: jest.fn(),
      launch: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
      restart: jest.fn(),
      wake: jest.fn(),
      sleep: jest.fn(),
      switch: jest.fn(),
      run: jest.fn(),
      isActive: jest.fn().mockReturnValue(true),
      isSleeping: jest.fn().mockReturnValue(false),
      isPaused: jest.fn().mockReturnValue(false),
      isVisible: jest.fn().mockReturnValue(true),
      setVisible: jest.fn(),
      setActive: jest.fn(),
      manager: { scenes: [] },
    };
    this.events = {
      on: jest.fn(),
      once: jest.fn(),
      emit: jest.fn(),
      off: jest.fn(),
      removeListener: jest.fn(),
      removeAllListeners: jest.fn(),
      shutdown: jest.fn(),
    };
    this.scale = {
      width: 800,
      height: 600,
      on: jest.fn(),
      off: jest.fn(),
      resize: jest.fn(),
    };
    this.children = {
      add: jest.fn(),
      remove: jest.fn(),
      removeAll: jest.fn(),
      destroy: jest.fn(),
      exists: jest.fn().mockReturnValue(true),
      list: [],
    };
    this.gameState = {
      id: '',
      players: [],
      status: 'setup',
      currentPlayerIndex: 0,
      maxPlayers: 6,
    };
    this.colorButtons = [];
    this.selectedColor = undefined;
    this.nameInput = document.createElement('input');
    this.errorText = {
      setText: jest.fn().mockReturnThis(),
      setOrigin: jest.fn().mockReturnThis(),
    };
    this.playerList = {
      setText: jest.fn().mockReturnThis(),
      setOrigin: jest.fn().mockReturnThis(),
    };
  }

  init(data) {
    if (data && data.gameState) this.gameState = data.gameState;
  }

  create() {}

  async addPlayer() {
    if (!this.nameInput?.value) {
      this.errorText?.setText('Please enter a valid name');
      return;
    }
    if (!this.selectedColor) {
      this.errorText?.setText('Please enter a name and select a color');
      return;
    }
    const name = this.nameInput.value.trim();
    if (this.gameState.players.some((p) => p.name === name)) {
      this.errorText?.setText('This name is already taken');
      return;
    }
    if (this.gameState.players.some((p) => p.color === this.selectedColor)) {
      this.errorText?.setText('This color is already taken');
      return;
    }
  }

  async startGame() {
    if (this.gameState.players.length < 2) {
      this.errorText?.setText('At least 2 players are required to start');
      return;
    }
    try {
      await fetch('/api/game/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: this.gameState.id }),
      });
      this.gameState.status = 'active';
      this.scene.start('GameScene', { gameState: this.gameState });
    } catch {
      this.errorText?.setText('Failed to start game');
    }
  }

  async savePlayerChanges() {
    if (!this.nameInput?.value) {
      this.errorText?.setText('Please enter a valid name');
      return;
    }
    try {
      await fetch('/api/players/update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameId: this.gameState.id,
          player: { name: this.nameInput.value, color: this.selectedColor },
        }),
      });
    } catch {
      this.errorText?.setText('Failed to update player');
    }
  }

  async endGame() {
    try {
      await fetch('/api/game/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: this.gameState.id }),
      });
      this.scene.start('SetupScene', {
        gameState: {
          id: '',
          players: [],
          status: 'setup',
          currentPlayerIndex: 0,
          maxPlayers: 6,
        },
      });
    } catch {
      this.errorText?.setText('Failed to end game');
    }
  }
}

globalThis.Phaser = {
  Scene: MockScene,
  GameObjects: {
    Text: jest.fn(() => mockText),
    Rectangle: jest.fn(),
    Container: jest.fn(),
    Graphics: jest.fn(),
  },
  Scale: { RESIZE: 'RESIZE', CENTER_BOTH: 'CENTER_BOTH' },
  AUTO: 'AUTO',
};

// ---- FIXED FETCH MOCK ----
if (!('fetch' in globalThis)) {
  globalThis.fetch = jest.fn();
}
globalThis.fetch = jest.fn().mockResolvedValue({
  ok: true,
  json: async () => ({}),
});

// ---- LOCALSTORAGE MOCK ----
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    clear: jest.fn(),
  },
  configurable: true,
  writable: true,
});

  // Export mocks for tests that want them
  module.exports = {
    mocks: { text: mockText, time: mockTime, add: mockAdd, input: mockInput, cameras: mockCameras },
    MockScene: MockScene,
  };
}
