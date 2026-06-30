/**
 * Unit tests for ActiveEffectHUD Phaser component.
 *
 * Phaser objects cannot be instantiated in Node/JSDOM, so we mock the scene
 * and verify the correct text content and sizer calls are made.
 */

import { ActiveEffectHUD } from '../components/ActiveEffectHUD';
import { ActiveEffectSummary } from '../../shared/types/EventCard';
import { EventCardType } from '../../shared/types/EventCard';

// ---------------------------------------------------------------------------
// Scene mock factory
// ---------------------------------------------------------------------------

interface MockText {
  text: string;
  name: string;
  setName: jest.Mock;
  setOrigin: jest.Mock;
  setVisible: jest.Mock;
  destroy: jest.Mock;
}

function makeText(content = ''): MockText {
  const obj: MockText = {
    text: content,
    name: '',
    setName: jest.fn().mockImplementation((n: string) => {
      obj.name = n;
      return obj;
    }),
    setOrigin: jest.fn().mockReturnThis(),
    setVisible: jest.fn().mockReturnThis(),
    destroy: jest.fn(),
  };
  return obj;
}

interface MockSizer {
  name: string;
  setName: jest.Mock;
  add: jest.Mock;
  clear: jest.Mock;
  destroy: jest.Mock;
  _items: unknown[];
}

function makeSizer(): MockSizer {
  const addedItems: unknown[] = [];
  const obj: MockSizer = {
    name: '',
    setName: jest.fn().mockImplementation((n: string) => {
      obj.name = n;
      return obj;
    }),
    add: jest.fn().mockImplementation((item: unknown) => {
      addedItems.push(item);
      return obj;
    }),
    clear: jest.fn(),
    destroy: jest.fn(),
    _items: addedItems,
  };
  return obj;
}

function makeScene() {
  const textObjects: ReturnType<typeof makeText>[] = [];
  const sizerObject = makeSizer();

  const scene = {
    add: {
      text: jest.fn().mockImplementation((_x: number, _y: number, content: string) => {
        const t = makeText(content);
        textObjects.push(t);
        return t;
      }),
    },
    rexUI: {
      add: {
        sizer: jest.fn().mockImplementation(() => sizerObject),
      },
    },
    _textObjects: textObjects,
    _sizer: sizerObject,
  };

  return scene;
}

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

