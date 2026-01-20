// src/client/scenes/BorrowMoneyDialogScene.ts
import { Scene } from 'phaser';
import { Player, GameState } from '../../shared/types/GameTypes';
import { PlayerStateService } from '../services/PlayerStateService';
import { UI_FONT_FAMILY } from '../config/uiFont';

interface BorrowMoneyDialogConfig {
    player: Player;
    gameState: GameState;
    playerStateService: PlayerStateService;
    onClose: () => void;
    onSuccess: () => void;
}

export class BorrowMoneyDialogScene extends Scene {
    private player!: Player;
    private gameState!: GameState;
    private onClose!: () => void;
    private onSuccess!: () => void;
    private playerStateService!: PlayerStateService;
    private dialogContainer!: Phaser.GameObjects.Container;
    private amount: number = 10; // Default amount
    private amountText!: Phaser.GameObjects.Text;
    private previewText!: Phaser.GameObjects.Text;
    private borrowButton!: Phaser.GameObjects.Text;
    private errorText: Phaser.GameObjects.Text | null = null;
    private isSubmitting: boolean = false;

    constructor() {
        super({ key: 'BorrowMoneyDialogScene' });
    }

    init(data: BorrowMoneyDialogConfig) {
        this.player = data.player;
        this.gameState = data.gameState;
        this.playerStateService = data.playerStateService;
        this.onClose = data.onClose;
        this.onSuccess = data.onSuccess;
        
        // Reset state for scene reuse
        this.isSubmitting = false;
        this.amount = 1;
        this.errorText = null;
        
        // CRITICAL: Phaser only calls create() once. On subsequent launches,
        // we must manually rebuild the UI here in init()
        if (this.sys.settings.isBooted) {
            // Scene has been booted before, rebuild UI
            this.rebuildUI();
        }
    }

    create() {
        // First-time creation only
        this.rebuildUI();
    }
    
