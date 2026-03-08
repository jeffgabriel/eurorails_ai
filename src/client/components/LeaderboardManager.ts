import "phaser";
import { GameState } from "../../shared/types/GameTypes";

import { GameStateService } from "../services/GameStateService";
import { UI_FONT_FAMILY } from "../config/uiFont";

export class LeaderboardManager {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private gameState: GameState;
  private nextPlayerCallback: () => void;
  private gameStateService: GameStateService | null = null;
  private lastPlayerSectionHeight: number = 0;
  private tooltip: Phaser.GameObjects.Text | null = null;
  private tooltipBg: Phaser.GameObjects.Rectangle | null = null;

  constructor(
    scene: Phaser.Scene, 
    gameState: GameState,
    nextPlayerCallback: () => void,
    gameStateService?: GameStateService
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.nextPlayerCallback = nextPlayerCallback;
    this.gameStateService = gameStateService || null;
    this.container = this.scene.add.container(0, 0);
  }
  
  public update(targetContainer: Phaser.GameObjects.Container): void {
    // Clear existing UI elements and tooltip
    this.hideTooltip();
    targetContainer.removeAll(true);

    if (!this.gameState || !this.gameState.players || this.gameState.players.length === 0) {
      return;
    }

    const LEADERBOARD_WIDTH = 150;
    const LEADERBOARD_PADDING = 10;
    const PLAYER_ROW_HEIGHT = 20;
    const CARGO_ROW_HEIGHT = 16;

    // Calculate dynamic height: each player with loads gets an extra cargo sub-row
    const cargoRowCount = this.gameState.players.filter(
      p => p.trainState?.loads && p.trainState.loads.length > 0
    ).length;
    const playerSectionHeight = this.gameState.players.length * PLAYER_ROW_HEIGHT
      + cargoRowCount * CARGO_ROW_HEIGHT;
    const leaderboardHeight = 40 + playerSectionHeight + 50;

    const leaderboardBg = this.scene.add
      .rectangle(
        this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
        LEADERBOARD_PADDING,
        LEADERBOARD_WIDTH,
        leaderboardHeight,
        0x333333,
        0.9
      )
      .setOrigin(0, 0);

    // Add leaderboard title
    const leaderboardTitle = this.scene.add
      .text(
        this.scene.scale.width -
          LEADERBOARD_WIDTH -
          LEADERBOARD_PADDING +
          LEADERBOARD_WIDTH / 2,
        LEADERBOARD_PADDING + 5,
        "Players",
        {
          color: "#ffffff",
          fontSize: "16px",
          fontStyle: "bold",
          fontFamily: UI_FONT_FAMILY,
        }
      )
      .setOrigin(0.5, 0);

    // Add all player entries with dynamic Y offsets for cargo sub-rows
    let currentY = LEADERBOARD_PADDING + 30;
    const playerEntries: Phaser.GameObjects.GameObject[] = [];

    this.gameState.players.forEach((player, index) => {
      const isCurrentPlayer = index === this.gameState.currentPlayerIndex;
      const entryY = currentY;
      const entryX = this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING;

      // Create subtle background highlight for current player
      if (isCurrentPlayer) {
        const entryBg = this.scene.add
          .rectangle(
            entryX + 2,
            entryY + 1,
            LEADERBOARD_WIDTH - 4,
            18,
            0x888888,
            0.3
          )
          .setOrigin(0, 0);
        playerEntries.push(entryBg);

        entryBg.setAlpha(0);
        this.scene.tweens.add({
          targets: entryBg,
          alpha: { from: 0, to: 1 },
          duration: 300,
          ease: 'Power2'
        });
      }

      // Create icon for current player
      if (isCurrentPlayer) {
        const iconText = this.scene.add
          .text(
            entryX + 5,
            entryY + 2,
            "►",
            {
              color: "#ffffff",
              fontSize: "16px",
              fontStyle: "bold",
              fontFamily: UI_FONT_FAMILY,
            }
          )
          .setOrigin(0, 0);
        playerEntries.push(iconText);
      }

      // Color badge (circle) for player color
      const badgeX = entryX + (isCurrentPlayer ? 25 : 5);
      const colorBadge = this.scene.add
        .circle(badgeX + 5, entryY + 10, 5, Phaser.Display.Color.HexStringToColor(player.color).color)
        .setOrigin(0.5, 0.5);
      playerEntries.push(colorBadge);

      // Create player text
      const playerText = this.scene.add
        .text(
          badgeX + 14,
          entryY + 2,
          player.name,
          {
            color: "#ffffff",
            fontSize: "14px",
            fontStyle: isCurrentPlayer ? "bold" : "normal",
            fontFamily: UI_FONT_FAMILY,
          }
        )
        .setOrigin(0, 0);
      playerEntries.push(playerText);

      // Add [BOT] suffix for AI players
      if (player.isBot) {
        const botLabel = this.scene.add
          .text(
            badgeX + 14 + playerText.width + 4,
            entryY + 4,
            "[BOT]",
            {
              color: "#aaaaaa",
              fontSize: "10px",
              fontFamily: UI_FONT_FAMILY,
            }
          )
          .setOrigin(0, 0);
        playerEntries.push(botLabel);
      }

      // Create money text (right-aligned)
      const moneyText = this.scene.add
        .text(
          this.scene.scale.width - LEADERBOARD_PADDING - 5,
          entryY + 2,
          `${player.money}M`,
          {
            color: "#ffffff",
            fontSize: "14px",
            fontStyle: isCurrentPlayer ? "bold" : "normal",
            fontFamily: UI_FONT_FAMILY,
          }
        )
        .setOrigin(1, 0);
      playerEntries.push(moneyText);

      currentY += PLAYER_ROW_HEIGHT;

      // Add cargo sub-row if player is carrying loads
      const loads = player.trainState?.loads;
      if (loads && loads.length > 0) {
        const cargoY = currentY;
        const iconSize = 7;
        const iconSpacing = 18;
        const cargoStartX = entryX + 15;

        loads.forEach((loadType, loadIndex) => {
          const iconX = cargoStartX + loadIndex * iconSpacing;
          const iconCenterY = cargoY + CARGO_ROW_HEIGHT / 2;

          // White circular background
          const bg = this.scene.add.circle(iconX, iconCenterY, iconSize, 0xffffff);
          bg.setOrigin(0.5, 0.5);
          playerEntries.push(bg);

          // Load token icon
          const tokenKey = `loadtoken-${loadType.toLowerCase()}`;
          if (this.scene.textures.exists(tokenKey)) {
            const icon = this.scene.add.image(iconX, iconCenterY, tokenKey);
            icon.setScale(0.1);
            playerEntries.push(icon);
          }

          // Make the circle interactive for tooltip
          bg.setInteractive({ useHandCursor: true });
          bg.on("pointerover", (pointer: Phaser.Input.Pointer) => {
            this.showTooltip(loadType, pointer.x, pointer.y);
          });
          bg.on("pointerout", () => {
            this.hideTooltip();
          });
        });

        currentY += CARGO_ROW_HEIGHT;
      }
    });

    // Store total player section height for button positioning
    this.lastPlayerSectionHeight = playerSectionHeight;

    // Create and add next player button
    const nextPlayerButton = this.createNextPlayerButton();

    // Add all UI elements to container
    targetContainer.add([
      leaderboardBg,
      leaderboardTitle,
      ...playerEntries,
      ...nextPlayerButton.getAll()
    ]);
  }

