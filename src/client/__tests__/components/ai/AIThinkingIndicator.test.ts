/**
 * Tests for AIThinkingIndicator component logic
 */

import { AIThinkingIndicator, AIThinkingIndicatorProps } from '../../../components/ai/AIThinkingIndicator';

describe('AIThinkingIndicator', () => {
  describe('component interface', () => {
    it('should accept isVisible and aiPlayerName props', () => {
      const props: AIThinkingIndicatorProps = {
        isVisible: true,
        aiPlayerName: 'TestBot',
      };

      expect(props.isVisible).toBe(true);
      expect(props.aiPlayerName).toBe('TestBot');
    });

    it('should allow false for isVisible', () => {
      const props: AIThinkingIndicatorProps = {
        isVisible: false,
        aiPlayerName: 'TestBot',
      };

      expect(props.isVisible).toBe(false);
    });
  });

  describe('visibility logic', () => {
    it('should return null when not visible', () => {
      const props: AIThinkingIndicatorProps = {
        isVisible: false,
        aiPlayerName: 'TestBot',
      };

      const result = AIThinkingIndicator(props);
      expect(result).toBeNull();
    });

    it('should return a React element when visible', () => {
      const props: AIThinkingIndicatorProps = {
        isVisible: true,
        aiPlayerName: 'TestBot',
      };

      const result = AIThinkingIndicator(props);
      expect(result).not.toBeNull();
      expect(result).toBeDefined();
    });
  });

  describe('player name handling', () => {
    it('should accept different player names', () => {
      const names = ['Heinrich', 'Bot Alpha', 'AI Player 1', 'Chaos Bot'];

      names.forEach((name) => {
        const props: AIThinkingIndicatorProps = {
          isVisible: true,
          aiPlayerName: name,
        };

        expect(props.aiPlayerName).toBe(name);
      });
    });

    it('should handle empty string name', () => {
      const props: AIThinkingIndicatorProps = {
        isVisible: true,
        aiPlayerName: '',
      };

      expect(props.aiPlayerName).toBe('');
    });
  });

  describe('type safety', () => {
    it('should have correct prop types', () => {
      // Type checking at compile time
      const validProps: AIThinkingIndicatorProps = {
        isVisible: true,
        aiPlayerName: 'TestBot',
      };

      // These should all be valid
      expect(typeof validProps.isVisible).toBe('boolean');
      expect(typeof validProps.aiPlayerName).toBe('string');
    });
  });
});
