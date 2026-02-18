import { ResponseParser, ParseError } from '../../services/ai/ResponseParser';

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
});
