import 'phaser';
import { chatStateService, ChatMessage } from '../services/ChatStateService';
import { ChatMessageBubble } from '../components/ChatMessageBubble';
import { UI_FONT_FAMILY } from '../config/uiFont';
import DOMPurify from 'dompurify';
import { diag } from '../utils/deviceDiagnostics';

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
  private isReady: boolean = false; // Flag to track when create() has completed; kept for backward compatibility
  // Initialized eagerly (not just in init()) so whenReady() is always safe to
  // call, even before this scene's Phaser lifecycle has started.
  private _resolveWhenReady!: () => void;
  private _whenReadyPromise: Promise<void> = new Promise<void>((resolve) => {
    this._resolveWhenReady = resolve;
  });

  /** DM mode: when set, we show DM with this player instead of game chat */
  private dmRecipientId: string | null = null;
  private dmRecipientName: string | null = null;
  // Canvas size the UI was built for. The layout (incl. the DOM input) is positioned
  // once in create(), so opening after a resize rebuilds the scene first.
  private layoutWidth: number = 0;
  private layoutHeight: number = 0;
  // Set via restart data: what to open once the rebuilt create() finishes.
  private openOnReady: { dm?: { userId: string; name: string } } | null = null;
  private messageUnsubscribe: (() => void) | null = null;
  private flaggedUnsubscribe: (() => void) | null = null;
  private unreadUnsubscribe: (() => void) | null = null;
  private errorUnsubscribe: (() => void) | null = null;
  private optimisticBubbleMap: Map<string, ChatMessageBubble> = new Map();

  // UI components
  private container!: Phaser.GameObjects.Container;
  private headerTitle!: Phaser.GameObjects.Text;
  private headerBackBtn!: Phaser.GameObjects.Text;
  private background!: Phaser.GameObjects.Rectangle;
  private messagesContainer!: Phaser.GameObjects.Container;
  private messagesList: ChatMessageBubble[] = [];
  private inputField?: HTMLInputElement;
  private scrollPosition: number = 0;
  private maxScroll: number = 0;
  private tooltipContainer: Phaser.GameObjects.Container | null = null;
  private tooltipBg: Phaser.GameObjects.Graphics | null = null;
  private tooltipText: Phaser.GameObjects.Text | null = null;

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

  init(data: { gameId: string; userId: string; openOnReady?: { dm?: { userId: string; name: string } } }) {
    this.gameId = data.gameId;
    this.userId = data.userId;
    this.isMobile = this.scale.width < 768;
    this.openOnReady = data.openOnReady ?? null;

    // Re-create the promise only after a completed lifecycle, so whenReady()
    // reflects THIS lifecycle's create() rather than a stale promise resolved
    // by a previous one. When the pending promise was never resolved (first
    // launch — where whenReady() is callable before init — or a restart that
    // interrupted create()), keep it: replacing it would orphan existing
    // waiters, which would then never resolve.
    if (this.isReady) {
      this.isReady = false;
      this._whenReadyPromise = new Promise<void>((resolve) => {
        this._resolveWhenReady = resolve;
      });
    }
  }

  /**
   * Resolves once this create() has finished. Replaces the recursive
   * setTimeout poll GameScene used to do on the `isReady` flag — callers can
   * simply `await chatScene.whenReady()` instead of hand-rolling a retry loop.
   */
  whenReady(): Promise<void> {
    return this._whenReadyPromise;
  }

  async create() {
    // Initialize chat state service if not already done
    if (!chatStateService['initialized']) {
      await chatStateService.initialize(this.userId);
    }

    // Create main container (initially offscreen)
    this.container = this.add.container(this.scale.width, 0);

    // Build UI - order matters: messages first, then header/input on top to cover overflow
    this.createBackground();
    this.createMessagesArea();
    this.createHeader();
    this.createInputArea();

    // Set up event listeners
    this.setupChatListeners();
    this.setupResizeListener();
    this.setupInputHandlers();

    // Join the game chat
    try {
      await this.joinChat();
    } catch (error) {
      console.error('[ChatScene] Failed to join chat:', error);
    }

    // Start closed
    this.isOpen = false;

    this.layoutWidth = this.scale.width;
    this.layoutHeight = this.scale.height;

    // Mark scene as ready
    this.isReady = true;
    this._resolveWhenReady();

    // Reopen after a layout rebuild (resize while open, or open after a resize).
    // Done here, after `isOpen = false` above, so it can't be overwritten.
    const reopen = this.openOnReady;
    this.openOnReady = null;
    if (reopen?.dm) {
      void this.openDM(reopen.dm.userId, reopen.dm.name);
    } else if (reopen) {
      void this.open();
    }
    diag.log('chat', 'created', {
      isMobile: this.isMobile,
      scale: { w: this.scale.width, h: this.scale.height },
      containerX: this.container.x,
      chatInputsInDom: document.querySelectorAll('input[data-chat-input]').length,
    });
  }

  /** Diagnostics only (H1/C1): chat geometry and input state. */
  private diagState(): Record<string, unknown> {
    return {
      isOpen: this.isOpen,
      isMobile: this.isMobile,
      scale: { w: this.scale.width, h: this.scale.height },
      containerX: this.container?.x,
      backgroundW: this.background?.width,
      backgroundInteractive: !!this.background?.input?.enabled,
      inputDisplay: this.inputField?.style.display,
      inputFocused: !!this.inputField && document.activeElement === this.inputField,
      chatInputsInDom: document.querySelectorAll('input[data-chat-input]').length,
    };
  }

  /**
   * Create semi-transparent background
   * Set interactive to block pointer events from leaking through to game layers
   */
  private createBackground(): void {
    const width = this.isMobile ? this.scale.width : this.SIDEBAR_WIDTH_DESKTOP;
    const height = this.scale.height;

    this.background = this.add.rectangle(0, 0, width, height, 0x2c2c2c, 0.95)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: false });

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

    // Back button (visible only in DM mode)
    this.headerBackBtn = this.add.text(15, this.HEADER_HEIGHT / 2, '← Game Chat', {
      fontSize: '14px',
      fontFamily: UI_FONT_FAMILY,
      color: '#aaaaaa',
    })
      .setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.switchToGameChat())
      .setVisible(false);
    this.container.add(this.headerBackBtn);

    // Title (stored for dynamic updates when switching to/from DM)
    this.headerTitle = this.add.text(15, this.HEADER_HEIGHT / 2, 'Game Chat', {
      fontSize: '20px',
      fontFamily: UI_FONT_FAMILY,
      color: '#ffffff',
      fontStyle: 'bold',
    }).setOrigin(0, 0.5);
    this.container.add(this.headerTitle);

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
    // No mask needed - header and input are rendered on top to cover overflow
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
      } else {
        this.handleFlaggedBubbleHover(pointer);
      }
    });

    scrollZone.on('pointerout', () => {
      this.hideFlaggedTooltip();
    });

    this.container.add(scrollZone);
  }

  /**
   * Create input area with text field and send button
   */
  private createInputArea(): void {
    // The scene instance is reused across restarts; drop the previous DOM input.
    this.inputField?.remove();
    this.inputField = undefined;
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
    this.inputField.setAttribute('data-chat-input', '');
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
      display: none;
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
      .on('pointerdown', () => {
        diag.log('chat', 'sendPointerdown', this.diagState());
        this.sendMessage();
      });

    this.container.add(sendBtn);
  }

  /**
   * Set up chat state service listeners
   */
  private setupChatListeners(): void {
    // Message listener is subscribed dynamically when joining game chat or opening DM
    this.subscribeToGameChat();

    // create() runs again on every restart: replace listeners rather than stacking them.
    this.unreadUnsubscribe?.();
    this.errorUnsubscribe?.();
    this.flaggedUnsubscribe?.();

    // Listen for unread count changes (handle both game chat and DM keys)
    this.unreadUnsubscribe = chatStateService.onUnreadCount((notifyKey: string, count: number) => {
      // Check if this is for the current view (game chat or active DM)
      const isCurrentGameChat = notifyKey === this.gameId && !this.dmRecipientId;
      const isCurrentDM = this.dmRecipientId && notifyKey === `dm:${this.gameId}:${this.dmRecipientId}`;
      
      if ((isCurrentGameChat || isCurrentDM) && this.isOpen) {
        this.markVisibleMessagesAsRead();
      }
    });

    // Listen for errors
    this.errorUnsubscribe = chatStateService.onError((error) => {
      this.showError(error.message);
    });

    // Listen for flagged messages (moderation)
    this.flaggedUnsubscribe = chatStateService.onMessageFlagged((optimisticId: string, errorMessage: string) => {
      const bubble = this.optimisticBubbleMap.get(optimisticId);
      if (bubble) {
        bubble.markAsFlagged(errorMessage);
      }
    });
  }

  /**
   * Subscribe to game chat messages
   */
  private subscribeToGameChat(): void {
    this.messageUnsubscribe?.();
    this.messageUnsubscribe = chatStateService.onMessage(this.gameId, (message: ChatMessage) => {
      this.addMessageBubble(message);
      this.scrollToBottom();
    });
  }

  /**
   * Subscribe to DM messages for a recipient (key format must match ChatStateService)
   */
  private subscribeToDM(recipientId: string): void {
    const dmKey = `dm:${this.gameId}:${recipientId}`;
    this.messageUnsubscribe?.();
    this.messageUnsubscribe = chatStateService.onMessage(dmKey, (message: ChatMessage) => {
      this.addMessageBubble(message);
      this.scrollToBottom();
    });
  }

  /**
   * Set up window resize listener
   */
  private setupResizeListener(): void {
    // create() runs again on every restart; replace rather than stack the listener.
    this.scale.off('resize', this.onScaleResize, this);
    this.scale.on('resize', this.onScaleResize, this);
  }

  private onScaleResize(gameSize: Phaser.Structs.Size): void {
    this.handleResize(gameSize.width, gameSize.height);
  }

  /** True when the canvas size differs from the one the UI was built for. */
  private isLayoutStale(): boolean {
    return this.scale.width !== this.layoutWidth || this.scale.height !== this.layoutHeight;
  }

  /** Rebuild the UI for the current canvas size, then open (optionally in a DM). */
  private rebuildAndOpen(dm?: { userId: string; name: string }): void {
    diag.log('chat', 'rebuildAndOpen', { ...this.diagState(), dm: !!dm });
    this.scene.restart({ gameId: this.gameId, userId: this.userId, openOnReady: dm ? { dm } : {} });
  }

  /**
   * Set up input keyboard handlers
   */
  private setupInputHandlers(): void {
    if (!this.inputField) return;

    // Send on Enter key
    this.inputField.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        diag.log('chat', 'enterKey');
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
   * Send a message (game chat or DM based on current mode)
   */
  private async sendMessage(): Promise<void> {
    if (!this.inputField || !this.inputField.value.trim()) {
      return;
    }

    const message = this.inputField.value.trim();
    this.inputField.value = '';

    try {
      let optimisticId: string;
      if (this.dmRecipientId) {
        optimisticId = await chatStateService.sendMessage(this.gameId, message, 'player', this.dmRecipientId);
      } else {
        optimisticId = await chatStateService.sendMessage(this.gameId, message);
      }

      // Map the optimisticId to the last bubble (just created by the listener)
      const lastBubble = this.messagesList[this.messagesList.length - 1];
      if (lastBubble) {
        this.optimisticBubbleMap.set(optimisticId, lastBubble);
      }
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

    // Calculate Y position based on actual heights of previous bubbles
    let yPosition = this.MESSAGE_PADDING;
    for (const existingBubble of this.messagesList) {
      yPosition += existingBubble.height + this.MESSAGE_PADDING;
    }

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
    // Calculate total content height from actual bubble heights
    let contentHeight = this.MESSAGE_PADDING; // Top padding
    for (const bubble of this.messagesList) {
      contentHeight += bubble.height + this.MESSAGE_PADDING;
    }
    
    const visibleHeight = this.scale.height - this.HEADER_HEIGHT - this.INPUT_HEIGHT;
    this.maxScroll = Math.max(0, contentHeight - visibleHeight);
  }

  /**
   * Mark visible messages as read
   */
  private markVisibleMessagesAsRead(): void {
    const messages = this.dmRecipientId
      ? chatStateService.getDMMessages(this.gameId, this.dmRecipientId)
      : chatStateService.getMessages(this.gameId);
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
    diag.log('chat', 'handleResize', { ...this.diagState(), newW: width, newH: height });
    this.isMobile = width < 768;

    if (!this.isReady) return;

    if (this.isOpen) {
      // Rebuild UI for new dimensions, then reopen in the same mode once create() finishes.
      const dm = this.dmRecipientId && this.dmRecipientName
        ? { userId: this.dmRecipientId, name: this.dmRecipientName }
        : undefined;
      this.close();
      this.time.delayedCall(this.ANIMATION_DURATION, () => this.rebuildAndOpen(dm));
      return;
    }

    // Closed: keep the parked panel just off the right edge. It was placed at the
    // creation-time width, so a wider canvas (e.g. closing DevTools) exposed it.
    this.tweens.killTweensOf(this.container);
    this.container.setX(width);
  }

  /**
   * Open chat in DM mode with a specific player
   */
  public async openDM(recipientUserId: string, recipientName: string): Promise<void> {
    diag.log('chat', 'openDM', this.diagState());
    if (this.isReady && !this.isOpen && this.isLayoutStale()) {
      this.rebuildAndOpen({ userId: recipientUserId, name: recipientName });
      return;
    }
    try {
      this.dmRecipientId = recipientUserId;
      this.dmRecipientName = recipientName;
      this.subscribeToDM(recipientUserId);
      this.headerTitle.setText(`DM with ${recipientName}`);
      this.headerBackBtn.setVisible(true);
      this.headerTitle.setX(15 + this.headerBackBtn.width + 10);

      // Clear and reload messages
      this.clearMessageBubbles();
      const messages = await chatStateService.openDM(this.gameId, recipientUserId);
      messages.forEach((msg) => this.addMessageBubble(msg));
      this.scrollToBottom();
      
      await this.open();
    } catch (error) {
      console.error('[ChatScene] Error in openDM:', error);
      this.showError('Failed to load conversation');
    }
  }

  /**
   * Switch back to game chat (call when user wants to leave DM view)
   */
  public switchToGameChat(): void {
    this.dmRecipientId = null;
    this.dmRecipientName = null;
    this.headerBackBtn.setVisible(false);
    this.headerTitle.setX(15);
    this.subscribeToGameChat();
    this.headerTitle.setText('Game Chat');
    this.clearMessageBubbles();
    const messages = chatStateService.getMessages(this.gameId);
    messages.forEach((msg) => this.addMessageBubble(msg));
    this.scrollToBottom();
  }

  /**
   * Clear all message bubbles from the display
   */
  private clearMessageBubbles(): void {
    for (const bubble of this.messagesList) {
      bubble.destroy();
    }
    this.messagesList = [];
    this.optimisticBubbleMap.clear();
    this.updateScrollBounds();
  }

  /**
   * Open the chat sidebar
   */
  public async open(): Promise<void> {
    diag.log('chat', 'open', this.diagState());
    if (this.isOpen) return;
    if (this.isReady && this.isLayoutStale()) {
      // Built for a different canvas size: rebuild first; create() reopens.
      this.rebuildAndOpen();
      return;
    }

    this.isOpen = true;
    const targetX = this.isMobile ? 0 : this.scale.width - this.SIDEBAR_WIDTH_DESKTOP;

    // Bring ChatScene to top so it receives input and blocks game layer
    this.scene.bringToTop('ChatScene');

    // Show input field
    if (this.inputField) {
      this.inputField.style.display = 'block';
    }

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
    diag.log('chat', 'close', this.diagState());
    if (!this.isOpen) return;

    this.isOpen = false;

    // Hide input field
    if (this.inputField) {
      this.inputField.style.display = 'none';
    }

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
    diag.log('chat', 'toggle', this.diagState());
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Check if the pointer is hovering over a flagged bubble and show/hide tooltip
   */
  private handleFlaggedBubbleHover(pointer: Phaser.Input.Pointer): void {
    // Convert pointer world coords to local coords within messagesContainer
    const containerX = this.container.x;
    const localX = pointer.x - containerX;
    const localY = pointer.y - this.messagesContainer.y - this.container.y;

    for (const bubble of this.messagesList) {
      const tooltipText = bubble.getFlaggedTooltipText();
      if (tooltipText && bubble.containsPoint(localX, localY)) {
        this.showFlaggedTooltip(pointer.x, pointer.y, tooltipText);
        return;
      }
    }

    this.hideFlaggedTooltip();
  }

  /**
   * Show the flagged message tooltip at the given screen position
   */
  private showFlaggedTooltip(screenX: number, screenY: number, text: string): void {
    if (!this.tooltipContainer) {
      this.tooltipBg = this.add.graphics();
      this.tooltipText = this.add.text(0, 0, '', {
        fontSize: '11px',
        fontFamily: UI_FONT_FAMILY,
        color: '#ffffff',
        wordWrap: { width: 220 },
      });
      this.tooltipContainer = this.add.container(0, 0, [this.tooltipBg, this.tooltipText]);
      this.tooltipContainer.setDepth(1000);
    }

    const padding = 8;
    this.tooltipText!.setText(text);
    const tooltipWidth = this.tooltipText!.width + padding * 2;
    const tooltipHeight = this.tooltipText!.height + padding * 2;

    this.tooltipBg!.clear();
    this.tooltipBg!.fillStyle(0x222222, 0.95);
    this.tooltipBg!.fillRoundedRect(0, 0, tooltipWidth, tooltipHeight, 4);

    this.tooltipText!.setPosition(padding, padding);

    // Position above the pointer
    this.tooltipContainer.setPosition(
      screenX - tooltipWidth / 2,
      screenY - tooltipHeight - 10
    );
    this.tooltipContainer.setVisible(true);
  }

  /**
   * Hide the flagged message tooltip
   */
  private hideFlaggedTooltip(): void {
    if (this.tooltipContainer) {
      this.tooltipContainer.setVisible(false);
    }
  }

  /**
   * Clean up when scene is destroyed
   */
  shutdown(): void {
    this.messageUnsubscribe?.();
    this.messageUnsubscribe = null;
    this.flaggedUnsubscribe?.();
    this.flaggedUnsubscribe = null;
    this.unreadUnsubscribe?.();
    this.unreadUnsubscribe = null;
    this.errorUnsubscribe?.();
    this.errorUnsubscribe = null;
    this.optimisticBubbleMap.clear();

    // Clean up tooltip
    if (this.tooltipContainer) {
      this.tooltipContainer.destroy();
      this.tooltipContainer = null;
    }
    this.tooltipBg = null;
    this.tooltipText = null;

    // Clean up HTML input
    if (this.inputField) {
      this.inputField.remove();
      this.inputField = undefined;
    }

    // Unsubscribe from chat events
    chatStateService.cleanup(this.gameId);

    // Remove resize listener
    this.scale.off('resize', this.onScaleResize, this);
  }
}
