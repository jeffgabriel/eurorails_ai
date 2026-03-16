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
  // Fast-path: pre-validated JSON object inputs (structured output)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('parseActionIntent — fast-path (object input)', () => {
    it('should parse a pre-validated single action object directly', () => {
      const obj = {
        action: 'BUILD',
        details: { toward: 'Berlin' },
        reasoning: 'Connect to demand city',
        planHorizon: 'Next 2 turns',
      };

      const result = ResponseParser.parseActionIntent(obj);

      expect(result.action).toBe('BUILD');
      expect(result.details).toEqual({ toward: 'Berlin' });
      expect(result.reasoning).toBe('Connect to demand city');
      expect(result.planHorizon).toBe('Next 2 turns');
    });

    it('should parse a pre-validated multi-action object directly', () => {
      const obj = {
        actions: [
          { action: 'MOVE', details: { to: 'Paris' } },
          { action: 'DELIVER', details: { load: 'Wine', at: 'Paris' } },
        ],
        reasoning: 'Move and deliver',
        planHorizon: 'This turn',
      };

      const result = ResponseParser.parseActionIntent(obj);

      expect(result.actions).toHaveLength(2);
      expect(result.actions![0].action).toBe('MOVE');
      expect(result.actions![1].action).toBe('DELIVER');
      expect(result.reasoning).toBe('Move and deliver');
    });

    it('should throw ParseError for invalid action type in object input', () => {
      const obj = { action: 'TELEPORT', reasoning: 'invalid' };

      expect(() => ResponseParser.parseActionIntent(obj)).toThrow(ParseError);
      expect(() => ResponseParser.parseActionIntent(obj)).toThrow('Invalid action type');
    });

    it('should throw ParseError when object has neither action nor actions', () => {
      const obj = { reasoning: 'no action here' };

      expect(() => ResponseParser.parseActionIntent(obj)).toThrow(ParseError);
      expect(() => ResponseParser.parseActionIntent(obj)).toThrow("missing 'action' or 'actions'");
    });
  });

  describe('parseStrategicRoute — fast-path (object input)', () => {
    it('should parse a pre-validated route object directly', () => {
      const obj = {
        route: [
          { action: 'PICKUP', load: 'Coal', city: 'Ruhr' },
          { action: 'DELIVER', load: 'Coal', city: 'Berlin', demandCardId: 7, payment: 20 },
        ],
        startingCity: 'Ruhr',
        reasoning: 'Quick coal delivery',
      };

      const result = ResponseParser.parseStrategicRoute(obj, 10);

      expect(result.stops).toHaveLength(2);
      expect(result.stops[0]).toEqual({ action: 'pickup', loadType: 'Coal', city: 'Ruhr' });
      expect(result.stops[1]).toEqual({
        action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 7, payment: 20,
      });
      expect(result.startingCity).toBe('Ruhr');
      expect(result.reasoning).toBe('Quick coal delivery');
      expect(result.createdAtTurn).toBe(10);
      expect(result.currentStopIndex).toBe(0);
      expect(result.phase).toBe('build');
    });

    it('should parse upgradeOnRoute when present', () => {
      const obj = {
        route: [
          { action: 'PICKUP', load: 'Coal', city: 'Ruhr' },
          { action: 'DELIVER', load: 'Coal', city: 'Berlin' },
        ],
        startingCity: 'Ruhr',
        upgradeOnRoute: 'FastFreight',
        reasoning: 'Upgrade then deliver coal',
      };

      const result = ResponseParser.parseStrategicRoute(obj, 5);

      expect(result.upgradeOnRoute).toBe('fast_freight');
      expect(result.stops).toHaveLength(2);
      expect(result.reasoning).toBe('Upgrade then deliver coal');
    });

    it('should set upgradeOnRoute to undefined when absent', () => {
      const obj = {
        route: [
          { action: 'PICKUP', load: 'Coal', city: 'Ruhr' },
          { action: 'DELIVER', load: 'Coal', city: 'Berlin' },
        ],
        startingCity: 'Ruhr',
        reasoning: 'No upgrade',
      };

      const result = ResponseParser.parseStrategicRoute(obj, 5);

      expect(result.upgradeOnRoute).toBeUndefined();
    });

    it('should pass through arbitrary upgradeOnRoute values without validation', () => {
      const obj = {
        route: [
          { action: 'PICKUP', load: 'Coal', city: 'Ruhr' },
          { action: 'DELIVER', load: 'Coal', city: 'Berlin' },
        ],
        startingCity: 'Ruhr',
        upgradeOnRoute: 'InvalidTrain',
        reasoning: 'Bad upgrade value',
      };

      const result = ResponseParser.parseStrategicRoute(obj, 5);

      expect(result.upgradeOnRoute).toBe('InvalidTrain');
    });

    it('should throw ParseError for empty route array in object input', () => {
      const obj = { route: [], reasoning: 'empty' };

      expect(() => ResponseParser.parseStrategicRoute(obj, 1)).toThrow(ParseError);
      expect(() => ResponseParser.parseStrategicRoute(obj, 1)).toThrow('non-empty');
    });

    it('should throw ParseError for invalid route stop action in object input', () => {
      const obj = {
        route: [{ action: 'MOVE', load: 'Steel', city: 'Berlin' }],
        reasoning: 'bad action',
      };

      expect(() => ResponseParser.parseStrategicRoute(obj, 1)).toThrow(ParseError);
      expect(() => ResponseParser.parseStrategicRoute(obj, 1)).toThrow('Must be PICKUP or DELIVER');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Truncated JSON recovery (JIRA-70)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('parseStrategicRoute — truncated JSON recovery', () => {
    it('should recover truncated JSON missing closing }', () => {
      const truncated = '{"route": [{"action": "PICKUP", "load": "Coal", "city": "Ruhr"}, {"action": "DELIVER", "load": "Coal", "city": "Berlin"}], "reasoning": "test"';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = ResponseParser.parseStrategicRoute(truncated, 5);

      expect(result.stops).toHaveLength(2);
      expect(result.stops[0].action).toBe('pickup');
      expect(result.stops[0].loadType).toBe('Coal');
      expect(warnSpy).toHaveBeenCalledWith('[ResponseParser] Recovered truncated JSON response');
      warnSpy.mockRestore();
    });

    it('should recover truncated JSON missing ]}', () => {
      const truncated = '{"route": [{"action": "PICKUP", "load": "Steel", "city": "Szczecin"}, {"action": "DELIVER", "load": "Steel", "city": "Berlin"}';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = ResponseParser.parseStrategicRoute(truncated, 3);

      expect(result.stops).toHaveLength(2);
      expect(result.stops[1].city).toBe('Berlin');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should throw ParseError for severely truncated JSON (cut mid-string)', () => {
      const truncated = '{"route": [{"action": "PICK';

      expect(() => ResponseParser.parseStrategicRoute(truncated, 1)).toThrow(ParseError);
    });

    it('should recover markdown-fenced truncated JSON', () => {
      const fenced = '```json\n{"route": [{"action": "PICKUP", "load": "Oil", "city": "Roma"}], "reasoning": "deliver oil"\n```';
      // This is actually complete — verify it parses normally via fence stripping
      const result = ResponseParser.parseStrategicRoute(fenced, 1);
      expect(result.stops).toHaveLength(1);
      expect(result.stops[0].loadType).toBe('Oil');
    });

    it('should recover markdown-fenced truncated JSON with missing brackets', () => {
      const fencedTruncated = '```json\n{"route": [{"action": "PICKUP", "load": "Oil", "city": "Roma"}], "reasoning": "test"\n```';
      // Strip fences first, then truncate — simulate what Haiku produces
      const truncated = '{"route": [{"action": "PICKUP", "load": "Oil", "city": "Roma"}], "reasoning": "test"';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      // This one is actually complete JSON, test a truly truncated one
      const realTruncated = '```json\n{"route": [{"action": "PICKUP", "load": "Oil", "city": "Roma"}\n```';

      const result = ResponseParser.parseStrategicRoute(realTruncated, 1);
      expect(result.stops).toHaveLength(1);
      expect(result.stops[0].loadType).toBe('Oil');
      warnSpy.mockRestore();
    });
  });

  describe('parseActionIntent — truncated JSON recovery', () => {
    it('should recover truncated action intent JSON', () => {
      const truncated = '{"action": "BUILD", "details": {"toward": "Berlin"}, "reasoning": "connect to Berlin"';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = ResponseParser.parseActionIntent(truncated);

      expect(result.action).toBe('BUILD');
      expect(result.details).toEqual({ toward: 'Berlin' });
      expect(warnSpy).toHaveBeenCalledWith('[ResponseParser] Recovered truncated JSON response');
      warnSpy.mockRestore();
    });

    it('should fall through to regex fallback when recovery fails', () => {
      // Severely truncated — recovery fails, but regex can extract action
      const truncated = '{"action": "PASS" some garbage that breaks everything';

      const result = ResponseParser.parseActionIntent(truncated);

      expect(result.action).toBe('PASS');
      expect(result.reasoning).toContain('regex fallback');
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

    it('should ignore secondaryBuildTarget in LLM response (field removed)', () => {
      // LLM may still send secondaryBuildTarget in its response JSON —
      // parser should silently ignore it (field removed from StrategicRoute type)
      const json = makeRouteJson({
        secondaryBuildTarget: { city: 'Holland', reasoning: 'Cheap to connect' },
      });

      const result = ResponseParser.parseStrategicRoute(json, 5);

      // secondaryBuildTarget is not on the type — the parser just doesn't read it
      expect((result as any).secondaryBuildTarget).toBeUndefined();
    });
  });
});
