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
  private bubbleGraphics!: Phaser.GameObjects.Graphics;
  private bubbleWidth: number = 0;
  private bubbleHeight: number = 0;
  private bubbleX: number = 0;
  private flaggedTooltipText: string | null = null;

  // Constants
  private readonly BUBBLE_PADDING = 12;
  private readonly MIN_BUBBLE_WIDTH = 120;
  private readonly MAX_BUBBLE_WIDTH = 250;
  private readonly TIMESTAMP_HEIGHT = 18;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    containerWidth: number,
    message: ChatMessage,
    isOwnMessage: boolean
  ) {
    super(scene, x, y);

    this.message = message;
    this.isOwnMessage = isOwnMessage;
    this.maxWidth = containerWidth;

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

    // Calculate bubble dimensions - constrain bubble width but not container
    const contentWidth = Math.max(messageText.width, senderText.width) + this.BUBBLE_PADDING * 2;
    this.bubbleWidth = Math.max(this.MIN_BUBBLE_WIDTH, Math.min(contentWidth, this.MAX_BUBBLE_WIDTH));
    this.bubbleHeight =
      messageText.height +
      senderText.height +
      this.TIMESTAMP_HEIGHT +
      this.BUBBLE_PADDING * 2;

    // Create bubble background
    const bubble = this.createBubbleBackground(this.bubbleWidth, this.bubbleHeight);
    this.bubbleGraphics = bubble;

    // Position bubble: left-aligned for others, right-aligned for own messages
    this.bubbleX = this.isOwnMessage ? this.maxWidth - this.bubbleWidth : 0;
    bubble.setPosition(this.bubbleX, 0);

    // Position text elements inside the bubble (always left-aligned within bubble)
    senderText.setPosition(this.bubbleX + this.BUBBLE_PADDING, this.BUBBLE_PADDING);
    senderText.setOrigin(0, 0);

    messageText.setPosition(
      this.bubbleX + this.BUBBLE_PADDING,
      this.BUBBLE_PADDING + senderText.height + 4
    );
    messageText.setOrigin(0, 0);

    timestampText.setPosition(
      this.bubbleX + this.BUBBLE_PADDING,
      this.bubbleHeight - this.BUBBLE_PADDING - 2
    );
    timestampText.setOrigin(0, 1);

    // Add to container
    this.add([bubble, senderText, messageText, timestampText]);

    // Set container size explicitly for proper layout calculation
    this.setSize(this.maxWidth, this.bubbleHeight);
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
        width: this.MAX_BUBBLE_WIDTH - this.BUBBLE_PADDING * 2,
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
   * Mark this bubble as flagged by moderation with a warning icon.
   * Tooltip display is handled by ChatScene since the scroll zone captures pointer events.
   */
  public markAsFlagged(tooltipText: string): void {
    this.flaggedTooltipText = tooltipText;

    // Redraw bubble background with red/orange border
    this.bubbleGraphics.clear();
    const fillColor = this.isOwnMessage ? 0x0066cc : 0x4a4a4a;
    const flaggedBorderColor = 0xcc3300;

    this.bubbleGraphics.fillStyle(fillColor, 1);
    this.bubbleGraphics.lineStyle(2, flaggedBorderColor, 1);
    this.bubbleGraphics.fillRoundedRect(0, 0, this.bubbleWidth, this.bubbleHeight, 8);
    this.bubbleGraphics.strokeRoundedRect(0, 0, this.bubbleWidth, this.bubbleHeight, 8);

    // Add warning icon at top-right of the bubble
    const warningIcon = this.scene.add.text(
      this.bubbleX + this.bubbleWidth - 8,
      4,
      '\u26A0',
      {
        fontSize: '14px',
        fontFamily: UI_FONT_FAMILY,
        color: '#ff6600',
      }
    ).setOrigin(1, 0);
    this.add(warningIcon);
  }

  /**
   * Returns the flagged tooltip text, or null if not flagged.
   */
  public getFlaggedTooltipText(): string | null {
    return this.flaggedTooltipText;
  }

  /**
   * Check if a local point (relative to the parent container) is within this bubble's bounds.
   */
  public containsPoint(localX: number, localY: number): boolean {
    return (
      localX >= this.x + this.bubbleX &&
      localX <= this.x + this.bubbleX + this.bubbleWidth &&
      localY >= this.y &&
      localY <= this.y + this.bubbleHeight
    );
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
