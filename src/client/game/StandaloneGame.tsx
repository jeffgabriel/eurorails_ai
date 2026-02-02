// game/StandaloneGame.tsx - React wrapper for the standalone game
import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { GameAIOverlay } from '../components/ai';
import { useAIStore } from '../lobby/store/ai.store';

export function StandaloneGame() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<any>(null);
  const { id: gameId } = useParams<{ id: string }>();
  const clearAIState = useAIStore((state) => state.clearAIState);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create the game container div if it doesn't exist
    let gameContainer = document.getElementById('game-container');
    if (!gameContainer) {
      gameContainer = document.createElement('div');
      gameContainer.id = 'game-container';
      gameContainer.style.width = '100%';
      gameContainer.style.height = '100%';
      containerRef.current.appendChild(gameContainer);
    }

    // Dynamically import and initialize the game
    import('./index').then((gameModule) => {
      // Store reference to the game instance for cleanup
      gameRef.current = gameModule.game;
    }).catch(error => {
      console.error('Failed to initialize game:', error);
      // Show error message to user
      if (containerRef.current) {
        containerRef.current.innerHTML = `
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: white; text-align: center;">
            <h2>Failed to load game</h2>
            <p>Error: ${error.message}</p>
            <p>Game ID: ${gameId}</p>
            <button onclick="window.location.href='/lobby'" style="padding: 10px 20px; margin-top: 20px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;">
              Back to Lobby
            </button>
          </div>
        `;
      }
    });

    // Cleanup on unmount
    return () => {
      // Clear AI state when leaving the game
      clearAIState();

      // Destroy the Phaser game instance to prevent memory leaks
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
      }

      // Remove the game container
      const gameContainer = document.getElementById('game-container');
      if (gameContainer && containerRef.current) {
        containerRef.current.removeChild(gameContainer);
      }
    };
  }, [gameId, clearAIState]);

  return (
    <div
      ref={containerRef}
      className="size-full"
      style={{
        minHeight: '100vh',
        background: '#0b0e14',
        position: 'relative'
      }}
    >
      {/* AI Overlay components rendered on top of the Phaser game */}
      <GameAIOverlay />
    </div>
  );
}
