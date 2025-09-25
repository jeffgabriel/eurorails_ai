// game/StandaloneGame.tsx - React wrapper for the standalone game
import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';

export function StandaloneGame() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { id: gameId } = useParams<{ id: string }>();

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
    import('./index').then(() => {
      console.log('Standalone game initialized with ID:', gameId);
    }).catch(error => {
      console.error('Failed to initialize game:', error);
    });

    // Cleanup on unmount
    return () => {
      // Remove the game container
      const gameContainer = document.getElementById('game-container');
      if (gameContainer && containerRef.current) {
        containerRef.current.removeChild(gameContainer);
      }
    };
  }, [gameId]);

  return (
    <div 
      ref={containerRef} 
      className="size-full"
      style={{ 
        minHeight: '100vh',
        background: '#0b0e14',
        position: 'relative'
      }}
    />
  );
}
