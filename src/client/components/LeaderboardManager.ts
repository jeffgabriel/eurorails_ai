import "phaser";
import { GameState } from "../../shared/types/GameTypes";

import { GameStateService } from "../services/GameStateService";

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
        }
      )
      .setOrigin(0.5, 0);

    // Add all player entries
    const playerEntries = this.gameState.players
      .map((player, index) => {
        const isCurrentPlayer = index === this.gameState.currentPlayerIndex;

        // Create background highlight for current player
        let entryBg;
        if (isCurrentPlayer) {
          entryBg = this.scene.add
            .rectangle(
              this.scene.scale.width - LEADERBOARD_WIDTH - LEADERBOARD_PADDING,
              LEADERBOARD_PADDING + 30 + index * 20,
              LEADERBOARD_WIDTH,
              20,
              0x666666,
              0.5
            )
            .setOrigin(0, 0);
        }

        // Create player text
        const playerText = this.scene.add
          .text(
            this.scene.scale.width -
              LEADERBOARD_WIDTH -
              LEADERBOARD_PADDING +
              5,
            LEADERBOARD_PADDING + 30 + index * 20,
            `${isCurrentPlayer ? "►" : " "} ${player.name}`,
            {
              color: "#ffffff",
              fontSize: "14px",
              fontStyle: isCurrentPlayer ? "bold" : "normal",
            }
          )
          .setOrigin(0, 0);

        // Create money text (right-aligned)
        const moneyText = this.scene.add
          .text(
            this.scene.scale.width - LEADERBOARD_PADDING - 5,
            LEADERBOARD_PADDING + 30 + index * 20,
            `${player.money}M`,
            {
              color: "#ffffff",
              fontSize: "14px",
              fontStyle: isCurrentPlayer ? "bold" : "normal",
            }
          )
          .setOrigin(1, 0); // Right-align

        // Return all elements for this player
        return entryBg
          ? [entryBg, playerText, moneyText]
          : [playerText, moneyText];
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