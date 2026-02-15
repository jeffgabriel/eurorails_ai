import "phaser";
import { GameState } from "../../shared/types/GameTypes";

import { GameStateService } from "../services/GameStateService";
import { PlayerStateService } from "../services/PlayerStateService";
import { UI_FONT_FAMILY } from "../config/uiFont";

export class LeaderboardManager {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private gameState: GameState;
  private nextPlayerCallback: () => void;
  private gameStateService: GameStateService | null = null;
  private playerStateService: PlayerStateService | null = null;
  private toggleChatCallback?: () => void;
  private openDMCallback?: (playerId: string, playerName: string) => void;
  private cameraController?: any; // CameraController type

  constructor(
    scene: Phaser.Scene,
    gameState: GameState,
    nextPlayerCallback: () => void,
    gameStateService?: GameStateService,
    toggleChatCallback?: () => void,
    openDMCallback?: (playerId: string, playerName: string) => void,
    playerStateService?: PlayerStateService,
    cameraController?: any
  ) {
    this.scene = scene;
    this.gameState = gameState;
    this.nextPlayerCallback = nextPlayerCallback;
    this.gameStateService = gameStateService || null;
    this.toggleChatCallback = toggleChatCallback;
    this.openDMCallback = openDMCallback;
    this.playerStateService = playerStateService || null;
    this.cameraController = cameraController;
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
      .setOrigin(0, 0)
      .setInteractive(); // Block pointer events from passing through

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

        // Create player text - clickable for DM (requires userId for chat API)
        const dmTargetUserId = player.userId;
        const isLocalPlayer = this.playerStateService?.isLocalPlayer?.(player.id) ?? false;
        const playerText = this.scene.add
          .text(
            entryX + (isCurrentPlayer ? 25 : 5),
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

        // Make clickable for DM (except local player; requires userId)
        if (this.openDMCallback && !isLocalPlayer && dmTargetUserId) {
          playerText
            .setInteractive({ useHandCursor: true })
            .on("pointerdown", (pointer: Phaser.Input.Pointer) => {
              if (pointer.event) {
                pointer.event.stopPropagation();
              }
              this.openDMCallback!(dmTargetUserId, player.name);
            });
        }
        elements.push(playerText);

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
    
    // Create and add chat button
    const chatButton = this.createChatButton();

    // Add all UI elements to container
    targetContainer.add([
      leaderboardBg,
      leaderboardTitle,
      ...playerEntries,
      ...nextPlayerButton.getAll(),
      ...chatButton.getAll()
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
        .on("pointerdown", (pointer: Phaser.Input.Pointer) => {
          if (pointer.event) {
            pointer.event.stopPropagation();
          }
          this.nextPlayerCallback();
        })
        .on("pointerover", () => nextPlayerButton.setFillStyle(0x008800))
        .on("pointerout", () => nextPlayerButton.setFillStyle(0x00aa00));
    } else {
      // Disabled state - grayed out, no interaction
      nextPlayerButton.setInteractive({ useHandCursor: false });
    }

    buttonContainer.add([nextPlayerButton, nextPlayerText]);
    return buttonContainer;
  }

  private createChatButton(): Phaser.GameObjects.Container {
    const buttonContainer = this.scene.add.container(0, 0);
    const LEADERBOARD_WIDTH = 150;
    const LEADERBOARD_PADDING = 10;
    
    // Chat button goes below the "Next Player" button
    const buttonY = LEADERBOARD_PADDING + 90 + this.gameState.players.length * 20;

    // Add chat button
    const chatButton = this.scene.add
      .rectangle(
        this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
        buttonY,
        LEADERBOARD_WIDTH,
        40,
        0x0066cc,
        0.9
      )
      .setOrigin(0, 0);

    const chatButtonText = this.scene.add
      .text(
        this.scene.scale.width - LEADERBOARD_WIDTH / 2 - LEADERBOARD_PADDING,
        buttonY + 20,
        "💬 Chat",
        {
          color: "#ffffff",
          fontSize: "16px",
          fontStyle: "bold",
          fontFamily: UI_FONT_FAMILY,
        }
      )
      .setOrigin(0.5, 0.5);

    // Make the button interactive
    if (this.toggleChatCallback) {
      chatButton
        .setInteractive({ useHandCursor: true })
        .on("pointerdown", (pointer: Phaser.Input.Pointer) => {
          if (pointer.event) {
            pointer.event.stopPropagation();
          }
          this.toggleChatCallback!();
        })
        .on("pointerover", () => chatButton.setFillStyle(0x0055aa))
        .on("pointerout", () => chatButton.setFillStyle(0x0066cc));
    }

    buttonContainer.add([chatButton, chatButtonText]);
    return buttonContainer;
  }
}