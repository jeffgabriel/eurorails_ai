import 'phaser';
import { chatStateService, ChatMessage } from '../services/ChatStateService';
import { ChatMessageBubble } from '../components/ChatMessageBubble';
import { UI_FONT_FAMILY } from '../config/uiFont';
import DOMPurify from 'dompurify';

/**
 * ChatScene - Right-side sliding sidebar for in-game chat
 * Displays on top of GameScene when opened
 * 
 * Features:
 * - Sliding animation (open/close)
 * - Scrollable message history
 * - Text input with send button
 * - Unread message indicators
 * - Responsive (full screen on mobile)
 */
export class ChatScene extends Phaser.Scene {
  private gameId: string = '';
  private userId: string = '';
  private isOpen: boolean = false;
  private isMobile: boolean = false;

  // UI components
  private container!: Phaser.GameObjects.Container;
  private background!: Phaser.GameObjects.Rectangle;
  private messagesContainer!: Phaser.GameObjects.Container;
  private messagesList: ChatMessageBubble[] = [];
  private inputField?: HTMLInputElement;
  private scrollPosition: number = 0;
  private maxScroll: number = 0;

  // Constants
  private readonly SIDEBAR_WIDTH_DESKTOP = 350;
  private readonly SIDEBAR_WIDTH_MOBILE = '100%';
  private readonly HEADER_HEIGHT = 60;
  private readonly INPUT_HEIGHT = 80;
  private readonly MESSAGE_PADDING = 10;
  private readonly ANIMATION_DURATION = 300;

  constructor() {
    super({ key: 'ChatScene' });
  }

  init(data: { gameId: string; userId: string }) {
    this.gameId = data.gameId;
    this.userId = data.userId;
    this.isMobile = this.scale.width < 768;
  }

  async create() {
    // Initialize chat state service if not already done
    if (!chatStateService['initialized']) {
      await chatStateService.initialize(this.userId);
    }

    // Create main container (initially offscreen)
    this.container = this.add.container(this.scale.width, 0);

    // Build UI
    this.createBackground();
    this.createHeader();
    this.createMessagesArea();
    this.createInputArea();

    // Set up event listeners
    this.setupChatListeners();
    this.setupResizeListener();
    this.setupInputHandlers();

    // Join the game chat
    await this.joinChat();

    // Start closed
    this.isOpen = false;
  }

  /**
   * Create semi-transparent background
   */
  private createBackground(): void {
    const width = this.isMobile ? this.scale.width : this.SIDEBAR_WIDTH_DESKTOP;
    const height = this.scale.height;

    this.background = this.add.rectangle(0, 0, width, height, 0x2c2c2c, 0.95)
      .setOrigin(0, 0);

    this.container.add(this.background);
  }

  /**
   * Create header with title and close button
   */
  private createHeader(): void {
    const width = this.isMobile ? this.scale.width : this.SIDEBAR_WIDTH_DESKTOP;

    // Header background
    const headerBg = this.add.rectangle(0, 0, width, this.HEADER_HEIGHT, 0x1a1a1a, 1)
      .setOrigin(0, 0);
    this.container.add(headerBg);

    // Title
    const title = this.add.text(15, this.HEADER_HEIGHT / 2, 'Game Chat', {
      fontSize: '20px',
      fontFamily: UI_FONT_FAMILY,
      color: '#ffffff',
      fontStyle: 'bold',
    }).setOrigin(0, 0.5);
    this.container.add(title);

    // Close button
    const closeBtn = this.add.text(width - 15, this.HEADER_HEIGHT / 2, '✕', {
      fontSize: '24px',
      fontFamily: UI_FONT_FAMILY,
      color: '#ffffff',
    }).setOrigin(1, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.close());

    this.container.add(closeBtn);

    // Divider line
    const divider = this.add.rectangle(0, this.HEADER_HEIGHT, width, 2, 0x444444, 1)
      .setOrigin(0, 0);
    this.container.add(divider);
  }

