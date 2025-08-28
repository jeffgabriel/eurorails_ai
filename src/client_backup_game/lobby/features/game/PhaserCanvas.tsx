// features/game/PhaserCanvas.tsx
import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import { GameScene } from '../../phaser/scene';
import type { GameState } from '../../shared/types';

interface PhaserCanvasProps {
  gameState: GameState;
}

export function PhaserCanvas({ gameState }: PhaserCanvasProps) {
  const gameRef = useRef<Phaser.Game | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create Phaser game instance
    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      width: '100%',
      height: '100%',
      parent: containerRef.current,
      backgroundColor: '#0b0e14',
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      scene: GameScene,
    };

    gameRef.current = new Phaser.Game(config);

    // Cleanup on unmount
    return () => {
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    // Update game scene with new state
    if (gameRef.current && gameState) {
      const scene = gameRef.current.scene.getScene('GameScene') as GameScene;
      if (scene && scene.updateGameState) {
        scene.updateGameState(gameState);
      }
    }
  }, [gameState]);

  return (
    <div 
      ref={containerRef} 
      className="size-full"
      style={{ 
        minHeight: '400px',
        background: 'var(--clr-bg)' 
      }}
    />
  );
}