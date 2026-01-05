import "phaser";
import { GameState } from "../../shared/types/GameTypes";
import { TrainCard } from "../components/TrainCard";
import { DemandCard } from "../components/DemandCard";
import { GameStateService } from "../services/GameStateService";
import { CitySelectionManager } from "../components/CitySelectionManager";
import { MapRenderer } from "../components/MapRenderer";
import { TrainInteractionManager } from "../components/TrainInteractionManager";
import { TrackDrawingManager } from "../components/TrackDrawingManager";
import { UI_FONT_FAMILY } from "../config/uiFont";
import { TrainType } from "../../shared/types/GameTypes";

interface PlayerHandSceneData {
  gameState: GameState;
  toggleDrawingCallback: () => void;
  onUndo: () => void;
  canUndo: () => boolean;
  gameStateService: GameStateService;
  mapRenderer: MapRenderer;
  trainInteractionManager: TrainInteractionManager;
  trackDrawingManager: TrackDrawingManager;
  isDrawingMode: boolean;
  currentTrackCost: number;
  onClose: () => void;
}

const colorMap: { [key: string]: string } = {
  "#FFD700": "yellow",
  "#FF0000": "red",
  "#0000FF": "blue",
  "#000000": "black",
  "#008000": "green",
  "#8B4513": "brown",
};
const COST_COLOR = "#ffffff";

export class PlayerHandScene extends Phaser.Scene {
  private gameState!: GameState;
  private toggleDrawingCallback!: () => void;
  private onUndo!: () => void;
  private canUndo!: () => boolean;
  private gameStateService!: GameStateService;
  private mapRenderer!: MapRenderer;
  private trainInteractionManager!: TrainInteractionManager;
  private trackDrawingManager!: TrackDrawingManager;
  private isDrawingMode: boolean = false;
  private currentTrackCost: number = 0;
  private onCloseCallback!: () => void;

  // UI elements
  private trainCard: TrainCard | null = null;
  private cards: DemandCard[] = [];
  // Visual-only demand card marks: cardId -> selected demand line (0..2) or null
  private demandCardMarkedLineByCardId: Map<number, number | null> = new Map();
  private demandMarksStorageKey: string | null = null;
  private citySelectionManager: CitySelectionManager | null = null;
  private background: Phaser.GameObjects.Rectangle | null = null;
  private rootSizer: any | null = null;
  private cardsSizer: any | null = null;
  private infoSizer: any | null = null;
  private controlsSizer: any | null = null;
  private nameAndMoneyText: Phaser.GameObjects.Text | null = null;
  private buildCostText: Phaser.GameObjects.Text | null = null;
  private crayonButtonImage: Phaser.GameObjects.Image | null = null;
  private crayonHighlightCircle: Phaser.GameObjects.Arc | null = null;
  private lastCurrentPlayerIndex: number | null = null;
  private lastIsLocalPlayerActive: boolean | null = null;
  private lastCanUndo: boolean | null = null;
  private lastHandSignature: string | null = null;
  private lastLoadsSignature: string | null = null;
  private trainPurchaseModal: Phaser.GameObjects.Container | null = null;
  private actionsModal: Phaser.GameObjects.Container | null = null;
  private confirmDiscardModal: Phaser.GameObjects.Container | null = null;
  private confirmRestartModal: Phaser.GameObjects.Container | null = null;
  private confirmTrainPurchaseModal: Phaser.GameObjects.Container | null = null;
  private toastContainer: Phaser.GameObjects.Container | null = null;

  // Card dimensions
  private readonly CARD_WIDTH = 170;
  private readonly CARD_HEIGHT = 255;
  private readonly CARD_SPACING_HORIZONTAL = 20;

  // Layout constants
  private readonly HAND_HEIGHT_BASE = 280;

  constructor() {
    super({ key: "PlayerHandScene" });
  }

  init(data: PlayerHandSceneData) {
    this.gameState = data.gameState;
    this.toggleDrawingCallback = data.toggleDrawingCallback;
    this.onUndo = data.onUndo;
    this.canUndo = data.canUndo;
    this.gameStateService = data.gameStateService;
    this.mapRenderer = data.mapRenderer;
    this.trainInteractionManager = data.trainInteractionManager;
    this.trackDrawingManager = data.trackDrawingManager;
    this.isDrawingMode = data.isDrawingMode;
    this.currentTrackCost = data.currentTrackCost;
    this.onCloseCallback = data.onClose;

    // Make sure per-game/per-player mark state survives scene lifecycles.
    this.ensureDemandMarksLoaded();
  }

  create() {
    // Create the UI (which adds to rootContainer)
    this.createUI();
    // Set camera to not scroll
    this.cameras.main.setScroll(0, 0);
  }

  /**
   * Public toast API so other systems (e.g., train click gating) can show a
   * bottom-center toast near the hand UI using the same style.
   */
  public showHandToast(message: string): void {
    this.showToast(message);
  }

  public updateTrainCardLoads(): void {
    if (!this.trainCard) return;
    this.trainCard.updateLoads();
    this.rootSizer?.layout?.();
  }


  updateSceneData(
    gameState: GameState,
    isDrawingMode: boolean,
    currentTrackCost: number
  ) {
    this.gameState = gameState;
    this.isDrawingMode = isDrawingMode;
    this.currentTrackCost = currentTrackCost;

    // If game or local player changed, reload persisted marks for the new context.
    this.ensureDemandMarksLoaded();

    const isLocalPlayerActive =
      this.gameStateService?.isLocalPlayerActive?.() ?? false;
    const canUndoNow = this.canUndo ? this.canUndo() : false;
    const currentPlayerIndex = this.gameState.currentPlayerIndex ?? 0;

    // Detect hand changes so we can rebuild the card UI immediately (deliver/undo within a turn).
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const localPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;
    const handSignature = Array.isArray(localPlayer?.hand)
      ? localPlayer!.hand.map((c) => c.id).join(",")
      : "";
    const loadsSignature = Array.isArray(localPlayer?.trainState?.loads)
      ? localPlayer!.trainState!.loads.join(",")
      : "";

    const needsFullRefresh =
      !this.rootSizer ||
      this.lastCurrentPlayerIndex === null ||
      this.lastIsLocalPlayerActive === null ||
      this.lastCanUndo === null ||
      this.lastHandSignature === null ||
      this.lastLoadsSignature === null ||
      this.lastCurrentPlayerIndex !== currentPlayerIndex ||
      this.lastIsLocalPlayerActive !== isLocalPlayerActive ||
      this.lastCanUndo !== canUndoNow ||
      this.lastHandSignature !== handSignature ||
      this.lastLoadsSignature !== loadsSignature;

    // Turn changes and permission changes affect which controls render (undo button,
    // active-player alpha/interactive state, etc.). Those are easiest to keep correct
    // via a non-animated rebuild.
    if (needsFullRefresh) {
      this.createUI({ animate: false });
      this.lastCurrentPlayerIndex = currentPlayerIndex;
      this.lastIsLocalPlayerActive = isLocalPlayerActive;
      this.lastCanUndo = canUndoNow;
      this.lastHandSignature = handSignature;
      this.lastLoadsSignature = loadsSignature;
      return;
    }

    // Small updates (cost, draw-mode highlight, money text) can update in-place.
    this.refreshDynamicUI();
  }

  private getBuildCostDisplay(currentPlayer: any): { text: string; color: string } {
    let costWarning = "";
    let costColor = COST_COLOR;
    const turnLimit = this.trackDrawingManager?.getTurnBuildLimit?.() ?? 20;

    // "Insufficient funds" is only meaningful while actively drawing / previewing track.
    // After committing track, the player's money is already decremented, while `currentTrackCost`
    // may still reflect total spent this turn, which would incorrectly trigger this warning.
    if (this.isDrawingMode && this.currentTrackCost > currentPlayer.money) {
      costColor = "#ff4444";
      costWarning = " (Insufficient funds!)";
    } else if (this.currentTrackCost > turnLimit) {
      costColor = "#ff8800";
      costWarning = ` (Over turn limit: ${turnLimit}M!)`;
    } else if (this.currentTrackCost >= turnLimit * 0.8) {
      costColor = "#ffff00";
    }

    return {
      text: `Build Cost: ${this.currentTrackCost}M${costWarning}`,
      color: costColor,
    };
  }

