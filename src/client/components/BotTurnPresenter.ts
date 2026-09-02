import "phaser";
import type { TimelineStep, GridPoint } from "../../shared/types/GameTypes";
import type { GameToastManager } from "./GameToastManager";
import type { BotTrainAnimator } from "./BotTrainAnimator";
import type { WhisperPanel, WhisperTurnEntry } from "./WhisperPanel";
import type { LLMTranscriptOverlay } from "./LLMTranscriptOverlay";

/**
 * Payload delivered on the `bot:turn-complete` socket event. Most fields are
 * optional because a given bot turn may not have built track, delivered a
 * load, etc. — the presenter only reacts to whichever are present.
 */
export interface BotTurnCompletePayload {
  botPlayerId?: string;
  turnNumber?: number;
  action?: string;
  reasoning?: string;
  cost?: number;
  segmentsBuilt?: number;
  buildTargetCity?: string;
  actionTimeline?: TimelineStep[];
  movementPath?: { row: number; col: number }[];
  movementData?: { mileposts?: number };
  loadsPickedUp?: Array<{ loadType: string; city: string }>;
  loadsDelivered?: Array<{ loadType: string; city: string; payment: number }>;
  compositionTrace?: object;
  demandRanking?: object[];
  /** Additional fields (systemPrompt, userPrompt, llmLog, model, ...) consumed by llmTranscriptOverlay only. */
  [key: string]: unknown;
}

/** Resolved display info for the bot whose turn just completed. */
export interface BotDisplay {
  name: string;
  color: number;
}

/**
 * Dependencies injected by GameScene. BotTurnPresenter renders nothing itself —
 * it orchestrates these already-constructed UI components — so it holds no
 * global reach-in beyond what's passed here (no direct socketService/store access).
 */
export interface BotTurnPresenterDeps {
  gameToastManager?: GameToastManager;
  botTrainAnimator?: BotTrainAnimator;
  whisperPanel?: WhisperPanel;
  llmTranscriptOverlay?: LLMTranscriptOverlay;
  getMapGridPoints: () => GridPoint[][];
  getTrainSprite: (playerId: string) => Phaser.GameObjects.Image | undefined;
  updateTrainPosition: (
    playerId: string,
    x: number,
    y: number,
    row: number,
    col: number,
    opts?: { persist?: boolean }
  ) => void;
  /** Look up display info (name/color) for a bot player by id. */
  resolveBotDisplay: (botPlayerId: string) => BotDisplay;
}

const LLM_FAILURE_PATTERN = /^\[(heuristic[ -]fallback|llm-failed|no-api-key)\]/i;
const PROMPT_TAG_PATTERN = /\[[\w\s=\/\-]+\]\s*/g;

/**
 * Single dispatch point for `bot:turn-complete` payloads: fans out to toasts,
 * train animation, the whisper (advice) panel, and the LLM transcript overlay.
 * Extracted from GameScene.handleBotTurnComplete/showBotTurnToasts/animateBotTurn
 * so this presentation logic can be tested without a live Phaser scene.
 */
export class BotTurnPresenter {
  constructor(private readonly deps: BotTurnPresenterDeps) {}

  /** Present a bot's completed turn: toasts, animation, and a whisper entry. */
  present(data: BotTurnCompletePayload): void {
    this.deps.llmTranscriptOverlay?.ingestBotTurnComplete(data);
    if (!data?.botPlayerId) return;

    const { name: botName, color: botColor } = this.deps.resolveBotDisplay(data.botPlayerId);

    this.showToasts(data, botName, botColor);
    this.animate(data, botName, botColor);
    this.recordWhisperEntry(data, botName);
  }

  private showToasts(data: BotTurnCompletePayload, botName: string, botColor: number): void {
    const toast = this.deps.gameToastManager;
    if (!toast) return;

    // LLM strategy announcement — always fires (not timeline-driven)
    if (data.reasoning) {
      const isLlmFailure = LLM_FAILURE_PATTERN.test(data.reasoning);
      const cleanReasoning = data.reasoning.replace(PROMPT_TAG_PATTERN, '');
      if (isLlmFailure) {
        toast.show(`😵 ${botName} LLM failed — ${cleanReasoning}`, { color: 0x8b0000, shake: true });
      } else {
        toast.show(`${botName}: ${cleanReasoning}`, { color: botColor, duration: 10000 });
      }
    }

    // When actionTimeline is present, action toasts are fired mid-animation
    // by the animateTimeline onAction callback — skip them here
    if (data.actionTimeline && data.actionTimeline.length > 0) return;

    // Deduplicate by {loadType, city} to prevent toast spam from duplicate delivery entries
    if (data.loadsDelivered && data.loadsDelivered.length > 0) {
      const seenDeliveries = new Set<string>();
      for (const d of data.loadsDelivered) {
        const key = `${d.loadType}:${d.city}`;
        if (seenDeliveries.has(key)) continue;
        seenDeliveries.add(key);
        toast.show(
          `💰 ${botName} delivered ${d.loadType} to ${d.city} — earned ${d.payment}M ECU!`,
          { color: botColor, flourish: true },
        );
      }
    }

    if (data.segmentsBuilt && data.segmentsBuilt > 0 && data.buildTargetCity) {
      toast.show(
        `${botName} built ${data.segmentsBuilt} track segment${data.segmentsBuilt > 1 ? 's' : ''} toward ${data.buildTargetCity} (${data.cost}M)`,
        { color: botColor },
      );
    }

    if (data.action === 'UpgradeTrain') {
      toast.show(`${botName} upgraded their train`, { color: botColor });
    }

    if (data.action === 'DiscardHand') {
      toast.show(`😢 ${botName} discarded their hand`, { color: botColor, shake: true });
    }

    if (data.loadsPickedUp && data.loadsPickedUp.length > 0) {
      const loads = data.loadsPickedUp.map((p) => `${p.loadType} at ${p.city}`).join(', ');
      toast.show(`${botName} picked up ${loads}`, { color: botColor });
    }
  }

