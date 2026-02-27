import { ResponseParser, ParseError } from '../../services/ai/ResponseParser';
import { AIActionType } from '../../../shared/types/GameTypes';

describe('ResponseParser', () => {
  describe('clean JSON parsing', () => {
    it('should parse a well-formed JSON response', () => {
      const json = JSON.stringify({
        moveOption: 2,
        buildOption: 0,
        reasoning: 'Deliver coal to Berlin',
        planHorizon: 'Next 3 turns',
      });

      const result = ResponseParser.parse(json, 5, 3);

      expect(result.moveOptionIndex).toBe(2);
      expect(result.buildOptionIndex).toBe(0);
      expect(result.reasoning).toBe('Deliver coal to Berlin');
      expect(result.planHorizon).toBe('Next 3 turns');
    });

    it('should accept moveOption = -1 (skip movement)', () => {
      const json = JSON.stringify({ moveOption: -1, buildOption: 1 });

      const result = ResponseParser.parse(json, 3, 2);

      expect(result.moveOptionIndex).toBe(-1);
      expect(result.buildOptionIndex).toBe(1);
    });

    it('should default missing moveOption to -1', () => {
      const json = JSON.stringify({ buildOption: 0 });

      const result = ResponseParser.parse(json, 3, 2);

      expect(result.moveOptionIndex).toBe(-1);
    });

    it('should default missing reasoning and planHorizon to empty strings', () => {
      const json = JSON.stringify({ moveOption: 0, buildOption: 0 });

      const result = ResponseParser.parse(json, 1, 1);

      expect(result.reasoning).toBe('');
      expect(result.planHorizon).toBe('');
    });
  });

  describe('markdown fence stripping', () => {
    it('should strip ```json fences', () => {
      const text = '```json\n{"moveOption": 1, "buildOption": 0}\n```';

      const result = ResponseParser.parse(text, 3, 2);

      expect(result.moveOptionIndex).toBe(1);
      expect(result.buildOptionIndex).toBe(0);
    });

    it('should strip plain ``` fences', () => {
      const text = '```\n{"moveOption": 0, "buildOption": 1}\n```';

      const result = ResponseParser.parse(text, 2, 3);

      expect(result.moveOptionIndex).toBe(0);
      expect(result.buildOptionIndex).toBe(1);
    });
  });

  describe('regex fallback for malformed JSON', () => {
    it('should extract indices from malformed JSON via regex', () => {
      const text = '{"moveOption": 2, "buildOption": 1, extra trailing junk...';

      const result = ResponseParser.parse(text, 5, 3);

      expect(result.moveOptionIndex).toBe(2);
      expect(result.buildOptionIndex).toBe(1);
      expect(result.reasoning).toContain('malformed');
    });

    it('should handle negative moveOption in regex fallback', () => {
      const text = 'some prefix "moveOption": -1, "buildOption": 0 trailing';

      const result = ResponseParser.parse(text, 3, 2);

      expect(result.moveOptionIndex).toBe(-1);
    });
  });

  describe('ParseError for unparseable text', () => {
    it('should throw ParseError for completely invalid text', () => {
      expect(() => ResponseParser.parse('hello world', 3, 2)).toThrow(ParseError);
    });

    it('should throw ParseError when only moveOption is found (no buildOption)', () => {
      expect(() =>
        ResponseParser.parse('"moveOption": 1 but no build', 3, 2),
      ).toThrow(ParseError);
    });
  });

  describe('index validation', () => {
    it('should throw ParseError for moveOption >= moveOptionCount', () => {
      const json = JSON.stringify({ moveOption: 5, buildOption: 0 });
      expect(() => ResponseParser.parse(json, 5, 2)).toThrow(ParseError);
    });

    it('should throw ParseError for moveOption < -1', () => {
      const json = JSON.stringify({ moveOption: -2, buildOption: 0 });
      expect(() => ResponseParser.parse(json, 3, 2)).toThrow(ParseError);
    });

    it('should throw ParseError for negative buildOption', () => {
      const json = JSON.stringify({ moveOption: 0, buildOption: -1 });
      expect(() => ResponseParser.parse(json, 3, 2)).toThrow(ParseError);
    });

    it('should throw ParseError for buildOption >= buildOptionCount', () => {
      const json = JSON.stringify({ moveOption: 0, buildOption: 3 });
      expect(() => ResponseParser.parse(json, 3, 3)).toThrow(ParseError);
    });

    it('should accept boundary values (max valid indices)', () => {
      const json = JSON.stringify({ moveOption: 4, buildOption: 2 });

      const result = ResponseParser.parse(json, 5, 3);

      expect(result.moveOptionIndex).toBe(4);
      expect(result.buildOptionIndex).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // parseActionIntent — v6.3 single-action and multi-action parsing
  // ═══════════════════════════════════════════════════════════════════════════

  describe('parseActionIntent', () => {
    describe('single action — clean JSON', () => {
      it('should parse a valid BUILD intent with details', () => {
        const json = JSON.stringify({
          action: 'BUILD',
          details: { toward: 'Berlin' },
          reasoning: 'Need to connect to Berlin',
          planHorizon: 'Next 2 turns',
        });

        const result = ResponseParser.parseActionIntent(json);

        expect(result.action).toBe('BUILD');
        expect(result.details).toEqual({ toward: 'Berlin' });
        expect(result.reasoning).toBe('Need to connect to Berlin');
        expect(result.planHorizon).toBe('Next 2 turns');
      });

      it('should accept all AIActionType enum values', () => {
        for (const actionType of Object.values(AIActionType)) {
          const json = JSON.stringify({
            action: actionType,
            reasoning: 'test',
            planHorizon: '',
          });
          const result = ResponseParser.parseActionIntent(json);
          expect(result.action).toBe(actionType);
        }
      });

      it('should accept all shorthand aliases', () => {
        const aliases = ['BUILD', 'MOVE', 'DELIVER', 'PICKUP', 'UPGRADE', 'DISCARD_HAND', 'PASS'];
        for (const alias of aliases) {
          const json = JSON.stringify({
            action: alias,
            reasoning: 'test',
            planHorizon: '',
          });
          const result = ResponseParser.parseActionIntent(json);
          expect(result.action).toBe(alias);
        }
      });

      it('should default missing reasoning and planHorizon to empty strings', () => {
        const json = JSON.stringify({ action: 'PASS' });

        const result = ResponseParser.parseActionIntent(json);

        expect(result.reasoning).toBe('');
        expect(result.planHorizon).toBe('');
      });

      it('should parse details as undefined when not provided', () => {
        const json = JSON.stringify({ action: 'PASS', reasoning: 'wait' });

        const result = ResponseParser.parseActionIntent(json);

        expect(result.details).toBeUndefined();
      });

      it('should throw ParseError for invalid action type', () => {
        const json = JSON.stringify({ action: 'TELEPORT', reasoning: 'beam me up' });

        expect(() => ResponseParser.parseActionIntent(json)).toThrow(ParseError);
        expect(() => ResponseParser.parseActionIntent(json)).toThrow('Invalid action type');
      });
    });

    describe('single action — markdown fence stripping', () => {
      it('should strip ```json fences', () => {
        const text = '```json\n{"action": "MOVE", "details": {"to": "Berlin"}, "reasoning": "go"}\n```';

        const result = ResponseParser.parseActionIntent(text);

        expect(result.action).toBe('MOVE');
        expect(result.details).toEqual({ to: 'Berlin' });
      });

      it('should strip plain ``` fences', () => {
        const text = '```\n{"action": "PASS", "reasoning": "skip"}\n```';

        const result = ResponseParser.parseActionIntent(text);

        expect(result.action).toBe('PASS');
      });
    });

    describe('single action — regex fallback', () => {
      it('should extract action from malformed JSON via regex', () => {
        const text = '{"action": "BUILD", "details": {"toward": "Berlin"}, trailing junk...';

        const result = ResponseParser.parseActionIntent(text);

        expect(result.action).toBe('BUILD');
        expect(result.details).toEqual({ toward: 'Berlin' });
      });

      it('should extract toward, to, load, and at fields via regex', () => {
        const text = 'broken { "action": "DELIVER", "load": "Steel", "at": "Berlin", "to": "Paris", "toward": "Munich" }}}';

        const result = ResponseParser.parseActionIntent(text);

        expect(result.action).toBe('DELIVER');
        expect(result.details?.load).toBe('Steel');
        expect(result.details?.at).toBe('Berlin');
        expect(result.details?.to).toBe('Paris');
        expect(result.details?.toward).toBe('Munich');
      });

      it('should extract reasoning and planHorizon via regex when available', () => {
        const text = '{"action": "BUILD", "reasoning": "strategic move", "planHorizon": "3 turns" malformed...';

        const result = ResponseParser.parseActionIntent(text);

        expect(result.reasoning).toBe('strategic move');
        expect(result.planHorizon).toBe('3 turns');
      });

      it('should use default reasoning when not extractable via regex', () => {
        const text = '{"action": "PASS" broken json';

        const result = ResponseParser.parseActionIntent(text);

        expect(result.reasoning).toContain('regex fallback');
      });

      it('should throw ParseError for invalid action in regex fallback', () => {
        const text = '{"action": "FLY" broken json';

        expect(() => ResponseParser.parseActionIntent(text)).toThrow(ParseError);
        expect(() => ResponseParser.parseActionIntent(text)).toThrow('Invalid action type');
      });

      it('should throw ParseError when no action extractable', () => {
        const text = 'I think the best move is to build toward Berlin';

        expect(() => ResponseParser.parseActionIntent(text)).toThrow(ParseError);
        expect(() => ResponseParser.parseActionIntent(text)).toThrow('Unparseable');
      });
    });

    describe('multi-action parsing', () => {
      it('should parse a valid multi-action response', () => {
        const json = JSON.stringify({
          actions: [
            { action: 'MOVE', details: { to: 'Berlin' } },
            { action: 'PICKUP', details: { load: 'Steel', at: 'Berlin' } },
          ],
          reasoning: 'Move and pick up',
          planHorizon: 'This turn',
        });

        const result = ResponseParser.parseActionIntent(json);

        expect(result.actions).toHaveLength(2);
        expect(result.actions![0].action).toBe('MOVE');
        expect(result.actions![0].details).toEqual({ to: 'Berlin' });
        expect(result.actions![1].action).toBe('PICKUP');
        expect(result.actions![1].details).toEqual({ load: 'Steel', at: 'Berlin' });
        expect(result.reasoning).toBe('Move and pick up');
      });

      it('should default missing details to empty object in multi-action', () => {
        const json = JSON.stringify({
          actions: [{ action: 'PASS' }],
          reasoning: 'skip',
        });

        const result = ResponseParser.parseActionIntent(json);

        expect(result.actions![0].details).toEqual({});
      });

      it('should throw ParseError for invalid action in multi-action array', () => {
        const json = JSON.stringify({
          actions: [
            { action: 'MOVE', details: { to: 'Berlin' } },
            { action: 'TELEPORT', details: {} },
          ],
          reasoning: 'test',
        });

        expect(() => ResponseParser.parseActionIntent(json)).toThrow(ParseError);
        expect(() => ResponseParser.parseActionIntent(json)).toThrow('TELEPORT');
      });

      it('should throw ParseError for action item missing action field', () => {
        const json = JSON.stringify({
          actions: [{ details: { to: 'Berlin' } }],
          reasoning: 'test',
        });

        expect(() => ResponseParser.parseActionIntent(json)).toThrow(ParseError);
        expect(() => ResponseParser.parseActionIntent(json)).toThrow('Invalid action in multi-action');
      });

      it('should throw ParseError for null item in actions array', () => {
        const json = JSON.stringify({
          actions: [null],
          reasoning: 'test',
        });

        expect(() => ResponseParser.parseActionIntent(json)).toThrow(ParseError);
      });
    });

    describe('missing action/actions field', () => {
      it('should throw ParseError when neither action nor actions is present', () => {
        const json = JSON.stringify({ reasoning: 'I want to build', planHorizon: '2 turns' });

        expect(() => ResponseParser.parseActionIntent(json)).toThrow(ParseError);
        expect(() => ResponseParser.parseActionIntent(json)).toThrow("missing 'action' or 'actions'");
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // parsePlanSelection — v6.3 chain/plan selection
  // ═══════════════════════════════════════════════════════════════════════════

  describe('parsePlanSelection', () => {
    describe('clean JSON parsing', () => {
      it('should parse a valid plan selection response', () => {
        const json = JSON.stringify({
          chainIndex: 2,
          reasoning: 'Best ROI from Steel delivery to Berlin',
        });

        const result = ResponseParser.parsePlanSelection(json, 5);

        expect(result.chainIndex).toBe(2);
        expect(result.reasoning).toBe('Best ROI from Steel delivery to Berlin');
      });

      it('should default missing reasoning to empty string', () => {
        const json = JSON.stringify({ chainIndex: 0 });

        const result = ResponseParser.parsePlanSelection(json, 3);

        expect(result.chainIndex).toBe(0);
        expect(result.reasoning).toBe('');
      });

      it('should accept boundary value (chainCount - 1)', () => {
        const json = JSON.stringify({ chainIndex: 4 });

        const result = ResponseParser.parsePlanSelection(json, 5);

        expect(result.chainIndex).toBe(4);
      });
    });

    describe('markdown fence stripping', () => {
      it('should strip ```json fences', () => {
        const text = '```json\n{"chainIndex": 1, "reasoning": "pick chain 1"}\n```';

        const result = ResponseParser.parsePlanSelection(text, 3);

        expect(result.chainIndex).toBe(1);
      });
    });

    describe('regex fallback', () => {
      it('should extract chainIndex from malformed JSON', () => {
        const text = '{"chainIndex": 2, "reasoning": "best chain" trailing junk...';

        const result = ResponseParser.parsePlanSelection(text, 5);

        expect(result.chainIndex).toBe(2);
        expect(result.reasoning).toContain('malformed');
      });

      it('should throw ParseError for invalid chainIndex in regex fallback', () => {
        const text = '{"chainIndex": 10 broken...';

        expect(() => ResponseParser.parsePlanSelection(text, 3)).toThrow(ParseError);
        expect(() => ResponseParser.parsePlanSelection(text, 3)).toThrow('Invalid chain index');
      });

      it('should throw ParseError when chainIndex not extractable', () => {
        const text = 'I choose option number 2';

        expect(() => ResponseParser.parsePlanSelection(text, 5)).toThrow(ParseError);
        expect(() => ResponseParser.parsePlanSelection(text, 5)).toThrow('Unparseable');
      });
    });

    describe('index validation', () => {
      it('should throw ParseError for negative chainIndex', () => {
        const json = JSON.stringify({ chainIndex: -1 });

        expect(() => ResponseParser.parsePlanSelection(json, 3)).toThrow(ParseError);
        expect(() => ResponseParser.parsePlanSelection(json, 3)).toThrow('Invalid chain index');
      });

      it('should throw ParseError for chainIndex >= chainCount', () => {
        const json = JSON.stringify({ chainIndex: 3 });

        expect(() => ResponseParser.parsePlanSelection(json, 3)).toThrow(ParseError);
      });

      it('should throw ParseError for non-integer chainIndex', () => {
        const json = JSON.stringify({ chainIndex: 1.5 });

        expect(() => ResponseParser.parsePlanSelection(json, 3)).toThrow(ParseError);
      });

      it('should throw ParseError for non-number chainIndex', () => {
        const json = JSON.stringify({ chainIndex: 'two' });

        expect(() => ResponseParser.parsePlanSelection(json, 3)).toThrow(ParseError);
      });

      it('should throw ParseError for null chainIndex', () => {
        const json = JSON.stringify({ chainIndex: null });

        expect(() => ResponseParser.parsePlanSelection(json, 3)).toThrow(ParseError);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // parseStrategicRoute — secondaryBuildTarget parsing
  // ═══════════════════════════════════════════════════════════════════════════

  describe('parseStrategicRoute', () => {
    /** Minimal valid route JSON — all tests extend this base */
    function makeRouteJson(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        route: [
          { action: 'PICKUP', load: 'Steel', city: 'Szczecin' },
          { action: 'DELIVER', load: 'Steel', city: 'Berlin', demandCardId: 42, payment: 15 },
        ],
        startingCity: 'Berlin',
        reasoning: 'Deliver steel for quick profit',
        ...overrides,
      });
    }

    describe('secondaryBuildTarget parsing', () => {
      let warnSpy: jest.SpyInstance;

      beforeEach(() => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      });

      afterEach(() => {
        warnSpy.mockRestore();
      });

      it('should parse valid secondaryBuildTarget with both city and reasoning', () => {
        const json = makeRouteJson({
          secondaryBuildTarget: { city: 'Holland', reasoning: 'Cheap to connect' },
        });

        const result = ResponseParser.parseStrategicRoute(json, 5);

        expect(result.secondaryBuildTarget).toBeDefined();
        expect(result.secondaryBuildTarget!.city).toBe('Holland');
        expect(result.secondaryBuildTarget!.reasoning).toBe('Cheap to connect');
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('should parse valid secondaryBuildTarget with city only (reasoning missing)', () => {
        const json = makeRouteJson({
          secondaryBuildTarget: { city: 'Berlin' },
        });

        const result = ResponseParser.parseStrategicRoute(json, 5);

        expect(result.secondaryBuildTarget).toBeDefined();
        expect(result.secondaryBuildTarget!.city).toBe('Berlin');
        expect(result.secondaryBuildTarget!.reasoning).toBe('');
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('should return undefined when secondaryBuildTarget is absent from JSON', () => {
        const json = makeRouteJson();

        const result = ResponseParser.parseStrategicRoute(json, 5);

        expect(result.secondaryBuildTarget).toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('should return undefined and warn when city is missing from secondaryBuildTarget', () => {
        const json = makeRouteJson({
          secondaryBuildTarget: { reasoning: 'some reason' },
        });

        const result = ResponseParser.parseStrategicRoute(json, 5);

        expect(result.secondaryBuildTarget).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('missing valid "city"'),
        );
      });

      it('should return undefined and warn when city is empty string', () => {
        const json = makeRouteJson({
          secondaryBuildTarget: { city: '' },
        });

        const result = ResponseParser.parseStrategicRoute(json, 5);

        expect(result.secondaryBuildTarget).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('missing valid "city"'),
        );
      });

      it('should return undefined when secondaryBuildTarget is not an object', () => {
        const json = makeRouteJson({
          secondaryBuildTarget: 'just a string',
        });

        const result = ResponseParser.parseStrategicRoute(json, 5);

        expect(result.secondaryBuildTarget).toBeUndefined();
      });

      it('should return undefined when secondaryBuildTarget is an array', () => {
        const json = makeRouteJson({
          secondaryBuildTarget: ['Berlin'],
        });

        const result = ResponseParser.parseStrategicRoute(json, 5);

        expect(result.secondaryBuildTarget).toBeUndefined();
      });

      it('should return undefined when secondaryBuildTarget is null', () => {
        const json = makeRouteJson({
          secondaryBuildTarget: null,
        });

        const result = ResponseParser.parseStrategicRoute(json, 5);

        expect(result.secondaryBuildTarget).toBeUndefined();
      });

      it('should trim whitespace from city name', () => {
        const json = makeRouteJson({
          secondaryBuildTarget: { city: '  Hamburg  ', reasoning: 'port access' },
        });

        const result = ResponseParser.parseStrategicRoute(json, 5);

        expect(result.secondaryBuildTarget).toBeDefined();
        expect(result.secondaryBuildTarget!.city).toBe('Hamburg');
      });

      it('should warn when city is whitespace-only string', () => {
        const json = makeRouteJson({
          secondaryBuildTarget: { city: '   ' },
        });

        const result = ResponseParser.parseStrategicRoute(json, 5);

        expect(result.secondaryBuildTarget).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('missing valid "city"'),
        );
      });
    });
  });
});