  private refreshDynamicUI(): void {
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const localPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;
    if (!localPlayer) return;

    // Update name/money if it changed
    if (this.nameAndMoneyText) {
      this.nameAndMoneyText.setText(
        `${localPlayer.name}\nMoney: ECU ${localPlayer.money}M`
      );
    }

    // Update build cost text + color
    if (this.buildCostText) {
      const display = this.getBuildCostDisplay(localPlayer);
      this.buildCostText.setText(display.text);
      this.buildCostText.setColor(display.color);
    }

    // Update crayon drawing mode visuals without recreating the whole UI.
    if (this.crayonButtonImage) {
      this.crayonButtonImage.setScale(this.isDrawingMode ? 0.18 : 0.15);
    }
    if (this.crayonHighlightCircle) {
      this.crayonHighlightCircle.setVisible(this.isDrawingMode);
    }

    // Re-layout once (text size can change)
    this.rootSizer?.layout?.();
  }

  private getLocalPlayer(): any | null {
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    return localPlayerId ? this.gameState.players.find((p) => p.id === localPlayerId) : null;
  }

  private getTurnBuildCostThisTurn(localPlayer: any): number {
    const previousSessionsCost =
      this.trackDrawingManager.getPlayerTrackState(localPlayer.id)?.turnBuildCost || 0;
    const currentSessionCost = this.trackDrawingManager.getCurrentTurnBuildCost();
    return previousSessionsCost + currentSessionCost;
  }

  private trainTypeToCardKey(trainType: TrainType): string {
    // Train card textures are loaded as: train_card_freight, train_card_fastfreight, etc.
    return `train_card_${trainType.toLowerCase().replace(/[_\s-]+/g, "")}`;
  }

