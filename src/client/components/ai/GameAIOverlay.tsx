/**
 * GameAIOverlay
 *
 * Container component that renders AI-related overlays during gameplay.
 * Connects AIThinkingIndicator and BotStrategyPanel to the AI store.
 */

import React, { useEffect } from 'react';
import { AIThinkingIndicator } from './AIThinkingIndicator';
import { BotStrategyPanel } from './BotStrategyPanel';
import {
  useAIStore,
  useIsAIThinking,
  useThinkingPlayerId,
  useSelectedAIPlayerId,
  useIsBotPanelVisible,
} from '../../lobby/store/ai.store';
import { useGameStore } from '../../lobby/store/game.store';
import type { Player } from '../../lobby/shared/types';

export interface GameAIOverlayProps {
  /** Optional override for visibility (used in tests) */
  forceVisible?: boolean;
}

/**
 * Gets the AI player info from the game state
 */
function getAIPlayer(players: Player[], playerId: string | null): Player | null {
  if (!playerId) return null;
  return players.find((p) => p.id === playerId && p.isAI) ?? null;
}

export function GameAIOverlay({ forceVisible }: GameAIOverlayProps): React.ReactElement {
  const gameState = useGameStore((state) => state.gameState);
  const isAIThinking = useIsAIThinking();
  const thinkingPlayerId = useThinkingPlayerId();
  const selectedAIPlayerId = useSelectedAIPlayerId();
  const isBotPanelVisible = useIsBotPanelVisible();

  const aiTurnSummary = useAIStore((state) =>
    selectedAIPlayerId ? state.aiTurnSummaries.get(selectedAIPlayerId) : undefined
  );
  const aiStrategy = useAIStore((state) =>
    selectedAIPlayerId ? state.aiStrategies.get(selectedAIPlayerId) : undefined
  );
  const aiDebugInfo = useAIStore((state) =>
    selectedAIPlayerId ? state.aiDebugInfo.get(selectedAIPlayerId) : undefined
  );

  const { initializeSocketListeners, removeSocketListeners, toggleBotPanel } = useAIStore();

  // Initialize socket listeners when the component mounts
  useEffect(() => {
    initializeSocketListeners();
    return () => {
      removeSocketListeners();
    };
  }, [initializeSocketListeners, removeSocketListeners]);

  // Get the thinking AI player info
  const thinkingPlayer = getAIPlayer(gameState?.players ?? [], thinkingPlayerId);
  const selectedPlayer = getAIPlayer(gameState?.players ?? [], selectedAIPlayerId);

  // Determine AI player name for thinking indicator
  const aiPlayerName = thinkingPlayer?.name ?? 'AI';

  // Handle closing the bot panel
  const handleClosePanel = () => {
    toggleBotPanel(false);
  };

  return (
    <>
      {/* AI Thinking Indicator */}
      <AIThinkingIndicator
        isVisible={forceVisible ?? isAIThinking}
        aiPlayerName={aiPlayerName}
      />

      {/* Bot Strategy Panel */}
      {selectedPlayer && (
        <BotStrategyPanel
          playerId={selectedPlayer.id}
          playerName={selectedPlayer.name}
          difficulty={selectedPlayer.aiDifficulty ?? 'medium'}
          personality={selectedPlayer.aiPersonality ?? 'optimizer'}
          turnSummary={aiTurnSummary ?? null}
          currentStrategy={aiStrategy ?? null}
          debugInfo={aiDebugInfo}
          isVisible={forceVisible ?? isBotPanelVisible}
          onClose={handleClosePanel}
        />
      )}
    </>
  );
}

export default GameAIOverlay;