  /**
   * Create scrollable messages area
   */
  private createMessagesArea(): void {
    const width = this.isMobile ? this.scale.width : this.SIDEBAR_WIDTH_DESKTOP;
    const height = this.scale.height - this.HEADER_HEIGHT - this.INPUT_HEIGHT;

    // Messages container (scrollable)
    this.messagesContainer = this.add.container(0, this.HEADER_HEIGHT);
    this.container.add(this.messagesContainer);

    // Set up scroll zone
    const scrollZone = this.add.zone(0, this.HEADER_HEIGHT, width, height)
      .setOrigin(0, 0)
      .setInteractive();

    // Scroll wheel support
    scrollZone.on('wheel', (pointer: Phaser.Input.Pointer, deltaX: number, deltaY: number) => {
      this.scroll(deltaY * 0.5);
    });

    // Touch/drag scroll support
    let startY = 0;
    scrollZone.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      startY = pointer.y;
    });

    scrollZone.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (pointer.isDown) {
        const deltaY = startY - pointer.y;
        this.scroll(deltaY);
        startY = pointer.y;
      }
    });

    this.container.add(scrollZone);
  }

  /**
   * Create input area with text field and send button
   */
  private createInputArea(): void {
    const width = this.isMobile ? this.scale.width : this.SIDEBAR_WIDTH_DESKTOP;
    const inputY = this.scale.height - this.INPUT_HEIGHT;

    // Input background
    const inputBg = this.add.rectangle(0, inputY, width, this.INPUT_HEIGHT, 0x1a1a1a, 1)
      .setOrigin(0, 0);
    this.container.add(inputBg);

    // Create HTML input element
    this.inputField = document.createElement('input');
    this.inputField.type = 'text';
    this.inputField.placeholder = 'Type a message...';
    this.inputField.maxLength = 500;
    this.inputField.className = 'chat-input';
    this.inputField.style.cssText = `
      position: absolute;
      left: ${this.scale.width - width + 15}px;
      top: ${inputY + 15}px;
      width: ${width - 90}px;
      height: 40px;
      padding: 0 10px;
      font-size: 14px;
      font-family: ${UI_FONT_FAMILY};
      background: #3c3c3c;
      border: 1px solid #555;
      border-radius: 4px;
      color: #ffffff;
      outline: none;
      z-index: 1000;
    `;

    document.body.appendChild(this.inputField);

    // Send button (Phaser)
    const sendBtn = this.add.text(width - 65, inputY + 35, 'Send', {
      fontSize: '14px',
      fontFamily: UI_FONT_FAMILY,
      color: '#ffffff',
      backgroundColor: '#0066cc',
      padding: { x: 15, y: 8 },
    }).setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.sendMessage());

    this.container.add(sendBtn);
  }

  /**
   * Set up chat state service listeners
   */
  private setupChatListeners(): void {
    // Listen for new messages
    chatStateService.onMessage(this.gameId, (message: ChatMessage) => {
      this.addMessageBubble(message);
      this.scrollToBottom();
    });

    // Listen for unread count changes
    chatStateService.onUnreadCount((gameId: string, count: number) => {
      if (gameId === this.gameId && this.isOpen) {
        // Mark visible messages as read
        this.markVisibleMessagesAsRead();
      }
    });

    // Listen for errors
    chatStateService.onError((error) => {
      this.showError(error.message);
    });
  }

  /**
   * Set up window resize listener
   */
  private setupResizeListener(): void {
    this.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
      this.handleResize(gameSize.width, gameSize.height);
    });
  }

  /**
   * Set up input keyboard handlers
   */
  private setupInputHandlers(): void {
    if (!this.inputField) return;

    // Send on Enter key
    this.inputField.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
  }

  /**
   * Join the game chat
   */
  private async joinChat(): Promise<void> {
    try {
      await chatStateService.joinGameChat(this.gameId);

      // Load existing messages
      const messages = chatStateService.getMessages(this.gameId);
      messages.forEach((msg) => this.addMessageBubble(msg));
      this.scrollToBottom();
    } catch (error) {
      console.error('[ChatScene] Failed to join chat:', error);
      this.showError('Failed to connect to chat');
    }
  }

  /**
   * Send a message
   */
  private async sendMessage(): Promise<void> {
    if (!this.inputField || !this.inputField.value.trim()) {
      return;
    }

    const message = this.inputField.value.trim();
    this.inputField.value = '';

    try {
      await chatStateService.sendMessage(this.gameId, message);
    } catch (error) {
      console.error('[ChatScene] Failed to send message:', error);
      this.showError('Failed to send message');
    }
  }

  /**
   * Add a message bubble to the display
   */
  private addMessageBubble(message: ChatMessage): void {
    const width = this.isMobile ? this.scale.width : this.SIDEBAR_WIDTH_DESKTOP;
    const isOwnMessage = message.senderId === this.userId;

    // Calculate Y position (stack from top)
    const yPosition = this.messagesList.length * 80 + this.MESSAGE_PADDING;

    const bubble = new ChatMessageBubble(
      this,
      this.MESSAGE_PADDING,
      yPosition,
      width - (this.MESSAGE_PADDING * 2),
      message,
      isOwnMessage
    );

    this.messagesList.push(bubble);
    this.messagesContainer.add(bubble);

    // Update scroll bounds
    this.updateScrollBounds();
  }

  /**
   * Scroll the messages area
   */
  private scroll(deltaY: number): void {
    this.scrollPosition = Phaser.Math.Clamp(
      this.scrollPosition + deltaY,
      0,
      this.maxScroll
    );

    this.messagesContainer.setY(this.HEADER_HEIGHT - this.scrollPosition);
  }

  /**
   * Scroll to bottom (show latest messages)
   */
  private scrollToBottom(): void {
    this.scrollPosition = this.maxScroll;
    this.messagesContainer.setY(this.HEADER_HEIGHT - this.scrollPosition);
  }

  /**
   * Update scroll bounds based on content height
   */
  private updateScrollBounds(): void {
    const contentHeight = this.messagesList.length * 80;
    const visibleHeight = this.scale.height - this.HEADER_HEIGHT - this.INPUT_HEIGHT;
    this.maxScroll = Math.max(0, contentHeight - visibleHeight);
  }

  /**
   * Mark visible messages as read
   */
  private markVisibleMessagesAsRead(): void {
    const messages = chatStateService.getMessages(this.gameId);
    const unreadIds = messages
      .filter((msg) => !msg.isRead && msg.senderId !== this.userId && msg.id > 0)
      .map((msg) => msg.id);

    if (unreadIds.length > 0) {
      chatStateService.markMessagesAsRead(unreadIds).catch((error) => {
        console.error('[ChatScene] Failed to mark messages as read:', error);
      });
    }
  }

  /**
   * Show error message
   */
  private showError(message: string): void {
    // Create error toast at top of chat
    const width = this.isMobile ? this.scale.width : this.SIDEBAR_WIDTH_DESKTOP;
    const errorBg = this.add.rectangle(0, this.HEADER_HEIGHT, width, 40, 0xff0000, 0.9)
      .setOrigin(0, 0);

    const errorText = this.add.text(width / 2, this.HEADER_HEIGHT + 20, message, {
      fontSize: '12px',
      fontFamily: UI_FONT_FAMILY,
      color: '#ffffff',
    }).setOrigin(0.5, 0.5);

    this.container.add([errorBg, errorText]);

    // Remove after 3 seconds
    this.time.delayedCall(3000, () => {
      errorBg.destroy();
      errorText.destroy();
    });
  }

  /**
   * Handle window resize
   */
  private handleResize(width: number, height: number): void {
    this.isMobile = width < 768;

    // Rebuild UI for new dimensions
    if (this.isOpen) {
      this.close();
      this.time.delayedCall(this.ANIMATION_DURATION, () => {
        this.scene.restart({ gameId: this.gameId, userId: this.userId });
        this.open();
      });
    }
  }

  /**
   * Open the chat sidebar
   */
  public async open(): Promise<void> {
    if (this.isOpen) return;

    this.isOpen = true;
    const targetX = this.isMobile ? 0 : this.scale.width - this.SIDEBAR_WIDTH_DESKTOP;

    // Slide in from right
    this.tweens.add({
      targets: this.container,
      x: targetX,
      duration: this.ANIMATION_DURATION,
      ease: 'Power2',
    });

    // Mark messages as read after opening
    this.time.delayedCall(this.ANIMATION_DURATION, () => {
      this.markVisibleMessagesAsRead();
    });
  }

  /**
   * Close the chat sidebar
   */
  public close(): void {
    if (!this.isOpen) return;

    this.isOpen = false;

    // Slide out to right
    this.tweens.add({
      targets: this.container,
      x: this.scale.width,
      duration: this.ANIMATION_DURATION,
      ease: 'Power2',
    });
  }

  /**
   * Toggle chat open/closed
   */
  public toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Clean up when scene is destroyed
   */
  shutdown(): void {
    // Clean up HTML input
    if (this.inputField) {
      this.inputField.remove();
      this.inputField = undefined;
    }

    // Unsubscribe from chat events
    chatStateService.cleanup(this.gameId);

    // Remove resize listener
    this.scale.off('resize');
  }
}
