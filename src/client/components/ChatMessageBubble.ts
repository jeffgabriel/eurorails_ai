import 'phaser';
import { ChatMessage } from '../services/ChatStateService';
import { UI_FONT_FAMILY } from '../config/uiFont';
import DOMPurify from 'dompurify';

/**
 * ChatMessageBubble - Component for rendering individual chat messages
 * 
 * Features:
 * - Styled differently for own vs other messages
 * - Sanitizes HTML to prevent XSS
 * - Shows sender name and timestamp
 * - Word wrapping for long messages
 */
export class ChatMessageBubble extends Phaser.GameObjects.Container {
  private message: ChatMessage;
  private isOwnMessage: boolean;
  private maxWidth: number;

  // Constants
  private readonly BUBBLE_PADDING = 12;
  private readonly MAX_MESSAGE_WIDTH = 250;
  private readonly TIMESTAMP_HEIGHT = 18;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    maxWidth: number,
    message: ChatMessage,
    isOwnMessage: boolean
  ) {
    super(scene, x, y);

    this.message = message;
    this.isOwnMessage = isOwnMessage;
    this.maxWidth = Math.min(maxWidth, this.MAX_MESSAGE_WIDTH);

    this.render();
    scene.add.existing(this);
  }

  /**
   * Render the message bubble
   */
  private render(): void {
    // Sanitize message content to prevent XSS
    const sanitizedContent = this.sanitizeMessage(this.message.message);

    // Create text elements
    const senderText = this.createSenderText();
    const messageText = this.createMessageText(sanitizedContent);
    const timestampText = this.createTimestampText();

    // Calculate bubble dimensions
    const bubbleWidth = Math.min(
      this.maxWidth,
      Math.max(messageText.width, senderText.width) + this.BUBBLE_PADDING * 2
    );
    const bubbleHeight =
      messageText.height +
      senderText.height +
      this.TIMESTAMP_HEIGHT +
      this.BUBBLE_PADDING * 2;

    // Create bubble background
    const bubble = this.createBubbleBackground(bubbleWidth, bubbleHeight);

    // Position elements
    const align = this.isOwnMessage ? 'right' : 'left';
    const bubbleX = this.isOwnMessage ? this.maxWidth - bubbleWidth : 0;

    bubble.setPosition(bubbleX, 0);

    if (this.isOwnMessage) {
      senderText.setPosition(bubbleX + bubbleWidth - this.BUBBLE_PADDING, this.BUBBLE_PADDING);
      senderText.setOrigin(1, 0);

      messageText.setPosition(
        bubbleX + bubbleWidth - this.BUBBLE_PADDING,
        this.BUBBLE_PADDING + senderText.height + 4
      );
      messageText.setOrigin(1, 0);

      timestampText.setPosition(
        bubbleX + bubbleWidth - this.BUBBLE_PADDING,
        bubbleHeight - this.BUBBLE_PADDING - 2
      );
      timestampText.setOrigin(1, 1);
    } else {
      senderText.setPosition(bubbleX + this.BUBBLE_PADDING, this.BUBBLE_PADDING);
      senderText.setOrigin(0, 0);

      messageText.setPosition(
        bubbleX + this.BUBBLE_PADDING,
        this.BUBBLE_PADDING + senderText.height + 4
      );
      messageText.setOrigin(0, 0);

      timestampText.setPosition(
        bubbleX + this.BUBBLE_PADDING,
        bubbleHeight - this.BUBBLE_PADDING - 2
      );
      timestampText.setOrigin(0, 1);
    }

    // Add to container
    this.add([bubble, senderText, messageText, timestampText]);
  }

  /**
   * Sanitize message content using DOMPurify
   */
  private sanitizeMessage(content: string): string {
    // Configure DOMPurify to strip all HTML tags
    const clean = DOMPurify.sanitize(content, {
      ALLOWED_TAGS: [], // No HTML tags allowed
      ALLOWED_ATTR: [], // No attributes allowed
      KEEP_CONTENT: true, // Keep text content
    });

    return clean.trim();
  }

  /**
   * Create sender name text
   */
  private createSenderText(): Phaser.GameObjects.Text {
    const color = this.isOwnMessage ? '#a0d0ff' : '#ffcc00';
    const senderName = this.message.senderUsername || 'Unknown';

    return this.scene.add.text(0, 0, senderName, {
      fontSize: '12px',
      fontFamily: UI_FONT_FAMILY,
      color,
      fontStyle: 'bold',
    });
  }

  /**
   * Create message content text with word wrapping
   */
  private createMessageText(content: string): Phaser.GameObjects.Text {
    return this.scene.add.text(0, 0, content, {
      fontSize: '14px',
      fontFamily: UI_FONT_FAMILY,
      color: '#ffffff',
      wordWrap: {
        width: this.maxWidth - this.BUBBLE_PADDING * 2,
        useAdvancedWrap: true,
      },
    });
  }

  /**
   * Create timestamp text
   */
  private createTimestampText(): Phaser.GameObjects.Text {
    const timestamp = this.formatTimestamp(this.message.createdAt);

    return this.scene.add.text(0, 0, timestamp, {
      fontSize: '10px',
      fontFamily: UI_FONT_FAMILY,
      color: '#999999',
    });
  }

  /**
   * Create bubble background with rounded corners
   */
  private createBubbleBackground(
    width: number,
    height: number
  ): Phaser.GameObjects.Graphics {
    const graphics = this.scene.add.graphics();

    // Different colors for own vs other messages
    const fillColor = this.isOwnMessage ? 0x0066cc : 0x4a4a4a;
    const borderColor = this.isOwnMessage ? 0x0055aa : 0x333333;

    graphics.fillStyle(fillColor, 1);
    graphics.lineStyle(1, borderColor, 1);

    // Draw rounded rectangle
    graphics.fillRoundedRect(0, 0, width, height, 8);
    graphics.strokeRoundedRect(0, 0, width, height, 8);

    return graphics;
  }

  /**
   * Format timestamp for display
   */
  private formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      // Show time only for today's messages
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } else {
      // Show date and time for older messages
      return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    }
  }
}
