import "phaser";
import { GameState, Player } from "../../shared/types/GameTypes";

import { GameStateService } from "../services/GameStateService";
import { UI_FONT_FAMILY } from "../config/uiFont";

// Archetype abbreviations for Phaser display (mirrors archetypeColors.ts)
const ARCHETYPE_ABBREVIATIONS: Record<string, string> = {
  backbone_builder: 'BB',
  freight_optimizer: 'FO',
  trunk_sprinter: 'TS',
  continental_connector: 'CC',
  opportunist: 'OP',
};

// Hex colors per archetype for Phaser rendering
const ARCHETYPE_HEX_COLORS: Record<string, number> = {
  backbone_builder: 0x3b82f6,   // blue-500
  freight_optimizer: 0xf59e0b,  // amber-500
  trunk_sprinter: 0x10b981,     // emerald-500
  continental_connector: 0xa855f7, // purple-500
  opportunist: 0xf43f5e,        // rose-500
};

export class LeaderboardManager {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private gameState: GameState;
  private nextPlayerCallback: () => void;
  private gameStateService: GameStateService | null = null;
  private onBrainClickCallback: ((playerId: string) => void) | null = null;
  private pulsingBotIds: Set<string> = new Set();
  private brainIcons: Map<string, Phaser.GameObjects.Text> = new Map();

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

  /** Register a callback for when the brain icon is clicked */
  public setOnBrainClick(callback: (playerId: string) => void): void {
    this.onBrainClickCallback = callback;
  }

  /** Trigger pulsing animation on a bot's brain icon for 3 seconds */
  public triggerBotPulse(botPlayerId: string): void {
    this.pulsingBotIds.add(botPlayerId);
    const brainIcon = this.brainIcons.get(botPlayerId);
    if (brainIcon) {
      this.startPulseAnimation(brainIcon);
    }
    this.scene.time.delayedCall(3000, () => {
      this.pulsingBotIds.delete(botPlayerId);
      const icon = this.brainIcons.get(botPlayerId);
      if (icon) {
        this.scene.tweens.killTweensOf(icon);
        icon.setAlpha(1);
      }
    });
  }

