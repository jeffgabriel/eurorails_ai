/**
 * AIThinkingIndicator
 *
 * A semi-transparent overlay displayed during AI turns to indicate
 * that the AI is processing its move. Includes accessibility support
 * via aria-live for screen reader announcements.
 */

import React from 'react';

export interface AIThinkingIndicatorProps {
  /** Whether the indicator should be visible */
  isVisible: boolean;
  /** Name of the AI player currently thinking */
  aiPlayerName: string;
}

export function AIThinkingIndicator({
  isVisible,
  aiPlayerName,
}: AIThinkingIndicatorProps): React.ReactElement | null {
  if (!isVisible) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
      role="status"
      aria-live="polite"
      aria-label={`${aiPlayerName} is thinking`}
    >
      {/* Semi-transparent backdrop */}
      <div className="absolute inset-0 bg-black/30" />

      {/* Thinking indicator card */}
      <div className="relative bg-slate-900/95 border border-slate-700 rounded-lg px-8 py-6 shadow-2xl">
        <div className="flex items-center gap-4">
          {/* Bot icon */}
          <div className="text-4xl">
            <span role="img" aria-hidden="true">
              🤖
            </span>
          </div>

          <div className="flex flex-col gap-2">
            {/* Player name */}
            <span className="text-lg font-semibold text-white">{aiPlayerName}</span>

            {/* Thinking message with animated dots */}
            <div className="flex items-center gap-2 text-slate-300">
              <span>is thinking</span>
              <span className="inline-flex">
                <span className="animate-pulse" style={{ animationDelay: '0ms' }}>
                  .
                </span>
                <span className="animate-pulse" style={{ animationDelay: '200ms' }}>
                  .
                </span>
                <span className="animate-pulse" style={{ animationDelay: '400ms' }}>
                  .
                </span>
              </span>
            </div>
          </div>

          {/* Spinning indicator */}
          <div className="ml-4">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default AIThinkingIndicator;
