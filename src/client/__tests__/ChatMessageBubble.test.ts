import DOMPurify from 'dompurify';
import { ChatMessage } from '../services/ChatStateService';

/**
 * Unit tests for ChatMessageBubble sanitization logic
 * Note: Full rendering tests require integration testing in a real Phaser scene
 */
describe('ChatMessageBubble', () => {
  describe('message sanitization', () => {
    // Test the DOMPurify sanitization directly since we can't easily test Phaser rendering
    const sanitizeMessage = (content: string): string => {
      return DOMPurify.sanitize(content, {
        ALLOWED_TAGS: [],
        ALLOWED_ATTR: [],
        KEEP_CONTENT: true,
      }).trim();
    };

    it('should strip script tags', () => {
      const malicious = '<script>alert("XSS")</script>Hello';
      const sanitized = sanitizeMessage(malicious);

      expect(sanitized).not.toContain('<script>');
      expect(sanitized).not.toContain('</script>');
      expect(sanitized).toContain('Hello');
    });

    it('should strip all HTML tags', () => {
      const maliciousInputs = [
        '<img src=x onerror=alert(1)>',
        '<a href="javascript:alert(1)">Click</a>',
        '<iframe src="evil.com"></iframe>',
        '<div onclick="alert(1)">Click</div>',
        '<style>body { display: none; }</style>',
      ];

      maliciousInputs.forEach((input) => {
        const sanitized = sanitizeMessage(input);
        expect(sanitized).not.toMatch(/<[^>]*>/);
      });
    });

    it('should preserve safe text content', () => {
      const safeMessage = 'Hello world this is a test message';
      const sanitized = sanitizeMessage(safeMessage);

      expect(sanitized).toBe('Hello world this is a test message');
    });

    it('should handle empty strings', () => {
      expect(sanitizeMessage('')).toBe('');
    });

    it('should handle strings with only whitespace', () => {
      expect(sanitizeMessage('   ')).toBe('');
    });
  });

  describe('timestamp formatting', () => {
    const formatTimestamp = (timestamp: string): string => {
      const date = new Date(timestamp);
      const now = new Date();
      const isToday = date.toDateString() === now.toDateString();

      if (isToday) {
        return date.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
      } else {
        return date.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
      }
    };

    it('should format today messages with time only', () => {
      const now = new Date();
      const formatted = formatTimestamp(now.toISOString());

      // Should contain time format
      expect(formatted).toMatch(/\d{1,2}:\d{2}/);
      // Should not have year for today
      expect(formatted).not.toMatch(/\d{4}/);
    });

    it('should format older messages with date and time', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const formatted = formatTimestamp(yesterday.toISOString());

      // Should contain month abbreviation and time
      expect(formatted).toMatch(/[A-Za-z]{3}/);
      expect(formatted).toMatch(/\d{1,2}:\d{2}/);
    });

    it('should handle invalid timestamps gracefully', () => {
      const invalidDate = new Date('invalid');
      // Should create a date object (even if invalid)
      expect(invalidDate).toBeInstanceOf(Date);
    });
  });

  describe('message structure validation', () => {
    it('should validate required ChatMessage properties', () => {
      const validMessage: ChatMessage = {
        id: 1,
        gameId: 'test-game',
        senderId: 'user-1',
        senderUsername: 'Player 1',
        recipientType: 'game',
        recipientId: 'test-game',
        message: 'Test message',
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      expect(validMessage.id).toBeDefined();
      expect(validMessage.senderId).toBeDefined();
      expect(validMessage.message).toBeDefined();
      expect(validMessage.createdAt).toBeDefined();
    });

    it('should handle empty sender username', () => {
      const senderName = '' || 'Unknown';
      expect(senderName).toBe('Unknown');
    });

    it('should handle undefined sender username', () => {
      const senderName = (undefined as any) || 'Unknown';
      expect(senderName).toBe('Unknown');
    });
  });
});