    private rebuildUI(): void {
        // Destroy any existing UI from previous launches
        this.children.removeAll(true);
        
        // Keep input focused on this scene while open
        this.input.setTopOnly(true);

        // Create dark background overlay
        // Testing with very dark blue instead of pure black (red worked at 1.0, black didn't)
        const overlay = this.add.rectangle(
            0, 0,
            this.scale.width,
            this.scale.height,
            0x0a0a1a,  // Very dark blue-ish (almost black but not 0x000000)
            0.95  // 95% opaque
        ).setOrigin(0);
        overlay.setScrollFactor(0);
        overlay.setDepth(10000);

        // Make overlay interactive to prevent clicking through
        overlay.setInteractive({ useHandCursor: true });
        overlay.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
            if (pointer.event) {
                pointer.event.stopPropagation();
            }
        });

        // Create the dialog container
        this.dialogContainer = this.add.container(
            this.cameras.main.centerX,
            this.cameras.main.centerY
        );
        this.dialogContainer.setDepth(10001);

        // Dialog background
        const dialogBg = this.add.rectangle(0, 0, 500, 400, 0x1e293b);
        dialogBg.setStrokeStyle(2, 0x475569);
        this.dialogContainer.add(dialogBg);

        // Title
        const title = this.add.text(0, -150, 'Borrow Money', {
            fontSize: '28px',
            color: '#ffffff',
            fontFamily: UI_FONT_FAMILY,
            fontStyle: 'bold'
        }).setOrigin(0.5);
        this.dialogContainer.add(title);

        // Subtitle
        const subtitle = this.add.text(0, -110, 'Borrow from the bank (1-20 ECU)', {
            fontSize: '14px',
            color: '#94a3b8',
            fontFamily: UI_FONT_FAMILY
        }).setOrigin(0.5);
        this.dialogContainer.add(subtitle);

        // Amount label
        const amountLabel = this.add.text(0, -50, 'Amount (ECU):', {
            fontSize: '16px',
            color: '#cbd5e1',
            fontFamily: UI_FONT_FAMILY
        }).setOrigin(0.5);
        this.dialogContainer.add(amountLabel);

        // Amount display
        this.amountText = this.add.text(0, -10, `${this.amount}M`, {
            fontSize: '32px',
            color: '#22c55e',
            fontFamily: UI_FONT_FAMILY,
            fontStyle: 'bold'
        }).setOrigin(0.5);
        this.dialogContainer.add(this.amountText);

        // Slider/increment buttons
        const decrementBtn = this.createButton(-100, 35, '-', () => this.changeAmount(-1));
        const incrementBtn = this.createButton(100, 35, '+', () => this.changeAmount(1));
        this.dialogContainer.add([decrementBtn, incrementBtn]);

        // Quick amount buttons
        const y = 80;
        const quickBtn5 = this.createSmallButton(-120, y, '5', () => this.setAmount(5));
        const quickBtn10 = this.createSmallButton(-40, y, '10', () => this.setAmount(10));
        const quickBtn15 = this.createSmallButton(40, y, '15', () => this.setAmount(15));
        const quickBtn20 = this.createSmallButton(120, y, '20', () => this.setAmount(20));
        this.dialogContainer.add([quickBtn5, quickBtn10, quickBtn15, quickBtn20]);

        // Preview text (debt incurred)
        this.previewText = this.add.text(0, 125, this.getPreviewText(), {
            fontSize: '14px',
            color: '#fbbf24',
            fontFamily: UI_FONT_FAMILY,
            align: 'center'
        }).setOrigin(0.5);
        this.dialogContainer.add(this.previewText);

        // Action buttons
        this.borrowButton = this.createActionButton(-70, 170, 'Borrow', 0x22c55e, () => this.handleBorrow());
        const cancelButton = this.createActionButton(70, 170, 'Cancel', 0x64748b, () => this.close());
        this.dialogContainer.add([this.borrowButton, cancelButton]);

        // Close on ESC key (remove any existing listeners first)
        this.input.keyboard?.off('keydown-ESC');
        this.input.keyboard?.on('keydown-ESC', () => {
            if (!this.isSubmitting) {
                this.close();
            }
        });
    }

    private createButton(x: number, y: number, text: string, callback: () => void): Phaser.GameObjects.Container {
        const container = this.add.container(x, y);
        const bg = this.add.rectangle(0, 0, 60, 50, 0x334155);
        bg.setStrokeStyle(2, 0x475569);
        const label = this.add.text(0, 0, text, {
            fontSize: '24px',
            color: '#ffffff',
            fontFamily: UI_FONT_FAMILY,
            fontStyle: 'bold'
        }).setOrigin(0.5);

        bg.setInteractive({ useHandCursor: true });
        bg.on('pointerover', () => bg.setFillStyle(0x475569));
        bg.on('pointerout', () => bg.setFillStyle(0x334155));
        bg.on('pointerdown', callback);

        container.add([bg, label]);
        return container;
    }

    private createSmallButton(x: number, y: number, text: string, callback: () => void): Phaser.GameObjects.Container {
        const container = this.add.container(x, y);
        const bg = this.add.rectangle(0, 0, 60, 35, 0x334155);
        bg.setStrokeStyle(1, 0x475569);
        const label = this.add.text(0, 0, text, {
            fontSize: '14px',
            color: '#ffffff',
            fontFamily: UI_FONT_FAMILY
        }).setOrigin(0.5);

        bg.setInteractive({ useHandCursor: true });
        bg.on('pointerover', () => bg.setFillStyle(0x475569));
        bg.on('pointerout', () => bg.setFillStyle(0x334155));
        bg.on('pointerdown', callback);

        container.add([bg, label]);
        return container;
    }

    private createActionButton(x: number, y: number, text: string, color: number, callback: () => void): Phaser.GameObjects.Container {
        const container = this.add.container(x, y);
        const bg = this.add.rectangle(0, 0, 120, 45, color);
        bg.setStrokeStyle(2, color);
        const label = this.add.text(0, 0, text, {
            fontSize: '16px',
            color: '#ffffff',
            fontFamily: UI_FONT_FAMILY,
            fontStyle: 'bold'
        }).setOrigin(0.5);

        bg.setInteractive({ useHandCursor: true });
        bg.on('pointerover', () => bg.setFillStyle(color + 0x222222));
        bg.on('pointerout', () => bg.setFillStyle(color));
        bg.on('pointerdown', callback);

        container.add([bg, label]);
        return container;
    }

    private changeAmount(delta: number): void {
        if (this.isSubmitting) return;
        this.setAmount(this.amount + delta);
    }

    private setAmount(newAmount: number): void {
        if (this.isSubmitting) return;
        // Clamp between 1 and 20
        this.amount = Math.max(1, Math.min(20, newAmount));
        this.updateDisplay();
    }

    private updateDisplay(): void {
        this.amountText.setText(`${this.amount}M`);
        this.previewText.setText(this.getPreviewText());
        
        // Clear error when amount changes
        if (this.errorText) {
            this.errorText.destroy();
            this.errorText = null;
        }
    }

    private getPreviewText(): string {
        const debt = this.amount * 2;
        return `Borrowing ${this.amount}M will add ${debt}M to your debt`;
    }

    private async handleBorrow(): Promise<void> {
        if (this.isSubmitting) return;
        
        // Clear any existing error
        if (this.errorText) {
            this.errorText.destroy();
            this.errorText = null;
        }

        this.isSubmitting = true;
        this.borrowButton.getAt(1).setColor('#94a3b8'); // Dim text
        this.borrowButton.getAt(1).setText('Borrowing...');

        try {
            const result = await this.playerStateService.borrowMoney(
                this.gameState.id,
                this.amount
            );

            if (result) {
                console.log(`Borrowed ${this.amount}M. New balance: ${result.updatedMoney}M, Debt: ${result.totalDebt}M`);
                
                // Show success message
                this.showMessage(`Borrowed ${this.amount}M! Debt: ${result.totalDebt}M`, 0x22c55e);
                
                // Wait a moment then close and refresh
                this.time.delayedCall(1000, () => {
                    this.onSuccess();
                    this.close();
                });
            } else {
                this.showError('Failed to borrow money. Please try again.');
                this.isSubmitting = false;
                this.borrowButton.getAt(1).setColor('#ffffff');
                this.borrowButton.getAt(1).setText('Borrow');
            }
        } catch (error) {
            console.error('Error borrowing money:', error);
            this.showError('An error occurred. Please try again.');
            this.isSubmitting = false;
            this.borrowButton.getAt(1).setColor('#ffffff');
            this.borrowButton.getAt(1).setText('Borrow');
        }
    }

    private showError(message: string): void {
        if (this.errorText) {
            this.errorText.destroy();
        }

        this.errorText = this.add.text(0, 210, message, {
            fontSize: '12px',
            color: '#ef4444',
            fontFamily: UI_FONT_FAMILY,
            align: 'center',
            wordWrap: { width: 400 }
        }).setOrigin(0.5);
        
        this.errorText.setDepth(10002);
        this.errorText.setPosition(this.cameras.main.centerX, this.cameras.main.centerY + 160);
    }

    private showMessage(message: string, color: number): void {
        if (this.errorText) {
            this.errorText.destroy();
        }

        this.errorText = this.add.text(0, 210, message, {
            fontSize: '14px',
            color: `#${color.toString(16).padStart(6, '0')}`,
            fontFamily: UI_FONT_FAMILY,
            fontStyle: 'bold',
            align: 'center'
        }).setOrigin(0.5);
        
        this.dialogContainer.add(this.errorText);
    }

    private close(): void {
        this.scene.stop();
        this.onClose();
    }

    /**
     * Phaser lifecycle method called when the scene is shutdown.
     * Clean up all game objects to ensure fresh state on next launch.
     */
    shutdown(): void {
        // Destroy all children to force recreation on next launch
        this.children.removeAll(true);
        
        // Reset references
        this.dialogContainer = null as any;
        this.amountText = null as any;
        this.previewText = null as any;
        this.borrowButton = null as any;
        this.errorText = null;
    }
}

