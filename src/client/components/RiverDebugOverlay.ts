/**
 * Debug overlay that draws all river crossing edges on the map,
 * color-coded by river name. Toggle with F10.
 */
import Phaser from 'phaser';
import crossings from '../../../configuration/waterCrossings.json';
import { HORIZONTAL_SPACING, VERTICAL_SPACING, GRID_MARGIN } from '../config/mapConfig';

type WaterCrossingsJson = {
  riverEdges: string[];
  nonRiverWaterEdges: string[];
  riverAttribution?: Record<string, string[]>;
};

const json = crossings as unknown as WaterCrossingsJson;

// One distinct color per river
const RIVER_COLORS: Record<string, number> = {
  Rhein:         0xff0000, // red
  Elbe:          0x00ff00, // green
  Donau:         0x0000ff, // blue
  Meuse:         0xff00ff, // magenta
  Loire:         0xffff00, // yellow
  Siene:         0x00ffff, // cyan
  Oder:          0xff8800, // orange
  Vistula:       0x8800ff, // purple
  Po:            0xff4488, // pink
  Rhône:         0x88ff00, // lime
  Garonne:       0x0088ff, // sky blue
  Sava:          0xff8888, // light red
  Tajo:          0x88ff88, // light green
  Duero:         0x8888ff, // light blue
  Ebro:          0xffaa00, // amber
  Guadalquivir:  0xaa00ff, // violet
  Tevere:        0x00ffaa, // teal
  Thames:        0xffdddd, // pale pink
  Severn:        0xddffdd, // pale green
  Trent:         0xddddff, // pale blue
  Shannon:       0xffcc44, // gold
};

const DEFAULT_COLOR = 0xffffff;

function gridToPixel(row: number, col: number): { x: number; y: number } {
  const isOffsetRow = row % 2 === 1;
  const x = col * HORIZONTAL_SPACING + GRID_MARGIN + (isOffsetRow ? HORIZONTAL_SPACING / 2 : 0);
  const y = row * VERTICAL_SPACING + GRID_MARGIN;
  return { x, y };
}

export class RiverDebugOverlay {
  private scene: Phaser.Scene;
  private mapContainer: Phaser.GameObjects.Container;
  private graphics: Phaser.GameObjects.Graphics | null = null;
  private legend: Phaser.GameObjects.Text | null = null;
  private visible = false;

  constructor(scene: Phaser.Scene, mapContainer: Phaser.GameObjects.Container) {
    this.scene = scene;
    this.mapContainer = mapContainer;

    scene.input.keyboard?.on('keydown-F10', () => {
      this.toggle();
    });
  }

  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  private show(): void {
    if (!json.riverAttribution) return;
    this.visible = true;

    // Build river -> edges map
    const riverEdges = new Map<string, Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>>();
    for (const [edgeKey, rivers] of Object.entries(json.riverAttribution)) {
      const [aPart, bPart] = edgeKey.split('|');
      const [r1, c1] = aPart.split(',').map(Number);
      const [r2, c2] = bPart.split(',').map(Number);
      const from = gridToPixel(r1, c1);
      const to = gridToPixel(r2, c2);

      for (const river of rivers) {
        if (!riverEdges.has(river)) riverEdges.set(river, []);
        riverEdges.get(river)!.push({ from, to });
      }
    }

    // Draw
    this.graphics = this.scene.add.graphics();
    this.graphics.setDepth(5); // Above tracks so we can see clearly

    for (const [river, edges] of riverEdges) {
      const color = RIVER_COLORS[river] ?? DEFAULT_COLOR;
      this.graphics.lineStyle(3, color, 0.7);

      for (const edge of edges) {
        this.graphics.beginPath();
        this.graphics.moveTo(edge.from.x, edge.from.y);
        this.graphics.lineTo(edge.to.x, edge.to.y);
        this.graphics.strokePath();
      }
    }

    this.mapContainer.add(this.graphics);

    // Draw legend as a fixed-position text (on UI camera)
    const legendLines = Object.entries(RIVER_COLORS)
      .filter(([name]) => riverEdges.has(name))
      .map(([name, color]) => {
        const hex = '#' + color.toString(16).padStart(6, '0');
        return `[color=${hex}]■[/color] ${name} (${riverEdges.get(name)!.length})`;
      });

    this.legend = this.scene.add.text(10, 10, 'River Crossings (F10 to hide)\n' + legendLines.join('\n'), {
      fontSize: '14px',
      fontFamily: 'monospace',
      color: '#ffffff',
      backgroundColor: '#000000aa',
      padding: { x: 8, y: 8 },
    });
    this.legend.setScrollFactor(0);
    this.legend.setDepth(1000);
  }

  private hide(): void {
    this.visible = false;
    if (this.graphics) {
      this.graphics.destroy();
      this.graphics = null;
    }
    if (this.legend) {
      this.legend.destroy();
      this.legend = null;
    }
  }

  destroy(): void {
    this.hide();
  }
}