  private openTrainPurchaseModal(): void {
    if (this.trainPurchaseModal) {
      this.closeTrainPurchaseModal();
    }
    // If actions is open, close it before opening the dedicated upgrade dialog.
    this.closeActionsModal();

    const localPlayer = this.getLocalPlayer();
    if (!localPlayer) return;

    const isLocalPlayerActive = this.gameStateService?.isLocalPlayerActive?.() ?? false;
    if (!isLocalPlayerActive) return;

    const turnBuildCost = this.getTurnBuildCostThisTurn(localPlayer);
    const hasAnyTrackThisTurn =
      this.isDrawingMode || (this.canUndo ? this.canUndo() : false) || turnBuildCost > 0;

    const options: Array<{
      kind: "upgrade" | "crossgrade";
      targetTrainType: TrainType;
      cost: number;
      title: string;
      subtitle: string;
      enabled: boolean;
      disabledReason?: string;
    }> = [];

    const needsMoney = (cost: number) => localPlayer.money < cost;

    if (localPlayer.trainType === TrainType.Freight) {
      const baseEnabled = !needsMoney(20) && !hasAnyTrackThisTurn;
      const baseReason = needsMoney(20)
        ? "Need 20M"
        : hasAnyTrackThisTurn
          ? "Must upgrade before building"
          : undefined;

      options.push(
        {
          kind: "upgrade",
          targetTrainType: TrainType.FastFreight,
          cost: 20,
          title: "Fast Freight",
          subtitle: "2 loads, 12 moves",
          enabled: baseEnabled,
          disabledReason: baseEnabled ? undefined : baseReason,
        },
        {
          kind: "upgrade",
          targetTrainType: TrainType.HeavyFreight,
          cost: 20,
          title: "Heavy Freight",
          subtitle: "3 loads, 9 moves",
          enabled: baseEnabled,
          disabledReason: baseEnabled ? undefined : baseReason,
        }
      );
    } else if (localPlayer.trainType === TrainType.FastFreight) {
      const canUpgrade = !needsMoney(20) && !hasAnyTrackThisTurn;
      options.push({
        kind: "upgrade",
        targetTrainType: TrainType.Superfreight,
        cost: 20,
        title: "Superfreight",
        subtitle: "3 loads, 12 moves",
        enabled: canUpgrade,
        disabledReason: canUpgrade ? undefined : (needsMoney(20) ? "Need 20M" : "Must upgrade before building"),
      });

      const canCrossgrade = !needsMoney(5) && turnBuildCost <= 15;
      options.push({
        kind: "crossgrade",
        targetTrainType: TrainType.HeavyFreight,
        cost: 5,
        title: "Crossgrade: Heavy",
        subtitle: "3 loads, 9 moves (limit 15M build)",
        enabled: canCrossgrade,
        disabledReason: canCrossgrade
          ? undefined
          : (needsMoney(5) ? "Need 5M" : "Track spend must be ≤ 15M"),
      });
    } else if (localPlayer.trainType === TrainType.HeavyFreight) {
      const canUpgrade = !needsMoney(20) && !hasAnyTrackThisTurn;
      options.push({
        kind: "upgrade",
        targetTrainType: TrainType.Superfreight,
        cost: 20,
        title: "Superfreight",
        subtitle: "3 loads, 12 moves",
        enabled: canUpgrade,
        disabledReason: canUpgrade ? undefined : (needsMoney(20) ? "Need 20M" : "Must upgrade before building"),
      });

      const canCrossgrade = !needsMoney(5) && turnBuildCost <= 15;
      options.push({
        kind: "crossgrade",
        targetTrainType: TrainType.FastFreight,
        cost: 5,
        title: "Crossgrade: Fast",
        subtitle: "2 loads, 12 moves (limit 15M build)",
        enabled: canCrossgrade,
        disabledReason: canCrossgrade
          ? undefined
          : (needsMoney(5) ? "Need 5M" : "Track spend must be ≤ 15M"),
      });
    } else {
      // Superfreight: no upgrade options
    }

    const modalRoot = this.add.container(0, 0).setDepth(1200);
    const backdrop = this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x000000, 0.65)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    backdrop.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
    });
    modalRoot.add(backdrop);

    const panelW = Math.min(720, this.scale.width - 40);
    const panelX = this.scale.width / 2;
    const panelY = this.scale.height / 2;

    const panelBg = (this as any).rexUI.add.roundRectangle({
      width: panelW,
      height: 320,
      color: 0x1a1a1a,
      alpha: 1,
      radius: 16,
    });

    const panelSizer = (this as any).rexUI.add
      .sizer({
        orientation: "y",
        space: { left: 18, right: 18, top: 14, bottom: 16, item: 12 },
      })
      .setPosition(panelX, panelY);
    panelSizer.addBackground(panelBg);

    const headerRow = (this as any).rexUI.add.sizer({
      orientation: "x",
      space: { item: 10 },
    });
    const title = this.add.text(0, 0, "Train Upgrade", {
      color: "#ffffff",
      fontSize: "20px",
      fontStyle: "bold",
      fontFamily: UI_FONT_FAMILY,
    });
    const flex = this.add.zone(0, 0, 1, 1);
    const closeX = this.add
      .text(0, 0, "✕", {
        color: "#ffffff",
        fontSize: "20px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
      })
      .setInteractive({ useHandCursor: true });
    closeX.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
      this.closeTrainPurchaseModal();
    });
    headerRow.add(title, { proportion: 0, align: "center", expand: false });
    headerRow.add(flex, { proportion: 1, align: "center", expand: true });
    headerRow.add(closeX, { proportion: 0, align: "center", expand: false });
    panelSizer.add(headerRow, { proportion: 0, align: "center", expand: true });

    if (options.length === 0) {
      const none = this.add.text(0, 0, "No upgrades available.", {
        color: "#aaaaaa",
        fontSize: "14px",
        fontFamily: UI_FONT_FAMILY,
        align: "center",
      });
      panelSizer.add(none, { proportion: 0, align: "center", expand: false });
    } else {
      const optionsRow = (this as any).rexUI.add.sizer({
        orientation: "x",
        space: { item: 22 },
      });

      options.forEach((opt) => {
        const optionSizer = (this as any).rexUI.add.sizer({
          orientation: "y",
          space: { item: 6 },
        });

        const texKey = this.trainTypeToCardKey(opt.targetTrainType);
        const cardImg = this.add.image(0, 0, texKey).setScale(0.1);
        cardImg.setAlpha(opt.enabled ? 1.0 : 0.35);
        cardImg.setInteractive({ useHandCursor: opt.enabled });
        if (opt.enabled) {
          cardImg.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
            if (pointer.event) pointer.event.stopPropagation();
            // Train purchase is NOT undoable this turn; require confirm.
            this.openConfirmTrainPurchaseModal({
              kind: opt.kind,
              targetTrainType: opt.targetTrainType,
              title: opt.title,
              cost: opt.cost,
            });
          });
        }

        const label = this.add.text(0, 0, `${opt.title} (ECU ${opt.cost}M)`, {
          color: opt.enabled ? "#ffffff" : "#aaaaaa",
          fontSize: "14px",
          fontStyle: "bold",
          fontFamily: UI_FONT_FAMILY,
          align: "center",
          wordWrap: { width: 220, useAdvancedWrap: true },
        });
        const sub = this.add.text(0, 0, opt.enabled ? opt.subtitle : (opt.disabledReason || opt.subtitle), {
          color: opt.enabled ? "#dddddd" : "#888888",
          fontSize: "12px",
          fontFamily: UI_FONT_FAMILY,
          align: "center",
          wordWrap: { width: 220, useAdvancedWrap: true },
        });

        optionSizer.add(cardImg, { proportion: 0, align: "center", expand: false });
        optionSizer.add(label, { proportion: 0, align: "center", expand: false });
        optionSizer.add(sub, { proportion: 0, align: "center", expand: false });
        optionsRow.add(optionSizer, { proportion: 0, align: "center", expand: false });
      });

      panelSizer.add(optionsRow, { proportion: 0, align: "center", expand: false });
    }

    const closeBtn = this.add
      .text(0, 0, "Close", {
        color: "#ffffff",
        fontSize: "14px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        backgroundColor: "#444",
        padding: { left: 12, right: 12, top: 8, bottom: 8 },
      })
      .setInteractive({ useHandCursor: true });
    closeBtn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
      this.closeTrainPurchaseModal();
    });
    panelSizer.add(closeBtn, { proportion: 0, align: "center", expand: false });

    modalRoot.add(panelSizer);
    panelSizer.layout();

    this.trainPurchaseModal = modalRoot;
  }

  private openActionsModal(): void {
    if (this.actionsModal) {
      this.closeActionsModal();
    }
    const localPlayer = this.getLocalPlayer();
    if (!localPlayer) return;

    const isLocalPlayerActive = this.gameStateService?.isLocalPlayerActive?.() ?? false;
    if (!isLocalPlayerActive) return;

    const turnBuildCost = this.getTurnBuildCostThisTurn(localPlayer);

    // Backdrop + modal root (blocks clicks; does NOT dismiss)
    const modalRoot = this.add.container(0, 0).setDepth(1000);
    const backdrop = this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x000000, 0.55)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    backdrop.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
    });
    modalRoot.add(backdrop);

    const panelX = this.scale.width / 2;
    const panelY = this.scale.height / 2;
    const panelW = Math.min(520, this.scale.width - 40);

    const panelBg = (this as any).rexUI.add.roundRectangle({
      width: panelW,
      height: 320,
      color: 0x1a1a1a,
      alpha: 1,
      radius: 16,
    });

    const panelSizer = (this as any).rexUI.add
      .sizer({
        orientation: "y",
        space: { left: 18, right: 18, top: 14, bottom: 16, item: 14 },
      })
      .setPosition(panelX, panelY);
    panelSizer.addBackground(panelBg);

    const headerRow = (this as any).rexUI.add.sizer({
      orientation: "x",
      space: { item: 10 },
    });
    const title = this.add.text(0, 0, "Actions", {
      color: "#ffffff",
      fontSize: "20px",
      fontStyle: "bold",
      fontFamily: UI_FONT_FAMILY,
    });
    const flex = this.add.zone(0, 0, 1, 1);
    const closeX = this.add
      .text(0, 0, "✕", {
        color: "#ffffff",
        fontSize: "20px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
      })
      .setInteractive({ useHandCursor: true });
    closeX.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
      this.closeActionsModal();
    });
    headerRow.add(title, { proportion: 0, align: "center", expand: false });
    headerRow.add(flex, { proportion: 1, align: "center", expand: true });
    headerRow.add(closeX, { proportion: 0, align: "center", expand: false });
    panelSizer.add(headerRow, { proportion: 0, align: "center", expand: true });

    // Action: Train Upgrade (opens the dedicated upgrade dialog)
    const upgradeAvailable = localPlayer.trainType !== TrainType.Superfreight;
    const upgradeBtn = this.add
      .text(0, 0, upgradeAvailable ? "Train Upgrade…" : "Train Upgrade (Not available)", {
        color: "#ffffff",
        fontSize: "16px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        backgroundColor: upgradeAvailable ? "#3b5" : "#555",
        padding: { left: 14, right: 14, top: 10, bottom: 10 },
      })
      .setAlpha(upgradeAvailable ? 1.0 : 0.6)
      .setInteractive({ useHandCursor: upgradeAvailable });
    if (upgradeAvailable) {
      upgradeBtn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        if (pointer.event) pointer.event.stopPropagation();
        // Choosing this action closes Actions and opens the dedicated upgrade modal.
        this.closeActionsModal();
        this.openTrainPurchaseModal();
      });
    }
    panelSizer.add(upgradeBtn, { proportion: 0, align: "center", expand: false });

    // Section: Discard & Redraw (Skip Turn)
    const canUndoNow = this.canUndo ? this.canUndo() : false;
    const canDiscard =
      isLocalPlayerActive &&
      !this.isDrawingMode &&
      turnBuildCost === 0 &&
      !canUndoNow;
    const discardDisabledReason = !isLocalPlayerActive
      ? "Only available on your turn"
      : (this.isDrawingMode ? "Exit build mode first"
          : (turnBuildCost !== 0 ? "Cannot discard after building"
              : (canUndoNow ? "Undo must be cleared first" : "")));

    const discardLabel = this.add.text(0, 0, "Discard & Redraw (Skip Turn)", {
      color: "#dddddd",
      fontSize: "14px",
      fontStyle: "bold",
      fontFamily: UI_FONT_FAMILY,
    });
    panelSizer.add(discardLabel, { proportion: 0, align: "center", expand: false });

    const discardBtn = this.add
      .text(0, 0, canDiscard ? "Discard & End Turn" : (discardDisabledReason || "Discard & End Turn"), {
        color: "#ffffff",
        fontSize: "16px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        backgroundColor: canDiscard ? "#b33" : "#555",
        padding: { left: 14, right: 14, top: 10, bottom: 10 },
      })
      .setAlpha(canDiscard ? 1.0 : 0.6)
      .setInteractive({ useHandCursor: canDiscard });
    if (canDiscard) {
      discardBtn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        if (pointer.event) pointer.event.stopPropagation();
        // Choosing this action closes Actions and opens the confirm dialog.
        this.closeActionsModal();
        this.openConfirmDiscardModal();
      });
    }
    panelSizer.add(discardBtn, { proportion: 0, align: "center", expand: false });

    // Section: Restart (Reset) - Mercy rule recovery (does NOT end turn)
    const canRestart =
      isLocalPlayerActive &&
      !this.isDrawingMode &&
      turnBuildCost === 0 &&
      !canUndoNow;
    const restartDisabledReason = !isLocalPlayerActive
      ? "Only available on your turn"
      : (this.isDrawingMode ? "Exit build mode first"
          : (turnBuildCost !== 0 ? "Cannot restart after building"
              : (canUndoNow ? "Undo must be cleared first" : "")));

    const restartLabel = this.add.text(0, 0, "Restart (Reset) — Mercy Rule", {
      color: "#dddddd",
      fontSize: "14px",
      fontStyle: "bold",
      fontFamily: UI_FONT_FAMILY,
    });
    panelSizer.add(restartLabel, { proportion: 0, align: "center", expand: false });

    const restartBtn = this.add
      .text(0, 0, canRestart ? "Restart Player" : (restartDisabledReason || "Restart Player"), {
        color: "#ffffff",
        fontSize: "16px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        backgroundColor: canRestart ? "#a63" : "#555",
        padding: { left: 14, right: 14, top: 10, bottom: 10 },
      })
      .setAlpha(canRestart ? 1.0 : 0.6)
      .setInteractive({ useHandCursor: canRestart });
    if (canRestart) {
      restartBtn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        if (pointer.event) pointer.event.stopPropagation();
        this.closeActionsModal();
        this.openConfirmRestartModal();
      });
    }
    panelSizer.add(restartBtn, { proportion: 0, align: "center", expand: false });

    const closeBtn = this.add
      .text(0, 0, "Close", {
        color: "#ffffff",
        fontSize: "14px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        backgroundColor: "#444",
        padding: { left: 10, right: 10, top: 6, bottom: 6 },
      })
      .setInteractive({ useHandCursor: true });
    closeBtn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
      this.closeActionsModal();
    });
    panelSizer.add(closeBtn, { proportion: 0, align: "center", expand: false });

    modalRoot.add(panelSizer);
    panelSizer.layout();

    this.actionsModal = modalRoot;
  }

  private closeTrainPurchaseModal(): void {
    if (!this.trainPurchaseModal) return;
    this.trainPurchaseModal.destroy(true);
    this.trainPurchaseModal = null;
  }

  private closeActionsModal(): void {
    if (!this.actionsModal) return;
    this.actionsModal.destroy(true);
    this.actionsModal = null;
  }

  private showToast(message: string): void {
    try {
      if (this.toastContainer) {
        this.toastContainer.destroy(true);
        this.toastContainer = null;
      }

      const paddingX = 16;
      const paddingY = 10;
      const maxWidth = Math.min(520, this.scale.width - 40);

      const text = this.add.text(0, 0, message, {
        color: "#ffffff",
        fontSize: "16px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        wordWrap: { width: maxWidth - paddingX * 2, useAdvancedWrap: true },
        align: "center",
      }).setOrigin(0.5);

      const bgW = Math.min(maxWidth, text.width + paddingX * 2);
      const bgH = text.height + paddingY * 2;
      const bg = (this as any).rexUI.add.roundRectangle({
        width: bgW,
        height: bgH,
        color: 0x111111,
        alpha: 0.92,
        radius: 10,
      });

      const container = this.add.container(this.scale.width / 2, this.scale.height - this.HAND_HEIGHT_BASE - 24);
      container.setDepth(2500);
      container.add([bg, text]);
      text.setPosition(0, 0);
      bg.setPosition(0, 0);

      this.toastContainer = container;

      this.tweens.add({
        targets: container,
        alpha: 0,
        duration: 1200,
        delay: 1600,
        ease: "Power2",
        onComplete: () => {
          container.destroy(true);
          if (this.toastContainer === container) {
            this.toastContainer = null;
          }
        },
      });
    } catch (e) {
      // Silent: toast is non-critical
    }
  }

  private async handleTrainPurchase(kind: "upgrade" | "crossgrade", targetTrainType: TrainType): Promise<void> {
    const result = await this.gameStateService.purchaseTrainType(kind, targetTrainType);
    if (!result.ok) {
      const msg = (result.errorMessage || "Purchase failed").toLowerCase();
      if (msg.includes("too many loads")) {
        this.showToast("Current loads could not be transferred to new train.");
      } else if (msg.includes("spending more than 15m") || msg.includes("15m")) {
        this.showToast("Crossgrade requires track spend ≤ 15M this turn.");
      } else if (msg.includes("insufficient")) {
        this.showToast("Insufficient funds for that train change.");
      } else {
        this.showToast(result.errorMessage || "Purchase failed.");
      }
      return;
    }

    // Apply per-turn build rules locally
    if (kind === "upgrade") {
      // Full upgrade consumes build phase: no drawing mode for remainder of turn
      this.trackDrawingManager.setDrawingDisabledForTurn(true);
    } else {
      // Crossgrade reduces remaining build allowance to 15M this turn
      this.trackDrawingManager.setTurnBuildLimit(15);
    }

    // Refresh our local view of game state (same object reference updated by GameStateService)
    this.gameState = this.gameStateService.getGameState();

    this.closeActionsModal();
    // Rebuild UI to ensure TrainCard is recreated with latest player object
    this.createUI({ animate: false });

    // Ensure scoreboard/leaderboard updates immediately (not only on turn change).
    try {
      const gameScene = this.scene.get("GameScene") as any;
      if (gameScene && typeof gameScene.refreshUIOverlay === "function") {
        gameScene.refreshUIOverlay();
      }
    } catch {
      // non-fatal
    }
  }

  private openConfirmDiscardModal(): void {
    if (this.confirmDiscardModal) {
      this.closeConfirmDiscardModal();
    }
    const isLocalPlayerActive = this.gameStateService?.isLocalPlayerActive?.() ?? false;
    if (!isLocalPlayerActive) return;

    const modalRoot = this.add.container(0, 0).setDepth(1200);
    const backdrop = this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x000000, 0.65)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    backdrop.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
    });
    modalRoot.add(backdrop);

    const panelW = Math.min(560, this.scale.width - 40);
    const panelX = this.scale.width / 2;
    const panelY = this.scale.height / 2;

    const panelBg = (this as any).rexUI.add.roundRectangle({
      width: panelW,
      height: 240,
      color: 0x1a1a1a,
      alpha: 1,
      radius: 16,
    });

    const panelSizer = (this as any).rexUI.add
      .sizer({
        orientation: "y",
        space: { left: 16, right: 16, top: 12, bottom: 12, item: 12 },
      })
      .setPosition(panelX, panelY);
    panelSizer.addBackground(panelBg);

    const headerRow = (this as any).rexUI.add.sizer({
      orientation: "x",
      space: { item: 10 },
    });
    const title = this.add.text(0, 0, "Confirm Discard & Redraw", {
      color: "#ffffff",
      fontSize: "18px",
      fontStyle: "bold",
      fontFamily: UI_FONT_FAMILY,
    });
    const flex = this.add.zone(0, 0, 1, 1);
    const closeX = this.add
      .text(0, 0, "✕", {
        color: "#ffffff",
        fontSize: "20px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
      })
      .setInteractive({ useHandCursor: true });
    closeX.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
      this.closeConfirmDiscardModal();
    });
    headerRow.add(title, { proportion: 0, align: "center", expand: false });
    headerRow.add(flex, { proportion: 1, align: "center", expand: true });
    headerRow.add(closeX, { proportion: 0, align: "center", expand: false });
    panelSizer.add(headerRow, { proportion: 0, align: "center", expand: true });

    const body = this.add.text(
      0,
      0,
      "Discard your entire hand and draw 3 new Demand cards.\nThis will end your turn immediately.",
      {
        color: "#dddddd",
        fontSize: "14px",
        fontFamily: UI_FONT_FAMILY,
        align: "center",
        wordWrap: { width: panelW - 40, useAdvancedWrap: true },
      }
    );
    panelSizer.add(body, { proportion: 0, align: "center", expand: false });

    const buttonsRow = (this as any).rexUI.add.sizer({
      orientation: "x",
      space: { item: 14 },
    });

    const cancelBtn = this.add
      .text(0, 0, "Cancel", {
        color: "#ffffff",
        fontSize: "14px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        backgroundColor: "#444",
        padding: { left: 12, right: 12, top: 8, bottom: 8 },
      })
      .setInteractive({ useHandCursor: true });
    cancelBtn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
      this.closeConfirmDiscardModal();
    });

    const confirmBtn = this.add
      .text(0, 0, "Discard & End Turn", {
        color: "#ffffff",
        fontSize: "14px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        backgroundColor: "#b33",
        padding: { left: 12, right: 12, top: 8, bottom: 8 },
      })
      .setInteractive({ useHandCursor: true });
    confirmBtn.on("pointerdown", async (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
      const result = await this.gameStateService.discardHandAndEndTurn();
      if (!result.ok) {
        this.showToast(result.errorMessage || "Discard failed.");
        return;
      }
      this.closeConfirmDiscardModal();
      this.closeActionsModal();
      // Refresh local view
      this.gameState = this.gameStateService.getGameState();
      this.createUI({ animate: false });
      const nextName = result.nextPlayerName || "Next player";
      this.showToast(`Hand replaced. Turn ended. Next: ${nextName}`);
    });

    buttonsRow.add(cancelBtn, { proportion: 0, align: "center", expand: false });
    buttonsRow.add(confirmBtn, { proportion: 0, align: "center", expand: false });
    panelSizer.add(buttonsRow, { proportion: 0, align: "center", expand: false });

    modalRoot.add(panelSizer);
    panelSizer.layout();

    this.confirmDiscardModal = modalRoot;
  }

  private closeConfirmDiscardModal(): void {
    if (!this.confirmDiscardModal) return;
    this.confirmDiscardModal.destroy(true);
    this.confirmDiscardModal = null;
  }

  private openConfirmRestartModal(): void {
    if (this.confirmRestartModal) {
      this.closeConfirmRestartModal();
    }
    const isLocalPlayerActive = this.gameStateService?.isLocalPlayerActive?.() ?? false;
    if (!isLocalPlayerActive) return;

    const modalRoot = this.add.container(0, 0).setDepth(1250);
    const backdrop = this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x000000, 0.65)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    backdrop.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
    });
    modalRoot.add(backdrop);

    const panelW = Math.min(600, this.scale.width - 40);
    const panelX = this.scale.width / 2;
    const panelY = this.scale.height / 2;

    const panelBg = (this as any).rexUI.add.roundRectangle({
      width: panelW,
      height: 280,
      color: 0x1a1a1a,
      alpha: 1,
      radius: 16,
    });

    const panelSizer = (this as any).rexUI.add
      .sizer({
        orientation: "y",
        space: { left: 16, right: 16, top: 12, bottom: 12, item: 12 },
      })
      .setPosition(panelX, panelY);
    panelSizer.addBackground(panelBg);

    const headerRow = (this as any).rexUI.add.sizer({
      orientation: "x",
      space: { item: 10 },
    });
    const title = this.add.text(0, 0, "Confirm Restart (Reset)", {
      color: "#ffffff",
      fontSize: "18px",
      fontStyle: "bold",
      fontFamily: UI_FONT_FAMILY,
    });
    const flex = this.add.zone(0, 0, 1, 1);
    const closeX = this.add
      .text(0, 0, "✕", {
        color: "#ffffff",
        fontSize: "20px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
      })
      .setInteractive({ useHandCursor: true });
    closeX.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
      this.closeConfirmRestartModal();
    });
    headerRow.add(title, { proportion: 0, align: "center", expand: false });
    headerRow.add(flex, { proportion: 1, align: "center", expand: true });
    headerRow.add(closeX, { proportion: 0, align: "center", expand: false });
    panelSizer.add(headerRow, { proportion: 0, align: "center", expand: true });

    const body = this.add.text(
      0,
      0,
      "Reset your player to recover from being cash-trapped:\n\n• Money → ECU 50M\n• Train → Freight\n• Loads → cleared\n• Track → erased\n• Demand hand → replaced\n• Train position → cleared (you'll re-place your train)\n\nThis does NOT end your turn.",
      {
        color: "#dddddd",
        fontSize: "14px",
        fontFamily: UI_FONT_FAMILY,
        align: "center",
        wordWrap: { width: panelW - 40, useAdvancedWrap: true },
      }
    );
    panelSizer.add(body, { proportion: 0, align: "center", expand: false });

    const buttonsRow = (this as any).rexUI.add.sizer({
      orientation: "x",
      space: { item: 14 },
    });

    const cancelBtn = this.add
      .text(0, 0, "Cancel", {
        color: "#ffffff",
        fontSize: "14px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        backgroundColor: "#444",
        padding: { left: 12, right: 12, top: 8, bottom: 8 },
      })
      .setInteractive({ useHandCursor: true });
    cancelBtn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
      this.closeConfirmRestartModal();
    });

    const confirmBtn = this.add
      .text(0, 0, "Restart", {
        color: "#ffffff",
        fontSize: "14px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        backgroundColor: "#a63",
        padding: { left: 12, right: 12, top: 8, bottom: 8 },
      })
      .setInteractive({ useHandCursor: true });
    confirmBtn.on("pointerdown", async (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();

      const result = await this.gameStateService.restartPlayer();
      if (!result.ok) {
        this.showToast(result.errorMessage || "Restart failed.");
        return;
      }

      // Best-effort: clear local per-turn undo stack (restart requires a clean state anyway).
      try {
        const gameScene = this.scene.get("GameScene") as any;
        if (gameScene?.uiManager && typeof gameScene.uiManager.clearTurnUndoStack === "function") {
          gameScene.uiManager.clearTurnUndoStack();
        }
      } catch {
        // non-fatal
      }

      // Best-effort: refresh tracks immediately (also happens via track:updated socket).
      try {
        const gameScene = this.scene.get("GameScene") as any;
        if (gameScene?.trackManager?.loadExistingTracks && gameScene?.trackManager?.drawAllTracks) {
          await gameScene.trackManager.loadExistingTracks();
          gameScene.trackManager.drawAllTracks();
        }
      } catch {
        // non-fatal
      }

      this.closeConfirmRestartModal();
      this.closeActionsModal();
      this.gameState = this.gameStateService.getGameState();
      this.createUI({ animate: false });
      this.showToast("Player restarted. You can place your train and continue your turn.");
    });

    buttonsRow.add(cancelBtn, { proportion: 0, align: "center", expand: false });
    buttonsRow.add(confirmBtn, { proportion: 0, align: "center", expand: false });
    panelSizer.add(buttonsRow, { proportion: 0, align: "center", expand: false });

    modalRoot.add(panelSizer);
    panelSizer.layout();

    this.confirmRestartModal = modalRoot;
  }

  private closeConfirmRestartModal(): void {
    if (!this.confirmRestartModal) return;
    this.confirmRestartModal.destroy(true);
    this.confirmRestartModal = null;
  }

  private openConfirmTrainPurchaseModal(args: {
    kind: "upgrade" | "crossgrade";
    targetTrainType: TrainType;
    title: string;
    cost: number;
  }): void {
    if (this.confirmTrainPurchaseModal) {
      this.closeConfirmTrainPurchaseModal();
    }
    const isLocalPlayerActive = this.gameStateService?.isLocalPlayerActive?.() ?? false;
    if (!isLocalPlayerActive) return;

    const modalRoot = this.add.container(0, 0).setDepth(1300);
    const backdrop = this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x000000, 0.65)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    backdrop.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
    });
    modalRoot.add(backdrop);

    const panelW = Math.min(600, this.scale.width - 40);
    const panelX = this.scale.width / 2;
    const panelY = this.scale.height / 2;

    const panelBg = (this as any).rexUI.add.roundRectangle({
      width: panelW,
      height: 250,
      color: 0x1a1a1a,
      alpha: 1,
      radius: 16,
    });

    const panelSizer = (this as any).rexUI.add
      .sizer({
        orientation: "y",
        space: { left: 18, right: 18, top: 14, bottom: 16, item: 14 },
      })
      .setPosition(panelX, panelY);
    panelSizer.addBackground(panelBg);

    const headerRow = (this as any).rexUI.add.sizer({
      orientation: "x",
      space: { item: 10 },
    });
    const title = this.add.text(0, 0, "Confirm Train Purchase", {
      color: "#ffffff",
      fontSize: "18px",
      fontStyle: "bold",
      fontFamily: UI_FONT_FAMILY,
    });
    const flex = this.add.zone(0, 0, 1, 1);
    const closeX = this.add
      .text(0, 0, "✕", {
        color: "#ffffff",
        fontSize: "20px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
      })
      .setInteractive({ useHandCursor: true });
    closeX.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
      this.closeConfirmTrainPurchaseModal();
    });
    headerRow.add(title, { proportion: 0, align: "center", expand: false });
    headerRow.add(flex, { proportion: 1, align: "center", expand: true });
    headerRow.add(closeX, { proportion: 0, align: "center", expand: false });
    panelSizer.add(headerRow, { proportion: 0, align: "center", expand: true });

    const body = this.add.text(
      0,
      0,
      `${args.title} (ECU ${args.cost}M)\nThis action cannot be undone.`,
      {
        color: "#dddddd",
        fontSize: "14px",
        fontFamily: UI_FONT_FAMILY,
        align: "center",
        wordWrap: { width: panelW - 40, useAdvancedWrap: true },
      }
    );
    panelSizer.add(body, { proportion: 0, align: "center", expand: false });

    const buttonsRow = (this as any).rexUI.add.sizer({
      orientation: "x",
      space: { item: 14 },
    });

    const cancelBtn = this.add
      .text(0, 0, "Cancel", {
        color: "#ffffff",
        fontSize: "14px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        backgroundColor: "#444",
        padding: { left: 12, right: 12, top: 8, bottom: 8 },
      })
      .setInteractive({ useHandCursor: true });
    cancelBtn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
      this.closeConfirmTrainPurchaseModal();
    });

    const confirmBtn = this.add
      .text(0, 0, "Confirm", {
        color: "#ffffff",
        fontSize: "14px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        backgroundColor: "#3b5",
        padding: { left: 12, right: 12, top: 8, bottom: 8 },
      })
      .setInteractive({ useHandCursor: true });
    confirmBtn.on("pointerdown", async (pointer: Phaser.Input.Pointer) => {
      if (pointer.event) pointer.event.stopPropagation();
      this.closeConfirmTrainPurchaseModal();
      await this.handleTrainPurchase(args.kind, args.targetTrainType);
    });

    buttonsRow.add(cancelBtn, { proportion: 0, align: "center", expand: false });
    buttonsRow.add(confirmBtn, { proportion: 0, align: "center", expand: false });
    panelSizer.add(buttonsRow, { proportion: 0, align: "center", expand: false });

    modalRoot.add(panelSizer);
    panelSizer.layout();

    this.confirmTrainPurchaseModal = modalRoot;
  }

  private closeConfirmTrainPurchaseModal(): void {
    if (!this.confirmTrainPurchaseModal) return;
    this.confirmTrainPurchaseModal.destroy(true);
    this.confirmTrainPurchaseModal = null;
  }

  private createUI(options: { animate?: boolean } = {}) {
    const { animate = true } = options;
    if (this.rootSizer) {
      // Ensure we fully reset old layout (RexUI doesn't auto-heal after removals)
      this.destroyUI();
    }
    //overall rexUI.sizer which contains all the UI elements in the player hand scene
    this.rootSizer = (this as any).rexUI.add
      .sizer({
        width: this.scale.width,
        height: this.HAND_HEIGHT_BASE,
        orientation: "x",
        align: "center",
        // Keep root positioning simple and explicit; children are sizer-positioned.
        space: { left: 6, right: 6, top: 6, bottom: 6, item: 6 },
      })
      // Start position: off-screen if animating, otherwise go straight to final.
      .setPosition(this.scale.width / 2, this.scale.height)
      .setName(`root-sizer`);

    // Give the background an explicit size so it always fills the bar.
    this.rootSizer.addBackground(
      (this as any).rexUI.add.roundRectangle({
        width: this.scale.width,
        height: this.HAND_HEIGHT_BASE,
        color: 0x333333,
        alpha: 0.8,
      })
    );
    // Root horizontal layout: [cards region] [train] [player info] [controls]
    this.createDemandCardSection();
    this.createTrainSection();
    this.createPlayerInfoSection();
    this.createControlsSection();

    this.rootSizer.layout();
    // RexUI sizers are positioned by their center; anchor bottom flush.
    const rootHeight =
      (typeof this.rootSizer.height === "number" && this.rootSizer.height > 0)
        ? this.rootSizer.height
        : this.HAND_HEIGHT_BASE;
    const finalY = this.scale.height - rootHeight / 2;

    if (animate) {
      // Slide in animation - animate container up to visible position
      this.tweens.add({
        targets: this.rootSizer,
        y: finalY,
        duration: 300,
        ease: "Power2",
        onComplete: () => {
          this.refreshTrainCardLoadsAfterLayout();
        },
      });
    } else {
      this.rootSizer.setY(finalY);
      this.refreshTrainCardLoadsAfterLayout();
    }
  }

  private refreshTrainCardLoadsAfterLayout(): void {
    // When the hand is reopened, TrainCard containers may not have stable transforms
    // until after the slide-in/layout pass. Defer one tick to avoid NaN positions.
    this.time.delayedCall(0, () => {
      if (!this.trainCard || !this.rootSizer) return;
      this.trainCard.updateLoads();
      this.rootSizer.layout();
    });
  }

  private createDemandCardSection(): void {
    // Ensure marks are loaded before we instantiate cards.
    this.ensureDemandMarksLoaded();

    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const currentPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;

    if (!currentPlayer) {
      return;
    }

    // Clear existing cards
    this.cards.forEach((card) => {
      if (card) card.destroy();
    });
    this.cards = [];

    if (currentPlayer.hand.length === 0) {
      console.warn(`Player ${currentPlayer.name} has no cards in hand.`);
    }

    const maxCards = 3;
    const cardsToShow = Math.max(currentPlayer.hand.length, maxCards);

    // Prune marks for cards no longer in hand to avoid unbounded growth.
    const currentHandIds = new Set<number>();
    currentPlayer.hand.forEach((c: any) => {
      if (c && typeof c.id === "number") currentHandIds.add(c.id);
    });
    for (const existingId of this.demandCardMarkedLineByCardId.keys()) {
      if (!currentHandIds.has(existingId)) {
        this.demandCardMarkedLineByCardId.delete(existingId);
      }
    }
    // Persist pruning as well (so stale card ids don't accumulate across sessions).
    this.saveDemandMarksToStorage();

    // Cards region is its own sizer so rootSizer has stable child footprints.
    // (Do NOT add cards directly to rootSizer if you want them grouped.)
    this.cardsSizer = (this as any).rexUI.add
      .sizer({
        orientation: "x",
        space: { item: this.CARD_SPACING_HORIZONTAL },
      })
      .setName("demand-cards-sizer");

    for (let i = 0; i < cardsToShow; i++) {
      const card =
        i < currentPlayer.hand.length ? currentPlayer.hand[i] : undefined;
      const demandCard = new DemandCard(this, 0, 0, card, card
        ? {
          markedDemandIndex: this.demandCardMarkedLineByCardId.get(card.id) ?? null,
          onMarkedDemandIndexChange: (cardId, markedIndex) => {
            this.demandCardMarkedLineByCardId.set(cardId, markedIndex);
            this.saveDemandMarksToStorage();
          },
        }
        : undefined);
      this.cardsSizer.add(demandCard, {
        proportion: 0,
        align: "center",
        padding: 0,
        expand: false,
      });
      this.cards.push(demandCard);
    }

    // Keep cards as a natural-width block so train/info sit immediately after it.
    this.rootSizer.add(this.cardsSizer, {
      proportion: 0,
      align: "center",
      padding: { left: 8, right: 8 },
      expand: false,
    });
  }

  private createTrainSection(): void {
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const currentPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;

    if (!currentPlayer) {
      return;
    }

    if (!currentPlayer.trainType) {
      currentPlayer.trainType = "freight" as any;
    }

    try {
      // Clean up old train card
      if (this.trainCard) {
        this.trainCard.destroy();
        this.trainCard = null;
      }

      // Create train card directly in scene
      this.trainCard = new TrainCard(
        this,
        0,
        0,
        currentPlayer
      );

      // Train column: card only (Train Upgrade now lives in Actions modal)
      const trainColumn = (this as any).rexUI.add
        .sizer({
          orientation: "y",
          space: { item: 8 },
        })
        .setName("train-column-sizer");

      trainColumn.add(this.trainCard.getContainer(), {
        proportion: 0,
        align: "center",
        expand: false,
      });

      // Add the train column to the root sizer
      this.rootSizer.add(trainColumn, {
        proportion: 0,
        align: "center",
        padding: { left: 6, right: 6 },
        expand: false,
      });
    } catch (error) {
      console.error("Failed to create train card:", error);
    }
  }

  private createPlayerInfoSection(): void {
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const currentPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;

    if (!currentPlayer) {
      return;
    }

    // Player info must be a Sizer (not a ContainerLite) because we want vertical layout.
    this.infoSizer = (this as any).rexUI.add
      .sizer({
        orientation: "y",
        space: { item: 8 },
      })
      .setName("player-info-sizer");

    this.createCitySelectionSection(this.infoSizer);
    this.createNameAndMoneySection(this.infoSizer);
    this.createBuildCostSection(this.infoSizer);
    this.createMoreActionsSection(this.infoSizer);

    this.rootSizer.add(this.infoSizer, {
      proportion: 0,
      align: "center",
      padding: { left: 10, right: 10 },
      expand: false,
    });
  }

  private createMoreActionsSection(parentSizer: any): void {
    const isLocalPlayerActive = this.gameStateService?.isLocalPlayerActive?.() ?? false;

    const btn = this.add
      .text(0, 0, "More actions…", {
        color: "#ffffff",
        fontSize: "16px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        backgroundColor: "#444",
        padding: { left: 10, right: 10, top: 6, bottom: 6 },
      })
      .setAlpha(isLocalPlayerActive ? 1.0 : 0.5)
      .setInteractive({ useHandCursor: isLocalPlayerActive });

    if (isLocalPlayerActive) {
      btn.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        if (pointer.event) pointer.event.stopPropagation();
        this.openActionsModal();
      });
    }

    parentSizer.add(btn, {
      proportion: 0,
      align: "center",
      padding: 0,
      expand: false,
    });
  }

  private createCitySelectionSection(parentSizer: any): void {
    // Only create CitySelectionManager if player needs to select a city
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const currentPlayer = this.gameStateService.getCurrentPlayer();
    if (!currentPlayer) {
      return;
    }
    const shouldShowCitySelection =
      localPlayerId &&
      currentPlayer.id === localPlayerId &&
      !currentPlayer.trainState?.position;
    if (shouldShowCitySelection) {
      this.citySelectionManager = new CitySelectionManager(
        this,
        this.gameState,
        this.mapRenderer,
        (playerId, x, y, row, col) =>
          this.trainInteractionManager.initializePlayerTrain(
            playerId,
            x,
            y,
            row,
            col
          ),
        () => false // Always return false since we're in expanded view
      );

      // Only proceed if CitySelectionManager was properly created
      if (this.citySelectionManager) {
        this.citySelectionManager.init();
        // Give it a stable footprint so the infoSizer can measure it.
        (this.citySelectionManager as any).setMinSize?.(220, 32);
        (this.citySelectionManager as any).setSize?.(220, 32);

        parentSizer.add(this.citySelectionManager, {
          proportion: 0,
          align: "center",
          padding: 0,
          expand: false,
        });
      }
    }
  }

  private createNameAndMoneySection(parentSizer: any): void {
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const localPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;
    if (!localPlayer) {
      return;
    }

    const playerInfoText = `${localPlayer.name}\nMoney: ECU ${localPlayer.money}M`;
    const nameAndMoney = this.add
      .text(0, 0, playerInfoText, {
        color: "#ffffff",
        fontSize: "20px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        align: "center",
        wordWrap: { width: 280, useAdvancedWrap: true },
      })
      .setName(`name-and-money-text`);
    this.nameAndMoneyText = nameAndMoney;

    parentSizer.add(nameAndMoney, {
      proportion: 0,
      align: "center",
      padding: 0,
      expand: false,
    });
  }

  private createBuildCostSection(parentSizer: any): void {
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const localPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;
    if (!localPlayer) {
      return;
    }
    const display = this.getBuildCostDisplay(localPlayer);
    const buildCostText = this.add
      .text(0, 0, display.text, {
        color: display.color,
        fontSize: "20px",
        fontStyle: "bold",
        fontFamily: UI_FONT_FAMILY,
        align: "center",
        wordWrap: { width: 280, useAdvancedWrap: true },
      })
      .setName(`build-cost-text`);
    this.buildCostText = buildCostText;

    parentSizer.add(buildCostText, {
      proportion: 0,
      align: "center",
      padding: 0,
      expand: false,
    });
  }

  private createControlsSection(): void {
    if (this.gameStateService.getCurrentPlayer() === null) {
      return;
    }
    // Controls region: fill remaining horizontal space in rootSizer so we can
    // keep the crayon stack on the left while pinning the hide arrow to the
    // far top-right of the grey bar.
    const controlsRegionSizer = (this as any).rexUI.add
      .sizer({
        orientation: "x",
        space: { item: 0 },
      })
      .setName("controls-region-sizer");

    const crayonStackSizer = (this as any).rexUI.add
      .sizer({
        orientation: "y",
        space: { item: 10 },
      })
      .setName("crayon-stack-sizer");

    // Crayon color should always reflect the *local player*, not the current-turn player.
    const localPlayerId = this.gameStateService.getLocalPlayerId();
    const localPlayer = localPlayerId
      ? this.gameState.players.find((p) => p.id === localPlayerId)
      : null;
    const crayonColor =
      colorMap[(localPlayer?.color || "#000000").toUpperCase()] || "black";
    const crayonTexture = `crayon_${crayonColor}`;

    const isLocalPlayerActive =
      this.gameStateService?.isLocalPlayerActive() ?? false;
    const canEnterDrawingMode = !this.trackDrawingManager?.isDrawingDisabledForTurn?.();

    // Crayon button container (overlay highlight + icon)
    const crayonButtonContainer = (this as any).rexUI.add
      .container({ width: 60, height: 60 })
      .setName("crayon-button-container");
    crayonButtonContainer.setSize(60, 60);

    const crayonButton = this.add
      .image(0, 0, crayonTexture)
      .setScale(this.isDrawingMode ? 0.18 : 0.15)
      .setAlpha(isLocalPlayerActive ? 1.0 : 0.4)
      .setInteractive({ useHandCursor: isLocalPlayerActive && canEnterDrawingMode }).setName(`crayon-button`);
    this.crayonButtonImage = crayonButton;

    // Always create the highlight once; toggle visibility on state changes.
    const highlight = this.add.circle(0, 0, 30, 0xffff00, 0.3);
    highlight.setVisible(this.isDrawingMode);
    this.crayonHighlightCircle = highlight;
    crayonButtonContainer.addLocal(highlight);
    crayonButtonContainer.addLocal(crayonButton);

    if (isLocalPlayerActive && canEnterDrawingMode) {
      crayonButton
        .on("pointerover", () => {
          if (!this.isDrawingMode) {
            crayonButton.setScale(0.17);
          }
        })
        .on("pointerout", () => {
          if (!this.isDrawingMode) {
            crayonButton.setScale(0.15);
          }
        })
        .on("pointerdown", (pointer: Phaser.Input.Pointer) => {
          if (pointer.event) {
            pointer.event.stopPropagation();
          }
          this.toggleDrawingCallback();
        });
    } else {
      crayonButton.setInteractive({ useHandCursor: false });
    }

    // Undo button
    if (isLocalPlayerActive && this.canUndo()) {
      const undoButton = this.add
        .text(0, 0, "⟲ Undo", {
          color: "#ffffff",
          fontSize: "18px",
          fontStyle: "bold",
          fontFamily: UI_FONT_FAMILY,
          backgroundColor: "#444",
          padding: { left: 8, right: 8, top: 4, bottom: 4 },
        })
        .setInteractive({ useHandCursor: true }).setName(`undo-button`);
      undoButton.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        if (pointer.event) pointer.event.stopPropagation();
        this.onUndo();
      });
      crayonStackSizer.add(undoButton, {
        proportion: 0,
        align: "center",
        // Add a bit of space below the undo button so it doesn't crowd the crayon.
        padding: { bottom: 6 },
        expand: false,
      });
    }

    // Hide button (arrow) as a sized container so sizer can position it.
    const hideButtonContainer = (this as any).rexUI.add
      .container({ width: 40, height: 40 })
      .setName("hide-button-container");
    hideButtonContainer.setSize(40, 40);

    const toggleGraphics = this.add.graphics().setName(`hide-button-graphics`);
    const arrowSize = 15;
    const arrowColor = 0xffffff;
    toggleGraphics.lineStyle(3, arrowColor, 1);
    toggleGraphics.beginPath();
    // Draw centered arrow within the container's local space.
    toggleGraphics.moveTo(-arrowSize, -arrowSize / 2);
    toggleGraphics.lineTo(0, arrowSize / 2);
    toggleGraphics.lineTo(arrowSize, -arrowSize / 2);
    toggleGraphics.strokePath();

    const hitArea = this.add
      .rectangle(0, 0, 40, 40, 0x000000, 0)
      .setName(`hide-button-hit-area`);
    hitArea.setInteractive({ useHandCursor: true });
    hitArea.on("pointerdown", () => this.slideOutAndClose());

    hideButtonContainer.addLocal(toggleGraphics);
    hideButtonContainer.addLocal(hitArea);

    // Crayon should be lower with more separation from the arrow.
    crayonStackSizer.add(crayonButtonContainer, {
      proportion: 0,
      align: "center",
      padding: 0,
      expand: false,
    });

    // Flex spacer pushes arrow to the far right edge.
    const flexSpace = this.add.zone(0, 0, 1, 1).setName("controls-flex-space");

    controlsRegionSizer.add(crayonStackSizer, {
      proportion: 0,
      // Keep the crayon safely inside the bar (bottom alignment can push it off-screen)
      align: "center",
      padding: { left: 0, right: 0, bottom: 0 },
      expand: false,
    });
    controlsRegionSizer.add(flexSpace, {
      proportion: 1,
      align: "center",
      padding: 0,
      expand: true,
    });
    controlsRegionSizer.add(hideButtonContainer, {
      proportion: 0,
      align: "top",
      padding: { right: 0, top: 0 },
      expand: false,
    });

    // Add controls region as last child; let it consume remaining width.
    this.rootSizer.add(controlsRegionSizer, {
      proportion: 1,
      align: "center",
      padding: { left: 8, right: 4 },
      expand: true,
    });
  }

  private slideOutAndClose(): void {
    if (!this.rootSizer) return;

    // Slide down animation
    this.tweens.add({
      targets: this.rootSizer,
      y: this.scale.height,
      duration: 300,
      ease: "Power2",
      onComplete: () => {
        this.onCloseCallback();
        this.scene.stop();
      },
    });
  }

  private destroyUI(): void {
    // Close any open modals (they are not children of rootSizer)
    this.closeConfirmDiscardModal();
    this.closeConfirmRestartModal();
    this.closeConfirmTrainPurchaseModal();
    this.closeActionsModal();

    // Destroy train card
    if (this.trainCard) {
      try {
        this.trainCard.destroy();
      } catch (e) {
        console.warn("Error destroying trainCard:", e);
      }
      this.trainCard = null;
    }

    // Destroy cards
    this.cards.forEach((card) => {
      try {
        if (card && typeof card.destroy === "function") {
          card.destroy();
        }
      } catch (e) {
        console.warn("Error destroying card:", e);
      }
    });
    this.cards = [];

    // Destroy city selection manager (not in container, so must be destroyed separately)
    // Make sure it exists and is still in the scene before trying to destroy
    if (this.citySelectionManager) {
      try {
        // Remove from scene's display list first
        if (
          this.citySelectionManager.scene &&
          this.citySelectionManager.scene.children.exists(
            this.citySelectionManager
          )
        ) {
          this.citySelectionManager.scene.children.remove(
            this.citySelectionManager
          );
        }
        if (typeof this.citySelectionManager.destroy === "function") {
          this.citySelectionManager.destroy();
        }
      } catch (e) {
        console.warn("Error destroying citySelectionManager:", e);
      }
      this.citySelectionManager = null;
    }

    // Destroy background (in container, will be removed with container)
    if (this.background) {
      this.background = null; // Will be destroyed when container is destroyed
    }

    // Destroy root container and all its children
    if (this.rootSizer) {
      try {
        //remove and destroy all children
        this.rootSizer.clear(true);
        this.rootSizer.destroy();
      } catch (e) {
        console.warn("Error destroying rootContainer:", e);
      }
      this.rootSizer = null;
    }
  }

  shutdown() {
    this.destroyUI();
  }

  private computeDemandMarksStorageKey(): string | null {
    try {
      // Keyed by game + local player so marks persist across refresh and don't leak between games/players.
      const gameId = this.gameState?.id;
      const localPlayerId = this.gameStateService?.getLocalPlayerId?.();
      if (!gameId || !localPlayerId) return null;
      return `eurorails.demandMarks.v1.${gameId}.${localPlayerId}`;
    } catch {
      return null;
    }
  }

  private ensureDemandMarksLoaded(): void {
    const key = this.computeDemandMarksStorageKey();
    if (!key) return;
    if (this.demandMarksStorageKey === key) return;
    this.demandMarksStorageKey = key;
    this.loadDemandMarksFromStorage();
  }

  private loadDemandMarksFromStorage(): void {
    try {
      if (!this.demandMarksStorageKey) return;
      if (typeof window === "undefined" || !window.localStorage) return;
      const raw = window.localStorage.getItem(this.demandMarksStorageKey);
      if (!raw) {
        this.demandCardMarkedLineByCardId = new Map();
        return;
      }
      const parsed = JSON.parse(raw);
      const marksObj: Record<string, unknown> =
        parsed && typeof parsed === "object" && (parsed as any).marks && typeof (parsed as any).marks === "object"
          ? (parsed as any).marks
          : {};
      const next = new Map<number, number | null>();
      for (const [cardIdStr, idx] of Object.entries(marksObj)) {
        const cardId = Number(cardIdStr);
        if (!Number.isFinite(cardId)) continue;
        if (idx === null) {
          next.set(cardId, null);
          continue;
        }
        if (typeof idx === "number" && Number.isInteger(idx) && idx >= 0 && idx <= 2) {
          next.set(cardId, idx);
        }
      }
      this.demandCardMarkedLineByCardId = next;
    } catch {
      // Non-critical. If localStorage is unavailable/corrupt, just behave like ephemeral marks.
      this.demandCardMarkedLineByCardId = new Map();
    }
  }

  private saveDemandMarksToStorage(): void {
    try {
      if (!this.demandMarksStorageKey) return;
      if (typeof window === "undefined" || !window.localStorage) return;
      const marks: Record<string, number | null> = {};
      for (const [cardId, idx] of this.demandCardMarkedLineByCardId.entries()) {
        marks[String(cardId)] = idx ?? null;
      }
      window.localStorage.setItem(
        this.demandMarksStorageKey,
        JSON.stringify({
          version: 1,
          updatedAt: Date.now(),
          marks,
        })
      );
    } catch {
      // Non-critical: localStorage might be blocked; ignore.
    }
  }
}