  private startPulseAnimation(target: Phaser.GameObjects.Text): void {
    this.scene.tweens.add({
      targets: target,
      alpha: { from: 1, to: 0.3 },
      duration: 600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  public update(targetContainer: Phaser.GameObjects.Container): void {
    // Clear existing UI elements
    targetContainer.removeAll(true);
    this.brainIcons.clear();

    if (!this.gameState || !this.gameState.players || this.gameState.players.length === 0) {
      return;
    }

    const hasBots = this.gameState.players.some((p) => p.isBot);
    const LEADERBOARD_WIDTH = hasBots ? 200 : 150;
    const LEADERBOARD_PADDING = 10;
    const ROW_HEIGHT = 20;

    // Create semi-transparent background for leaderboard
    const leaderboardHeight = 40 + this.gameState.players.length * ROW_HEIGHT + 50;
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

    // Add all player entries
    const playerEntries = this.gameState.players
      .map((player, index) => {
        return this.createPlayerEntry(player, index, LEADERBOARD_WIDTH, LEADERBOARD_PADDING, ROW_HEIGHT);
      })
      .flat();

    // Create and add next player button
    const nextPlayerButton = this.createNextPlayerButton(LEADERBOARD_WIDTH, LEADERBOARD_PADDING);

    // Add all UI elements to container
    targetContainer.add([
      leaderboardBg,
      leaderboardTitle,
      ...playerEntries,
      ...nextPlayerButton.getAll()
    ]);
  }

  private createPlayerEntry(
    player: Player,
    index: number,
    leaderboardWidth: number,
    leaderboardPadding: number,
    rowHeight: number,
  ): Phaser.GameObjects.GameObject[] {
    const isCurrentPlayer = index === this.gameState.currentPlayerIndex;
    const entryY = leaderboardPadding + 30 + index * rowHeight;
    const entryX = this.scene.scale.width - leaderboardWidth - leaderboardPadding;
    const elements: Phaser.GameObjects.GameObject[] = [];

    // Create subtle background highlight for current player
    if (isCurrentPlayer) {
      const entryBg = this.scene.add
        .rectangle(
          entryX + 2,
          entryY + 1,
          leaderboardWidth - 4,
          18,
          0x888888,
          0.3
        )
        .setOrigin(0, 0);
      elements.push(entryBg);

      entryBg.setAlpha(0);
      this.scene.tweens.add({
        targets: entryBg,
        alpha: { from: 0, to: 1 },
        duration: 300,
        ease: 'Power2'
      });
    }

    // Current player arrow or bot icon
    let nameStartX = entryX + 5;
    if (isCurrentPlayer) {
      const iconText = this.scene.add
        .text(entryX + 5, entryY + 2, "►", {
          color: "#ffffff",
          fontSize: "16px",
          fontStyle: "bold",
          fontFamily: UI_FONT_FAMILY,
        })
        .setOrigin(0, 0);
      elements.push(iconText);
      nameStartX = entryX + 25;
    }

    // Bot indicator: 🤖 icon before name
    if (player.isBot) {
      const botIcon = this.scene.add
        .text(nameStartX, entryY + 2, "\u{1F916}", {
          fontSize: "12px",
          fontFamily: UI_FONT_FAMILY,
        })
        .setOrigin(0, 0);
      elements.push(botIcon);
      nameStartX += 16;
    }

    // Player name
    const playerText = this.scene.add
      .text(nameStartX, entryY + 2, player.name, {
        color: "#ffffff",
        fontSize: "14px",
        fontStyle: isCurrentPlayer ? "bold" : "normal",
        fontFamily: UI_FONT_FAMILY,
      })
      .setOrigin(0, 0);
    elements.push(playerText);

    // Archetype badge for bots (colored abbreviation)
    if (player.isBot && player.botConfig) {
      const abbr = ARCHETYPE_ABBREVIATIONS[player.botConfig.archetype] || '??';
      const badgeColor = ARCHETYPE_HEX_COLORS[player.botConfig.archetype] || 0x888888;

      const badgeX = nameStartX + playerText.width + 4;
      const badgeBg = this.scene.add
        .rectangle(badgeX, entryY + 3, 20, 14, badgeColor, 0.8)
        .setOrigin(0, 0);
      elements.push(badgeBg);

      const badgeText = this.scene.add
        .text(badgeX + 10, entryY + 10, abbr, {
          color: "#ffffff",
          fontSize: "9px",
          fontStyle: "bold",
          fontFamily: UI_FONT_FAMILY,
        })
        .setOrigin(0.5, 0.5);
      elements.push(badgeText);
    }

    // Money text (right-aligned, leave room for brain icon)
    const moneyRightEdge = player.isBot
      ? this.scene.scale.width - leaderboardPadding - 22
      : this.scene.scale.width - leaderboardPadding - 5;
    const moneyText = this.scene.add
      .text(moneyRightEdge, entryY + 2, `${player.money}M`, {
        color: "#ffffff",
        fontSize: "14px",
        fontStyle: isCurrentPlayer ? "bold" : "normal",
        fontFamily: UI_FONT_FAMILY,
      })
      .setOrigin(1, 0);
    elements.push(moneyText);

    // Brain icon for bots (clickable)
    if (player.isBot) {
      const brainX = this.scene.scale.width - leaderboardPadding - 5;
      const brainIcon = this.scene.add
        .text(brainX, entryY + 2, "\u{1F9E0}", {
          fontSize: "12px",
          fontFamily: UI_FONT_FAMILY,
        })
        .setOrigin(1, 0)
        .setInteractive({ useHandCursor: true });

      brainIcon.on("pointerdown", () => {
        if (this.onBrainClickCallback) {
          this.onBrainClickCallback(player.id);
        }
        this.scene.events.emit('bot:inspect', player.id);
      });

      brainIcon.on("pointerover", () => {
        brainIcon.setScale(1.2);
      });
      brainIcon.on("pointerout", () => {
        brainIcon.setScale(1.0);
      });

      elements.push(brainIcon);
      this.brainIcons.set(player.id, brainIcon);

      // Re-apply pulse if this bot is in the pulsing set
      if (this.pulsingBotIds.has(player.id)) {
        this.startPulseAnimation(brainIcon);
      }
    }

    return elements;
  }

  private createNextPlayerButton(leaderboardWidth?: number, leaderboardPadding?: number): Phaser.GameObjects.Container {
    const buttonContainer = this.scene.add.container(0, 0);
    const LEADERBOARD_WIDTH = leaderboardWidth || 150;
    const LEADERBOARD_PADDING = leaderboardPadding || 10;

    // Check if local player is active
    const isLocalPlayerActive = this.gameStateService?.isLocalPlayerActive() ?? false;

    // Add next player button
    const nextPlayerButton = this.scene.add
      .rectangle(
        this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
        LEADERBOARD_PADDING + 40 + this.gameState.players.length * 20,
        LEADERBOARD_WIDTH,
        40,
        isLocalPlayerActive ? 0x00aa00 : 0x666666,
        isLocalPlayerActive ? 0.9 : 0.5
      )
      .setOrigin(0, 0);

    const nextPlayerText = this.scene.add
      .text(
        this.scene.scale.width - LEADERBOARD_WIDTH / 2 - LEADERBOARD_PADDING,
        LEADERBOARD_PADDING + 60 + this.gameState.players.length * 20,
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
}
