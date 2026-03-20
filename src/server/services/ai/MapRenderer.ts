import { GridPoint, TrackSegment, TerrainType, CorridorMap } from '../../../shared/types/GameTypes';

/**
 * Renders a compact hex corridor map as ASCII for LLM prompts (JIRA-129).
 * Static class — no instance state.
 */
export class MapRenderer {
  /** Terrain type → single-char encoding */
  private static readonly TERRAIN_CHARS: Record<number, string> = {
    [TerrainType.Clear]: '.',
    [TerrainType.Mountain]: 'm',
    [TerrainType.Alpine]: 'A',
    [TerrainType.SmallCity]: 's',
    [TerrainType.MediumCity]: 'M',
    [TerrainType.MajorCity]: '*',
    [TerrainType.FerryPort]: '.',
    [TerrainType.Water]: '~',
  };

  /**
   * Render a compact hex corridor map as ASCII for LLM prompt.
   *
   * @param botTrack - Bot's track segments
   * @param opponentTracks - Each opponent's track segments
   * @param gridPoints - Full hex grid
   * @param networkFrontier - Bot's network frontier positions (edge of built track)
   * @param targetCity - Target city grid coordinate
   * @param corridorSize - Corridor size (default 20)
   * @returns CorridorMap with rendered ASCII and bounding box
   */
  static renderCorridor(
    botTrack: TrackSegment[],
    opponentTracks: TrackSegment[][],
    gridPoints: GridPoint[],
    networkFrontier: { row: number; col: number }[],
    targetCity: { row: number; col: number },
    corridorSize: number = 20,
  ): CorridorMap {
    // 1. Calculate corridor bounds
    const { minRow, maxRow, minCol, maxCol } = MapRenderer.calculateBounds(
      networkFrontier,
      targetCity,
      corridorSize,
      gridPoints,
    );

    // 2. Build lookup maps
    const pointMap = new Map<string, GridPoint>();
    for (const gp of gridPoints) {
      pointMap.set(`${gp.row},${gp.col}`, gp);
    }

    const botTrackSet = new Set<string>();
    for (const seg of botTrack) {
      botTrackSet.add(`${seg.from.row},${seg.from.col}`);
      botTrackSet.add(`${seg.to.row},${seg.to.col}`);
    }

    const opponentTrackSet = new Set<string>();
    for (const tracks of opponentTracks) {
      for (const seg of tracks) {
        opponentTrackSet.add(`${seg.from.row},${seg.from.col}`);
        opponentTrackSet.add(`${seg.to.row},${seg.to.col}`);
      }
    }

    const targetKey = `${targetCity.row},${targetCity.col}`;

    // 3. City annotations collector
    const cityAnnotations: Map<number, string> = new Map(); // row → city name

    // 4. Render grid with coordinate labels
    const lines: string[] = [];

    // Column header row: 5-char left padding + each col number padded to 4 chars
    let header = '     ';
    for (let col = minCol; col <= maxCol; col++) {
      header += String(col).padStart(4, ' ');
    }
    lines.push(header);

    for (let row = minRow; row <= maxRow; row++) {
      // Row label: row number right-justified in 3 chars + ': '
      let line = String(row).padStart(3, ' ') + ': ';
      for (let col = minCol; col <= maxCol; col++) {
        const key = `${row},${col}`;
        const gp = pointMap.get(key);

        let ch: string;
        if (!gp) {
          ch = ' ';
        } else if (key === targetKey) {
          ch = 'T';
        } else if (botTrackSet.has(key)) {
          ch = 'B';
        } else if (opponentTrackSet.has(key)) {
          ch = 'O';
        } else {
          ch = MapRenderer.TERRAIN_CHARS[gp.terrain] ?? '.';
        }

        // Pad each cell to 4 chars to align with column headers
        line += (' ' + ch).padEnd(4, ' ');

        // Collect city names for annotation
        if (gp?.city) {
          cityAnnotations.set(row, gp.city.name);
        }
      }

      // Annotate city name on right side
      const annotation = cityAnnotations.get(row);
      if (annotation) {
        line += `  ${annotation}`;
      }

      lines.push(line);
    }

    // 5. Add legend
    const legend = [
      '',
      'Legend: .=clear(1) m=mountain(2) A=alpine(5) s=small(3) M=medium(3) *=major(5)',
      'B=bot track O=opponent track T=build target',
    ];

    const rendered = lines.join('\n') + '\n' + legend.join('\n');

    return { rendered, minRow, maxRow, minCol, maxCol };
  }

  /**
   * Calculate corridor bounding box.
   * Encloses bot's network frontier + target city, expanded by corridorSize/4 each direction
   * (min 5 hexes padding), clamped to grid boundaries.
   */
  static calculateBounds(
    networkFrontier: { row: number; col: number }[],
    targetCity: { row: number; col: number },
    corridorSize: number,
    gridPoints: GridPoint[],
  ): { minRow: number; maxRow: number; minCol: number; maxCol: number } {
    // Collect all relevant points
    const allPoints = [...networkFrontier, targetCity];

    if (allPoints.length === 0) {
      return { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 };
    }

    let rawMinRow = Infinity;
    let rawMaxRow = -Infinity;
    let rawMinCol = Infinity;
    let rawMaxCol = -Infinity;

    for (const p of allPoints) {
      rawMinRow = Math.min(rawMinRow, p.row);
      rawMaxRow = Math.max(rawMaxRow, p.row);
      rawMinCol = Math.min(rawMinCol, p.col);
      rawMaxCol = Math.max(rawMaxCol, p.col);
    }

    // Expand by corridorSize/4, minimum 5
    const padding = Math.max(Math.floor(corridorSize / 4), 5);

    // Find grid boundaries
    let gridMinRow = Infinity;
    let gridMaxRow = -Infinity;
    let gridMinCol = Infinity;
    let gridMaxCol = -Infinity;

    for (const gp of gridPoints) {
      gridMinRow = Math.min(gridMinRow, gp.row);
      gridMaxRow = Math.max(gridMaxRow, gp.row);
      gridMinCol = Math.min(gridMinCol, gp.col);
      gridMaxCol = Math.max(gridMaxCol, gp.col);
    }

    // Clamp to grid boundaries
    const minRow = Math.max(rawMinRow - padding, gridMinRow);
    const maxRow = Math.min(rawMaxRow + padding, gridMaxRow);
    const minCol = Math.max(rawMinCol - padding, gridMinCol);
    const maxCol = Math.min(rawMaxCol + padding, gridMaxCol);

    return { minRow, maxRow, minCol, maxCol };
  }
}