  /** JIRA-36: animate a bot's movement from its turn-complete payload. */
  private animate(data: BotTurnCompletePayload, botName: string, botColor: number): void {
    const animator = this.deps.botTrainAnimator;
    const botPlayerId = data.botPlayerId;
    if (!animator || !botPlayerId) return;

    // Cancel any existing animation for this bot (rapid turns)
    if (animator.isAnimating(botPlayerId)) {
      animator.cancelAnimation(botPlayerId);
    }

    const toast = this.deps.gameToastManager;
    const gridPoints = this.deps.getMapGridPoints();

    // Prefer structured timeline over flat path
    if (data.actionTimeline && data.actionTimeline.length > 0) {
      this.animateTimeline(botPlayerId, data.actionTimeline, gridPoints, toast, botName, botColor);
      return;
    }

    this.animateFlatPath(botPlayerId, data.movementPath, gridPoints);
  }

  private animateTimeline(
    botPlayerId: string,
    actionTimeline: TimelineStep[],
    gridPoints: GridPoint[][],
    toast: GameToastManager | undefined,
    botName: string,
    botColor: number,
  ): void {
    const animator = this.deps.botTrainAnimator;
    if (!animator) return;

    // Snap sprite to start of first move segment
    const firstMove = actionTimeline.find((s) => s.type === 'move');
    if (firstMove?.type === 'move' && firstMove.path?.[0]) {
      const startGrid = gridPoints[firstMove.path[0].row]?.[firstMove.path[0].col];
      if (startGrid) {
        const sprite = this.deps.getTrainSprite(botPlayerId);
        if (sprite) sprite.setPosition(startGrid.x, startGrid.y);
      }
    }

    animator.animateTimeline(
      botPlayerId,
      actionTimeline,
      gridPoints,
      () => this.deps.getTrainSprite(botPlayerId),
      (step) => {
        if (!toast) return;
        switch (step.type) {
          case 'deliver':
            toast.show(
              `💰 ${botName} delivered ${step.loadType} to ${step.city} — earned ${step.payment}M ECU!`,
              { color: botColor, flourish: true },
            );
            break;
          case 'pickup':
            toast.show(`${botName} picked up ${step.loadType} at ${step.city}`, { color: botColor });
            break;
          case 'build':
            toast.show(
              `${botName} built ${step.segmentsBuilt} track segment${step.segmentsBuilt > 1 ? 's' : ''} (${step.cost}M)`,
              { color: botColor },
            );
            break;
          case 'upgrade':
            toast.show(`${botName} upgraded their train`, { color: botColor });
            break;
          case 'discard':
            toast.show(`😢 ${botName} discarded their hand`, { color: botColor, shake: true });
            break;
        }
      },
    ).then((finalPos) => {
      if (finalPos) {
        this.deps.updateTrainPosition(botPlayerId, finalPos.x, finalPos.y, finalPos.row, finalPos.col, { persist: false });
      }
    }).catch(() => {});
  }

  /** Fallback: flat movementPath animation (backward compat, no per-step timeline). */
  private animateFlatPath(
    botPlayerId: string,
    movementPath: { row: number; col: number }[] | undefined,
    gridPoints: GridPoint[][],
  ): void {
    const animator = this.deps.botTrainAnimator;
    if (!animator || !movementPath || movementPath.length < 2) return;

    const startPos = movementPath[0];
    const startGrid = gridPoints[startPos.row]?.[startPos.col];
    if (startGrid) {
      const sprite = this.deps.getTrainSprite(botPlayerId);
      if (sprite) {
        sprite.setPosition(startGrid.x, startGrid.y);
      }
    }

    animator.animateAlongPath(
      botPlayerId,
      movementPath,
      gridPoints,
      () => this.deps.getTrainSprite(botPlayerId),
    ).then((finalPos) => {
      if (finalPos) {
        this.deps.updateTrainPosition(botPlayerId, finalPos.x, finalPos.y, finalPos.row, finalPos.col, { persist: false });
      }
    }).catch(() => {});
  }

  private recordWhisperEntry(data: BotTurnCompletePayload, botName: string): void {
    const whisperPanel = this.deps.whisperPanel;
    if (!whisperPanel || !data.botPlayerId) return;

    const entry: WhisperTurnEntry = {
      turnNumber: data.turnNumber ?? 0,
      botPlayerId: data.botPlayerId,
      botName,
      action: data.action ?? 'Unknown',
      reasoning: data.reasoning ?? '',
      cost: data.cost ?? 0,
      segmentsBuilt: data.segmentsBuilt ?? 0,
      loadsPickedUp: data.loadsPickedUp,
      loadsDelivered: data.loadsDelivered,
      milepostsMoved: data.movementData?.mileposts,
      compositionTrace: data.compositionTrace,
      demandRanking: data.demandRanking,
    };
    whisperPanel.addBotTurn(entry);
  }
}
