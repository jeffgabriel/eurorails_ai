/**
 * BotStrategyPanel
 *
 * Displays AI turn summaries, current strategy, and a collapsible debug info section.
 * Shows personality-driven commentary to provide engaging insights into AI decisions.
 */

import React, { useState } from 'react';
import type { TurnSummary, AIStrategy, AIDebugInfo } from '../../../shared/types/AITypes';
import type { AIDifficulty, AIPersonality } from '../../../shared/types/GameTypes';
import {
  getPersonalityDisplayName,
  getDifficultyDisplayName,
} from '../../../shared/types/AITypes';

export interface BotStrategyPanelProps {
  /** ID of the AI player */
  playerId: string;
  /** Display name of the AI player */
  playerName: string;
  /** AI difficulty level */
  difficulty: AIDifficulty;
  /** AI personality type */
  personality: AIPersonality;
  /** Summary of the AI's last turn */
  turnSummary: TurnSummary | null;
  /** Current AI strategy information */
  currentStrategy: AIStrategy | null;
  /** Optional debug information */
  debugInfo?: AIDebugInfo;
  /** Whether the panel should be visible */
  isVisible: boolean;
  /** Callback to close the panel */
  onClose?: () => void;
}

export function BotStrategyPanel({
  playerName,
  difficulty,
  personality,
  turnSummary,
  currentStrategy,
  debugInfo,
  isVisible,
  onClose,
}: BotStrategyPanelProps): React.ReactElement | null {
  const [isDebugExpanded, setIsDebugExpanded] = useState(false);

  if (!isVisible) {
    return null;
  }

  const difficultyDisplay = getDifficultyDisplayName(difficulty);
  const personalityDisplay = getPersonalityDisplayName(personality);

  return (
    <div
      className="fixed top-4 right-4 z-40 w-80 bg-slate-900/95 border border-slate-700 rounded-lg shadow-2xl"
      role="region"
      aria-label={`Strategy panel for ${playerName}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <span className="text-xl" role="img" aria-hidden="true">
            🤖
          </span>
          <div>
            <h2 className="text-sm font-semibold text-white">{playerName}</h2>
            <p className="text-xs text-slate-400">
              {difficultyDisplay} {personalityDisplay}
            </p>
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors p-1"
            aria-label="Close panel"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Turn Summary Section */}
      {turnSummary && (
        <div className="px-4 py-3 border-b border-slate-700">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
            Turn Summary
          </h3>
          <ul className="space-y-1">
            {turnSummary.actions.map((action, index) => (
              <li key={index} className="text-sm text-slate-300 flex items-start gap-2">
                <span className="text-slate-500">•</span>
                <span>{action.description}</span>
              </li>
            ))}
          </ul>
          {turnSummary.cashChange !== 0 && (
            <p
              className={`text-sm mt-2 ${turnSummary.cashChange > 0 ? 'text-green-400' : 'text-red-400'}`}
            >
              {turnSummary.cashChange > 0 ? '+' : ''}
              {turnSummary.cashChange}M ECU
            </p>
          )}
          {turnSummary.commentary && (
            <p className="text-sm text-slate-400 italic mt-2 border-l-2 border-slate-600 pl-2">
              "{turnSummary.commentary}"
            </p>
          )}
        </div>
      )}

      {/* Current Strategy Section */}
      {currentStrategy && (
        <div className="px-4 py-3 border-b border-slate-700">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
            Current Strategy: {currentStrategy.phase}
          </h3>

          <div className="space-y-2">
            <div>
              <p className="text-xs text-slate-500">Current Goal</p>
              <p className="text-sm text-white">{currentStrategy.currentGoal}</p>
            </div>

            <div>
              <p className="text-xs text-slate-500">Next Goal</p>
              <p className="text-sm text-slate-300">{currentStrategy.nextGoal}</p>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-400">Progress:</span>
              <span className="text-white">{currentStrategy.majorCityProgress}</span>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-400">Cash to Win:</span>
              <span className="text-amber-400">{currentStrategy.cashToWin}M</span>
            </div>
          </div>
        </div>
      )}

      {/* Debug Info Section (Collapsible) */}
      {debugInfo && (
        <div className="px-4 py-3">
          <button
            onClick={() => setIsDebugExpanded(!isDebugExpanded)}
            className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-300 transition-colors w-full"
            aria-expanded={isDebugExpanded}
            aria-controls="debug-info-content"
          >
            <svg
              className={`w-3 h-3 transition-transform ${isDebugExpanded ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
            <span>Debug Info</span>
          </button>

          {isDebugExpanded && (
            <div
              id="debug-info-content"
              className="mt-2 pl-5 space-y-1 text-xs text-slate-500"
            >
              <p>Routes evaluated: {debugInfo.routesEvaluated}</p>
              <p>Selected route score: {debugInfo.selectedRouteScore.toFixed(2)}</p>
              <p>Decision time: {debugInfo.decisionTimeMs}ms</p>
              {debugInfo.variablesConsidered.length > 0 && (
                <div>
                  <p>Variables considered:</p>
                  <ul className="ml-2">
                    {debugInfo.variablesConsidered.map((variable, index) => (
                      <li key={index}>• {variable}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Empty state when no data yet */}
      {!turnSummary && !currentStrategy && (
        <div className="px-4 py-6 text-center text-slate-500 text-sm">
          Waiting for AI turn data...
        </div>
      )}
    </div>
  );
}

export default BotStrategyPanel;
