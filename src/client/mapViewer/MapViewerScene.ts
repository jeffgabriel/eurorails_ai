import 'phaser';
import { GameState } from '../../shared/types/GameTypes';
import { PlayerTrackState } from '../../shared/types/TrackTypes';
import { MapRenderer } from '../components/MapRenderer';
import { CameraController } from '../components/CameraController';
import { config } from '../config/apiConfig';
import { UI_FONT_FAMILY } from '../config/uiFont';

interface MapPlayer {
  id: string;
  name: string;
  color: string;
}

interface MapDataResponse {
  players: MapPlayer[];
  status: string;
}

export class MapViewerScene extends Phaser.Scene {
  private gameId: string = '';
  private mapContainer!: Phaser.GameObjects.Container;
  private mapRenderer!: MapRenderer;
  private cameraController!: CameraController;

  constructor() {
    super({ key: 'MapViewerScene' });
  }

  init(data: { gameId: string }): void {
    this.gameId = data.gameId;
  }

  async create(): Promise<void> {
    let mapData: MapDataResponse;
    let tracks: PlayerTrackState[];

    try {
      const [mapResponse, tracksResponse] = await Promise.all([
        fetch(`${config.apiBaseUrl}/api/game/${this.gameId}/map-data`),
        fetch(`${config.apiBaseUrl}/api/tracks/${this.gameId}`),
      ]);

      if (!mapResponse.ok) {
        const errorBody = await mapResponse.json().catch(() => ({}));
        const message = errorBody.details || `Failed to load map data (${mapResponse.status})`;
        this.showError(message);
        return;
      }

      if (!tracksResponse.ok) {
        this.showError('Failed to load track data');
        return;
      }

      mapData = await mapResponse.json();
      tracks = await tracksResponse.json();
    } catch (error) {
      this.showError('Network error loading map data');
      return;
    }

    const { players } = mapData;

    // Build minimal GameState for MapRenderer and CameraController
    const gameState: GameState = {
      id: this.gameId,
      players: players.map(p => ({ id: p.id, name: p.name, color: p.color } as any)),
      currentPlayerIndex: 0,
      status: 'completed',
      maxPlayers: players.length,
    };

    // Create map container
    this.mapContainer = this.add.container(0, 0);

    // Instantiate MapRenderer (4th param is TrackDrawingManager, not used by renderer internals for grid rendering)
    this.mapRenderer = new MapRenderer(this, this.mapContainer, gameState, null as any);
    this.mapRenderer.createHexagonalGrid();

    // Draw tracks directly onto a graphics object
    const drawingGraphics = this.add.graphics();
    this.mapContainer.add(drawingGraphics);

    tracks.forEach(trackState => {
      const player = players.find(p => p.id === trackState.playerId);
      if (!player) return;
      const color = parseInt(player.color.replace('#', '0x'));
      trackState.segments.forEach(segment => {
        drawingGraphics.lineStyle(3, color, 1);
        drawingGraphics.beginPath();
        drawingGraphics.moveTo(segment.from.x, segment.from.y);
        drawingGraphics.lineTo(segment.to.x, segment.to.y);
        drawingGraphics.strokePath();
      });
    });

    // Set up camera with pan/zoom
    const { width: mapWidth, height: mapHeight } = this.mapRenderer.calculateMapDimensions();
    this.cameraController = new CameraController(this, mapWidth, mapHeight, gameState);
    this.cameraController.setMapContainer(this.mapContainer);
    this.cameraController.setupCamera();

    // Render player legend overlay (fixed position, not part of map container)
    this.renderLegend(players);
  }

  private showError(message: string): void {
    const centerX = this.cameras.main.width / 2;
    const centerY = this.cameras.main.height / 2;

    this.add.text(centerX, centerY - 20, message, {
      fontFamily: UI_FONT_FAMILY,
      fontSize: '24px',
      color: '#ff6666',
      align: 'center',
    }).setOrigin(0.5);

    this.add.text(centerX, centerY + 30, 'Return to Lobby', {
      fontFamily: UI_FONT_FAMILY,
      fontSize: '18px',
      color: '#4CAF50',
      align: 'center',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        window.location.href = '/lobby';
      });
  }

  private renderLegend(players: MapPlayer[]): void {
    const padding = 12;
    const lineHeight = 24;
    const swatchSize = 14;
    const legendX = this.cameras.main.width - 200;
    const legendY = 20;

    // Background
    const bgHeight = padding * 2 + players.length * lineHeight + 30;
    const bg = this.add.graphics();
    bg.fillStyle(0x1a1d24, 0.85);
    bg.fillRoundedRect(legendX - padding, legendY - padding, 190, bgHeight, 8);
    bg.setScrollFactor(0);
    bg.setDepth(1000);

    // Title
    this.add.text(legendX, legendY, 'Players', {
      fontFamily: UI_FONT_FAMILY,
      fontSize: '16px',
      color: '#ffffff',
      fontStyle: 'bold',
    }).setScrollFactor(0).setDepth(1001);

    // Player entries
    players.forEach((player, i) => {
      const y = legendY + 30 + i * lineHeight;
      const color = parseInt(player.color.replace('#', '0x'));

      const swatch = this.add.graphics();
      swatch.fillStyle(color, 1);
      swatch.fillRect(legendX, y, swatchSize, swatchSize);
      swatch.setScrollFactor(0);
      swatch.setDepth(1001);

      this.add.text(legendX + swatchSize + 8, y - 2, player.name, {
        fontFamily: UI_FONT_FAMILY,
        fontSize: '14px',
        color: '#cccccc',
      }).setScrollFactor(0).setDepth(1001);
    });
  }
}