  private createNextPlayerButton(): Phaser.GameObjects.Container {
    const buttonContainer = this.scene.add.container(0, 0);
    const LEADERBOARD_WIDTH = 150;
    const LEADERBOARD_PADDING = 10;
    
    // Check if local player is active
    const isLocalPlayerActive = this.gameStateService?.isLocalPlayerActive() ?? false;

    // Add next player button
    const nextPlayerButton = this.scene.add
      .rectangle(
        this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
        LEADERBOARD_PADDING + 40 + this.lastPlayerSectionHeight,
        LEADERBOARD_WIDTH,
        40,
        isLocalPlayerActive ? 0x00aa00 : 0x666666,
        isLocalPlayerActive ? 0.9 : 0.5
      )
      .setOrigin(0, 0);

    const nextPlayerText = this.scene.add
      .text(
        this.scene.scale.width - LEADERBOARD_WIDTH / 2 - LEADERBOARD_PADDING,
        LEADERBOARD_PADDING + 60 + this.lastPlayerSectionHeight,
        isLocalPlayerActive ? "Next Player" : "Wait Your Turn",
        {
          color: "#ffffff",
          fontSize: "16px",
          fontStyle: "bold",
          fontFamily: UI_FONT_FAMILY,
        }
      )
      .setOrigin(0.5, 0.5);

    // Make the button interactive only if local player is active
    if (isLocalPlayerActive) {
      nextPlayerButton
        .setInteractive({ useHandCursor: true })
        .on("pointerdown", () => this.nextPlayerCallback())
        .on("pointerover", () => nextPlayerButton.setFillStyle(0x008800))
        .on("pointerout", () => nextPlayerButton.setFillStyle(0x00aa00));
    } else {
      // Disabled state - grayed out, no interaction
      nextPlayerButton.setInteractive({ useHandCursor: false });
    }

    buttonContainer.add([nextPlayerButton, nextPlayerText]);
    return buttonContainer;
  }

  private showTooltip(loadType: string, x: number, y: number): void {
    this.hideTooltip();

    const label = loadType.charAt(0).toUpperCase() + loadType.slice(1).toLowerCase();
    const padding = 4;

    this.tooltip = this.scene.add.text(x, y - 20, label, {
      color: "#ffffff",
      fontSize: "11px",
      fontFamily: UI_FONT_FAMILY,
    }).setOrigin(0.5, 1).setDepth(1000);

    const bounds = this.tooltip.getBounds();
    this.tooltipBg = this.scene.add.rectangle(
      bounds.centerX, bounds.centerY,
      bounds.width + padding * 2, bounds.height + padding * 2,
      0x222222, 0.9
    ).setOrigin(0.5, 0.5).setDepth(999);
  }

  private hideTooltip(): void {
    this.tooltip?.destroy();
    this.tooltip = null;
    this.tooltipBg?.destroy();
    this.tooltipBg = null;
  }
}