// phaser/scene.ts
import Phaser from 'phaser';
import type { GameState } from '../shared/types';

export class GameScene extends Phaser.Scene {
  private gameState: GameState | null = null;
  private trackGraphics: Phaser.GameObjects.Graphics[] = [];
  private mapBackground: Phaser.GameObjects.Rectangle | null = null;

  constructor() {
    super({ key: 'GameScene' });
  }

  create() {
    // Create map background
    this.mapBackground = this.add.rectangle(
      0, 
      0, 
      this.scale.width, 
      this.scale.height, 
      0x121826
    );
    this.mapBackground.setOrigin(0, 0);

    // Add grid for reference
    this.createGrid();

    // Add title text
    this.add.text(50, 50, 'EuroRails Game Board', {
      fontSize: '24px',
      color: '#e5e7eb'
    });

    // Add placeholder instructions
    this.add.text(50, 100, 'Railway tracks will appear here as players build them.', {
      fontSize: '16px',
      color: '#9ca3af'
    });

    this.add.text(50, 130, 'Click and drag to move around the map.', {
      fontSize: '14px',
      color: '#9ca3af'
    });

    // Enable camera controls
    this.setupCameraControls();
  }

  private createGrid() {
    const gridSize = 50;
    const gridGraphics = this.add.graphics();
    gridGraphics.lineStyle(1, 0x333333, 0.3);

    // Vertical lines
    for (let x = 0; x < this.scale.width; x += gridSize) {
      gridGraphics.moveTo(x, 0);
      gridGraphics.lineTo(x, this.scale.height);
    }

    // Horizontal lines
    for (let y = 0; y < this.scale.height; y += gridSize) {
      gridGraphics.moveTo(0, y);
      gridGraphics.lineTo(this.scale.width, y);
    }

    gridGraphics.strokePath();
  }

  private setupCameraControls() {
    // Add camera drag functionality
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let cameraStartX = 0;
    let cameraStartY = 0;

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      isDragging = true;
      dragStartX = pointer.x;
      dragStartY = pointer.y;
      cameraStartX = this.cameras.main.scrollX;
      cameraStartY = this.cameras.main.scrollY;
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (isDragging) {
        const deltaX = pointer.x - dragStartX;
        const deltaY = pointer.y - dragStartY;
        
        this.cameras.main.setScroll(
          cameraStartX - deltaX,
          cameraStartY - deltaY
        );
      }
    });

    this.input.on('pointerup', () => {
      isDragging = false;
    });

    // Add zoom functionality
    this.input.on('wheel', (pointer: any, gameObjects: any, deltaX: number, deltaY: number) => {
      const camera = this.cameras.main;
      const zoomFactor = deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Phaser.Math.Clamp(camera.zoom * zoomFactor, 0.2, 3);
      
      camera.setZoom(newZoom);
    });
  }

  updateGameState(gameState: GameState) {
    this.gameState = gameState;
    this.renderTracks();
  }

  private renderTracks() {
    if (!this.gameState) return;

    // Clear existing track graphics
    this.trackGraphics.forEach(graphic => graphic.destroy());
    this.trackGraphics = [];

    // Render each player's tracks
    this.gameState.tracks.forEach(track => {
      if (track.segments.length === 0) return;

      const graphics = this.add.graphics();
      
      // Find player color
      const player = this.gameState?.players.find(p => p.userId === track.ownerUserId);
      const color = player ? this.hexToNumber(player.color) : 0x3b82f6;
      
      graphics.lineStyle(4, color, 1);
      
      // Draw track segments as connected lines
      if (track.segments.length > 1) {
        graphics.beginPath();
        graphics.moveTo(track.segments[0].x, track.segments[0].y);
        
        for (let i = 1; i < track.segments.length; i++) {
          graphics.lineTo(track.segments[i].x, track.segments[i].y);
        }
        
        graphics.strokePath();
      }

      // Add dots at each segment point
      track.segments.forEach(segment => {
        graphics.fillStyle(color, 1);
        graphics.fillCircle(segment.x, segment.y, 3);
      });

      this.trackGraphics.push(graphics);
    });
  }

  private hexToNumber(hex: string): number {
    // Convert hex color string to Phaser color number
    return parseInt(hex.replace('#', ''), 16);
  }

  resize(width: number, height: number) {
    // Handle resize events
    if (this.mapBackground) {
      this.mapBackground.setSize(width, height);
    }
  }
}