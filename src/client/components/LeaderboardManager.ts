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
    // Clear existing UI elements
    targetContainer.removeAll(true);

    if (!this.gameState || !this.gameState.players || this.gameState.players.length === 0) {
      return;
    }

    const LEADERBOARD_WIDTH = 150;
    const LEADERBOARD_PADDING = 10;

    // Create semi-transparent background for leaderboard
    const leaderboardHeight = 40 + this.gameState.players.length * 20 + 50;
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
        const isCurrentPlayer = index === this.gameState.currentPlayerIndex;
        const entryY = LEADERBOARD_PADDING + 30 + index * 20;
        const entryX = this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING;

        const elements: Phaser.GameObjects.GameObject[] = [];

        // Create subtle background highlight for current player
        if (isCurrentPlayer) {
          // Subtle background highlight - light gray with low opacity
          const entryBg = this.scene.add
            .rectangle(
              entryX + 2, // Small inset to keep within bounds
              entryY + 1, // Small inset to keep within bounds
              LEADERBOARD_WIDTH - 4, // Reduced width to account for insets
              18, // Reduced height to account for insets
              0x888888,
              0.3 // Lower opacity for subtlety
            )
            .setOrigin(0, 0);
          elements.push(entryBg);

          // Add smooth transition animation
          entryBg.setAlpha(0);
          this.scene.tweens.add({
            targets: entryBg,
            alpha: { from: 0, to: 1 },
            duration: 300,
            ease: 'Power2'
          });
        }

        // Create icon for current player (slightly larger but subtle)
        let iconText;
        if (isCurrentPlayer) {
          iconText = this.scene.add
            .text(
              entryX + 5,
              entryY + 2,
              "►",
              {
                color: "#ffffff", // Keep white for subtlety
                fontSize: "16px", // Slightly larger but not too prominent
                fontStyle: "bold",
                fontFamily: UI_FONT_FAMILY,
              }
            )
            .setOrigin(0, 0);
          elements.push(iconText);
        }

        // Create player text - keep mostly the same, just bold for active player
        const playerText = this.scene.add
          .text(
            entryX + (isCurrentPlayer ? 25 : 5),
            entryY + 2,
            player.name,
            {
              color: "#ffffff", // Keep white for all players
              fontSize: "14px", // Same size for all
              fontStyle: isCurrentPlayer ? "bold" : "normal",
              fontFamily: UI_FONT_FAMILY,
            }
          )
          .setOrigin(0, 0);
        elements.push(playerText);

        // Add [BOT] suffix for AI players
        if (player.isBot) {
          const botLabel = this.scene.add
            .text(
              entryX + (isCurrentPlayer ? 25 : 5) + playerText.width + 4,
              entryY + 4,
              "[BOT]",
              {
                color: "#aaaaaa",
                fontSize: "10px",
                fontFamily: UI_FONT_FAMILY,
              }
            )
            .setOrigin(0, 0);
          elements.push(botLabel);
        }

        // Create money text (right-aligned) - keep mostly the same
        const moneyText = this.scene.add
          .text(
            this.scene.scale.width - LEADERBOARD_PADDING - 5,
            entryY + 2,
            `${player.money}M`,
            {
              color: "#ffffff", // Keep white for all players
              fontSize: "14px", // Same size for all
              fontStyle: isCurrentPlayer ? "bold" : "normal",
              fontFamily: UI_FONT_FAMILY,
            }
          )
          .setOrigin(1, 0); // Right-align
        elements.push(moneyText);

        return elements;
      })
      .flat(); // Flatten the array of arrays

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