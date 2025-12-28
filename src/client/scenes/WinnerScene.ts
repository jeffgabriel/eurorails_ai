import 'phaser';
import { GameState, Player } from '../../shared/types/GameTypes';
import { UI_FONT_FAMILY } from '../config/uiFont';

interface WinnerSceneData {
  gameState: GameState;
  winnerId: string;
  winnerName: string;
}

export class WinnerScene extends Phaser.Scene {
  private gameState!: GameState;
  private winnerId!: string;
  private winnerName!: string;

  constructor() {
    super({ key: 'WinnerScene' });
  }

  init(data: WinnerSceneData) {
    this.gameState = data.gameState;
    this.winnerId = data.winnerId;
    this.winnerName = data.winnerName;
  }

  create() {
    // Clear existing scene
    this.children.removeAll();

    // Full-screen semi-transparent overlay
    const overlay = this.add.rectangle(
      0, 0,
      this.scale.width,
      this.scale.height,
      0x000000,
      0.85
    ).setOrigin(0);

    // Main panel
    const panelWidth = Math.min(600, this.scale.width - 40);
    const panelHeight = Math.min(500, this.scale.height - 40);
    const centerX = this.scale.width / 2;
    const centerY = this.scale.height / 2;

    // Panel background
    const panel = this.add.rectangle(
      centerX,
      centerY,
      panelWidth,
      panelHeight,
      0x222222,
      0.98
    ).setOrigin(0.5);

    // Add border
    const border = this.add.rectangle(
      centerX,
      centerY,
      panelWidth + 4,
      panelHeight + 4,
      0xffd700,
      1
    ).setOrigin(0.5);
    border.setDepth(-1);

    // Title - "GAME OVER"
    const titleY = centerY - panelHeight / 2 + 50;
    this.add.text(centerX, titleY, 'GAME OVER', {
      color: '#ffd700',
      fontSize: '42px',
      fontStyle: 'bold',
      fontFamily: UI_FONT_FAMILY,
    }).setOrigin(0.5);

    // Winner announcement
    const winnerY = titleY + 70;
    this.add.text(centerX, winnerY, `${this.winnerName} Wins!`, {
      color: '#ffffff',
      fontSize: '32px',
      fontStyle: 'bold',
      fontFamily: UI_FONT_FAMILY,
    }).setOrigin(0.5);

    // Get winner's final money
    const winner = this.gameState.players.find(p => p.id === this.winnerId);
    if (winner) {
      this.add.text(centerX, winnerY + 40, `Final: ECU ${winner.money}M`, {
        color: '#aaffaa',
        fontSize: '24px',
        fontFamily: UI_FONT_FAMILY,
      }).setOrigin(0.5);
    }

    // Final standings
    const standingsY = winnerY + 100;
    this.add.text(centerX, standingsY, 'Final Standings', {
      color: '#cccccc',
      fontSize: '20px',
      fontStyle: 'bold',
      fontFamily: UI_FONT_FAMILY,
    }).setOrigin(0.5);

    // Sort players by money (descending)
    const sortedPlayers = [...this.gameState.players].sort((a, b) => b.money - a.money);

    // Display each player's standing
    const standingStartY = standingsY + 35;
    const lineHeight = 30;

    sortedPlayers.forEach((player, index) => {
      const y = standingStartY + (index * lineHeight);
      const rank = index + 1;
      const isWinner = player.id === this.winnerId;

      // Rank and name
      const rankText = rank === 1 ? '1st' : rank === 2 ? '2nd' : rank === 3 ? '3rd' : `${rank}th`;
      const displayText = `${rankText}  ${player.name}`;

      // Color indicator
      const colorHex = parseInt(player.color.replace('#', '0x'));
      this.add.rectangle(
        centerX - 140,
        y,
        20,
        20,
        colorHex
      ).setOrigin(0.5);

      // Player info
      this.add.text(centerX - 110, y, displayText, {
        color: isWinner ? '#ffd700' : '#ffffff',
        fontSize: '18px',
        fontStyle: isWinner ? 'bold' : 'normal',
        fontFamily: UI_FONT_FAMILY,
      }).setOrigin(0, 0.5);

      // Money
      this.add.text(centerX + 120, y, `ECU ${player.money}M`, {
        color: isWinner ? '#aaffaa' : '#aaaaaa',
        fontSize: '18px',
        fontFamily: UI_FONT_FAMILY,
      }).setOrigin(1, 0.5);
    });

    // Leave Game button
    const buttonY = centerY + panelHeight / 2 - 60;
    const buttonWidth = 200;
    const buttonHeight = 50;

    const leaveButton = this.add.rectangle(
      centerX,
      buttonY,
      buttonWidth,
      buttonHeight,
      0x2563eb
    ).setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    this.add.text(centerX, buttonY, 'Leave Game', {
      color: '#ffffff',
      fontSize: '22px',
      fontStyle: 'bold',
      fontFamily: UI_FONT_FAMILY,
    }).setOrigin(0.5);

    // Button hover effects
    leaveButton.on('pointerover', () => {
      leaveButton.setFillStyle(0x3b82f6);
    });

    leaveButton.on('pointerout', () => {
      leaveButton.setFillStyle(0x2563eb);
    });

    leaveButton.on('pointerdown', () => {
      this.leaveGame();
    });

    // Add confetti effect for winner celebration
    this.addConfettiEffect();
  }

  private addConfettiEffect(): void {
    // Simple confetti particles falling from top
    const colors = [0xffd700, 0xff6b6b, 0x4ecdc4, 0x45b7d1, 0x96ceb4, 0xffeaa7];
    const confettiCount = 50;

    for (let i = 0; i < confettiCount; i++) {
      const x = Phaser.Math.Between(0, this.scale.width);
      const y = Phaser.Math.Between(-100, -20);
      const color = Phaser.Utils.Array.GetRandom(colors);
      const size = Phaser.Math.Between(4, 10);

      const confetti = this.add.rectangle(x, y, size, size * 2, color);
      confetti.setRotation(Phaser.Math.FloatBetween(0, Math.PI * 2));

      // Animate falling
      this.tweens.add({
        targets: confetti,
        y: this.scale.height + 50,
        x: x + Phaser.Math.Between(-100, 100),
        rotation: confetti.rotation + Phaser.Math.FloatBetween(2, 6),
        duration: Phaser.Math.Between(2000, 4000),
        delay: Phaser.Math.Between(0, 2000),
        ease: 'Linear',
        onComplete: () => {
          confetti.destroy();
        }
      });
    }
  }

  private leaveGame(): void {
    // Stop all game-related scenes
    this.scene.stop('GameScene');
    this.scene.stop('PlayerHandScene');
    this.scene.stop('WinnerScene');

    // Clear persisted game state
    localStorage.removeItem('eurorails.currentGame');
    localStorage.removeItem('eurorails.currentPlayers');
    localStorage.removeItem('eurorails.gameTimestamp');

    // Navigate to lobby
    window.location.href = '/lobby';
  }
}
