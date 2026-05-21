// mapViewer/MapViewer.tsx - React wrapper for the map viewer
import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';

export function MapViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<any>(null);
  const { id: gameId } = useParams<{ id: string }>();

  useEffect(() => {
    if (!containerRef.current) return;

    // Create the game container div
    let gameContainer = document.getElementById('map-viewer-container');
    if (!gameContainer) {
      gameContainer = document.createElement('div');
      gameContainer.id = 'map-viewer-container';
      gameContainer.style.width = '100%';
      gameContainer.style.height = '100%';
      containerRef.current.appendChild(gameContainer);
    }

    // Dynamically import and initialize the map viewer
    import('./index').then((module) => {
      gameRef.current = module.game;
    }).catch(error => {
      console.error('Failed to initialize map viewer:', error);
      if (containerRef.current) {
        containerRef.current.innerHTML = `
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: white; text-align: center;">
            <h2>Failed to load map viewer</h2>
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
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
      }

      const container = document.getElementById('map-viewer-container');
      if (container && containerRef.current) {
        containerRef.current.removeChild(container);
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
        position: 'relative',
      }}
    />
  );
}