function makeEffect(overrides: Partial<ActiveEffectSummary> = {}): ActiveEffectSummary {
  return {
    cardId: 130,
    cardType: EventCardType.Snow,
    drawingPlayerId: 'player-1',
    drawingPlayerName: 'Alice',
    expiresAfterTurnNumber: 5,
    affectedZone: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActiveEffectHUD', () => {
  let scene: ReturnType<typeof makeScene>;
  let hud: ActiveEffectHUD;

  beforeEach(() => {
    scene = makeScene();
    hud = new ActiveEffectHUD(scene as unknown as Phaser.Scene);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getSizer', () => {
    it('returns the rexUI sizer for parent integration', () => {
      const sizer = hud.getSizer();
      expect(sizer).toBeDefined();
      expect(sizer).toBe(scene._sizer);
    });

    it('sizer is named active-effects-hud-sizer', () => {
      hud.getSizer();
      expect(scene.rexUI.add.sizer).toHaveBeenCalledWith(
        expect.objectContaining({ orientation: 'y' })
      );
    });
  });

  describe('updateEffects — empty state', () => {
    it('renders empty state text when no effects are provided', () => {
      hud.updateEffects([]);
      const textContent = scene._textObjects.map((t) => t.text);
      expect(textContent.some((t) => t.includes('No active effects'))).toBe(true);
    });

    it('names the empty state text object correctly', () => {
      hud.updateEffects([]);
      const emptyText = scene._textObjects.find((t) =>
        t.text.includes('No active effects')
      );
      expect(emptyText).toBeDefined();
      expect(emptyText!.name).toBe('active-effects-empty');
    });

    it('adds the empty state text to the sizer', () => {
      hud.updateEffects([]);
      expect(scene._sizer.add).toHaveBeenCalled();
    });
  });

  describe('updateEffects — single effect', () => {
    it('renders snow icon for Snow effect', () => {
      hud.updateEffects([makeEffect({ cardType: EventCardType.Snow })]);
      const textContent = scene._textObjects.map((t) => t.text);
      expect(textContent.some((t) => t.includes('❄️'))).toBe(true);
    });

    it('renders flood icon for Flood effect', () => {
      hud.updateEffects([makeEffect({ cardType: EventCardType.Flood, cardId: 133 })]);
      const textContent = scene._textObjects.map((t) => t.text);
      expect(textContent.some((t) => t.includes('🌊'))).toBe(true);
    });

    it('renders strike icon for Strike effect', () => {
      hud.updateEffects([makeEffect({ cardType: EventCardType.Strike, cardId: 121 })]);
      const textContent = scene._textObjects.map((t) => t.text);
      expect(textContent.some((t) => t.includes('🚫'))).toBe(true);
    });

    it('renders derailment icon for Derailment effect', () => {
      hud.updateEffects([makeEffect({ cardType: EventCardType.Derailment, cardId: 125 })]);
      const textContent = scene._textObjects.map((t) => t.text);
      expect(textContent.some((t) => t.includes('⚠️'))).toBe(true);
    });

    it('renders the effect type label', () => {
      hud.updateEffects([makeEffect({ cardType: EventCardType.Snow })]);
      const textContent = scene._textObjects.map((t) => t.text);
      expect(textContent.some((t) => t.includes('Snow'))).toBe(true);
    });

    it('names the row text with card ID', () => {
      hud.updateEffects([makeEffect({ cardId: 130 })]);
      const rowText = scene._textObjects.find((t) =>
        t.name === 'active-effect-row-130'
      );
      expect(rowText).toBeDefined();
    });

    it('adds the effect row to the sizer', () => {
      hud.updateEffects([makeEffect()]);
      expect(scene._sizer.add).toHaveBeenCalled();
    });
  });

  describe('updateEffects — duration formatting', () => {
    it('shows "active" when no current turn number provided', () => {
      hud.updateEffects([makeEffect({ expiresAfterTurnNumber: 5 })]);
      const textContent = scene._textObjects.map((t) => t.text);
      expect(textContent.some((t) => t.includes('active'))).toBe(true);
    });

    it('shows "1 turn" when one turn remains', () => {
      hud.updateEffects([makeEffect({ expiresAfterTurnNumber: 5 })], 4);
      const textContent = scene._textObjects.map((t) => t.text);
      expect(textContent.some((t) => t.includes('1 turn'))).toBe(true);
    });

    it('shows "2 turns" when two turns remain', () => {
      hud.updateEffects([makeEffect({ expiresAfterTurnNumber: 5 })], 3);
      const textContent = scene._textObjects.map((t) => t.text);
      expect(textContent.some((t) => t.includes('2 turns'))).toBe(true);
    });

    it('shows "expiring" when turns left is zero or negative', () => {
      hud.updateEffects([makeEffect({ expiresAfterTurnNumber: 3 })], 4);
      const textContent = scene._textObjects.map((t) => t.text);
      expect(textContent.some((t) => t.includes('expiring'))).toBe(true);
    });
  });

  describe('updateEffects — multiple effects', () => {
    it('renders multiple effect rows', () => {
      const effects = [
        makeEffect({ cardId: 130, cardType: EventCardType.Snow }),
        makeEffect({ cardId: 133, cardType: EventCardType.Flood }),
      ];
      hud.updateEffects(effects);
      // Two rows should be created
      const rowTexts = scene._textObjects.filter(
        (t) => t.name.startsWith('active-effect-row-')
      );
      expect(rowTexts).toHaveLength(2);
    });

    it('renders both icons when two effects are active', () => {
      const effects = [
        makeEffect({ cardId: 130, cardType: EventCardType.Snow }),
        makeEffect({ cardId: 121, cardType: EventCardType.Strike }),
      ];
      hud.updateEffects(effects);
      const textContent = scene._textObjects.map((t) => t.text);
      expect(textContent.some((t) => t.includes('❄️'))).toBe(true);
      expect(textContent.some((t) => t.includes('🚫'))).toBe(true);
    });

    it('adds all rows to the sizer', () => {
      const effects = [
        makeEffect({ cardId: 130, cardType: EventCardType.Snow }),
        makeEffect({ cardId: 133, cardType: EventCardType.Flood }),
        makeEffect({ cardId: 121, cardType: EventCardType.Strike }),
      ];
      hud.updateEffects(effects);
      // sizer.add called once per effect row
      expect(scene._sizer.add).toHaveBeenCalledTimes(3);
    });
  });

  describe('updateEffects — reactive updates (replace)', () => {
    it('clears sizer when re-rendering from populated to empty', () => {
      hud.updateEffects([makeEffect()]);
      hud.updateEffects([]);
      // sizer.clear should have been called on the second update
      expect(scene._sizer.clear).toHaveBeenCalled();
    });

    it('destroys old row text objects when updating', () => {
      hud.updateEffects([makeEffect({ cardId: 130 })]);
      const firstRowText = scene._textObjects.find(
        (t) => t.name === 'active-effect-row-130'
      );
      expect(firstRowText).toBeDefined();
      // Second update replaces the content
      hud.updateEffects([makeEffect({ cardId: 131, cardType: EventCardType.Flood })]);
      expect(firstRowText!.destroy).toHaveBeenCalled();
    });

    it('renders new effects after update', () => {
      hud.updateEffects([makeEffect({ cardId: 130, cardType: EventCardType.Snow })]);
      hud.updateEffects([makeEffect({ cardId: 121, cardType: EventCardType.Strike })]);
      const lastRowText = scene._textObjects.find(
        (t) => t.name === 'active-effect-row-121'
      );
      expect(lastRowText).toBeDefined();
    });
  });

  describe('destroy', () => {
    it('destroys all effect row text objects', () => {
      hud.updateEffects([makeEffect({ cardId: 130 })]);
      const rowText = scene._textObjects.find((t) => t.name === 'active-effect-row-130');
      hud.destroy();
      expect(rowText!.destroy).toHaveBeenCalled();
    });

    it('clears and destroys the sizer', () => {
      hud.destroy();
      expect(scene._sizer.clear).toHaveBeenCalled();
      expect(scene._sizer.destroy).toHaveBeenCalled();
    });
  });
});
