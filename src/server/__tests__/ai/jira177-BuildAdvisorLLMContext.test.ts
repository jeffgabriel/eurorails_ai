/**
 * Tests for JIRA-177: Build Advisor LLM Context Improvements
 * Covers: ferry port visibility, water impassability, ferry connections section,
 * track network section, and conditional omission rules.
 */
import { MapRenderer } from '../../services/ai/MapRenderer';
import { getBuildAdvisorPrompt } from '../../services/ai/prompts/systemPrompts';
import {
  GridPoint,
  TrackSegment,
  TerrainType,
  FerryConnection,
  CorridorMap,
  GameContext,
} from '../../../shared/types/GameTypes';

/** Helper to create a GridPoint */
function gp(row: number, col: number, terrain: TerrainType, cityName?: string, ferryConnection?: FerryConnection): GridPoint {
  return {
    id: `${row},${col}`,
    x: col * 50,
    y: row * 50,
    row,
    col,
    terrain,
    city: cityName ? { type: terrain, name: cityName, availableLoads: [] } : undefined,
    ferryConnection,
  };
}

/** Helper to create a TrackSegment */
function seg(fromRow: number, fromCol: number, toRow: number, toCol: number): TrackSegment {
  return {
    from: { x: 0, y: 0, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

/** Minimal GameContext for prompt tests */
function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    phase: 'mid',
    money: 100,
    loads: [],
    connectedMajorCities: [],
    citiesOnNetwork: [],
    unconnectedMajorCities: [],
    turnNumber: 5,
    trainType: 'Freight',
    demandCards: [],
    ...overrides,
  };
}

/** Minimal CorridorMap for tests */
function makeCorridorMap(minRow = 0, maxRow = 10, minCol = 0, maxCol = 10): CorridorMap {
  return {
    rendered: 'MAP',
    minRow,
    maxRow,
    minCol,
    maxCol,
  };
}

// ─── AC1: FerryPort renders as 'F' ────────────────────────────────────────────

describe('AC1: MapRenderer ferry port character', () => {
  it('should render FerryPort terrain as F (not .)', () => {
    const gridWithFerry: GridPoint[] = [
      gp(0, 0, TerrainType.Clear),
      gp(0, 1, TerrainType.FerryPort, 'Dover Ferry'),
      gp(0, 2, TerrainType.Clear),
      gp(1, 0, TerrainType.Clear),
      gp(1, 1, TerrainType.Clear),
      gp(1, 2, TerrainType.MajorCity, 'London'),
    ];

    const result = MapRenderer.renderCorridor(
      [],
      [],
      gridWithFerry,
      [{ row: 0, col: 0 }],
      { row: 1, col: 2 },
      4,
    );

    // Row 0 should contain 'F' for the ferry port
    const lines = result.rendered.split('\n');
    const row0 = lines[1]; // header is line 0, row 0 is line 1
    expect(row0).toContain('F');
    // Should NOT render as '.' (old behavior)
    // Note: other cells may have '.' for clear terrain, so check the ferry column specifically
    // The ferry is at col 1, so the cell at (0,1) should be F
    expect(row0).toMatch(/ F /);
  });
});

// ─── AC2: Legend includes F=ferry port and ~=water(impassable) ───────────────

describe('AC2: Legend entries for ferry port and water', () => {
  const smallGrid: GridPoint[] = [
    gp(0, 0, TerrainType.Clear),
    gp(0, 1, TerrainType.Clear),
    gp(1, 0, TerrainType.MajorCity, 'Paris'),
    gp(1, 1, TerrainType.Clear),
  ];

  it('renderCorridor legend should include F=ferry port', () => {
    const result = MapRenderer.renderCorridor([], [], smallGrid, [{ row: 0, col: 0 }], { row: 1, col: 0 }, 4);
    expect(result.rendered).toContain('F=ferry port');
  });

  it('renderCorridor legend should include ~=water(impassable)', () => {
    const result = MapRenderer.renderCorridor([], [], smallGrid, [{ row: 0, col: 0 }], { row: 1, col: 0 }, 4);
    expect(result.rendered).toContain('~=water(impassable)');
  });

  it('renderRouteCorridor legend should include F=ferry port', () => {
    const route = {
      stops: [{ action: 'pickup' as const, loadType: 'Coal', city: 'Paris' }],
      currentStopIndex: 0,
      phase: 'travel' as const,
      createdAtTurn: 1,
      reasoning: 'test',
    };
    const snapshot = {
      gameId: 'test',
      gameStatus: 'in_progress' as const,
      turnNumber: 1,
      bot: {
        playerId: 'bot1',
        userId: 'user1',
        money: 100,
        position: null,
        existingSegments: [],
        demandCards: [],
        resolvedDemands: [],
        trainType: 'Freight' as const,
        loads: [],
        botConfig: null,
        connectedMajorCityCount: 0,
      },
      allPlayerTracks: [],
      loadAvailability: {},
    };
    const result = MapRenderer.renderRouteCorridor(route, snapshot, smallGrid, []);
    expect(result.rendered).toContain('F=ferry port');
    expect(result.rendered).toContain('~=water(impassable)');
  });
});

// ─── AC3: System prompt contains water impassability rule ─────────────────────

describe('AC3: System prompt water impassability rule', () => {
  it('system prompt should contain water impassability text', () => {
    const { system } = getBuildAdvisorPrompt(makeContext(), null, makeCorridorMap());
    expect(system).toMatch(/[Ww]ater.*impassable/);
    expect(system).toContain('~');
  });

  it('system prompt should mention ferry ports for water crossing', () => {
    const { system } = getBuildAdvisorPrompt(makeContext(), null, makeCorridorMap());
    expect(system).toMatch(/ferry port|ferry/i);
  });
});

// ─── AC4: Ferry connections section present when ferries exist in corridor ────

describe('AC4: FERRY CONNECTIONS section', () => {
  const ferryA: FerryConnection = {
    Name: 'English Channel (Calais)',
    connections: [
      { row: 3, col: 3, x: 0, y: 0, id: 'f1', terrain: TerrainType.FerryPort },
      { row: 2, col: 4, x: 0, y: 0, id: 'f2', terrain: TerrainType.FerryPort },
    ],
    cost: 15,
  };

  it('should include FERRY CONNECTIONS section when ferries are within corridor bounds', () => {
    const corridorMap = makeCorridorMap(0, 10, 0, 10); // ferry at (3,3)↔(2,4) is inside
    const { user } = getBuildAdvisorPrompt(makeContext(), null, corridorMap, undefined, [ferryA]);
    expect(user).toContain('FERRY CONNECTIONS');
    expect(user).toContain('English Channel (Calais)');
    expect(user).toContain('(3,3)');
    expect(user).toContain('(2,4)');
    expect(user).toContain('15M');
  });

  it('should format ferry as (r1,c1) ↔ (r2,c2)', () => {
    const corridorMap = makeCorridorMap(0, 10, 0, 10);
    const { user } = getBuildAdvisorPrompt(makeContext(), null, corridorMap, undefined, [ferryA]);
    expect(user).toMatch(/\(3,3\)\s*↔\s*\(2,4\)/);
  });
});

// ─── AC5: Track network section present when bot has segments ─────────────────

describe('AC5: YOUR TRACK NETWORK section', () => {
  const gridWithCities: GridPoint[] = [
    gp(0, 0, TerrainType.MajorCity, 'Berlin'),
    gp(0, 1, TerrainType.Clear),
    gp(0, 2, TerrainType.MajorCity, 'Warsaw'),
  ];

  it('should include YOUR TRACK NETWORK section when bot has segments', () => {
    const segments = [seg(0, 0, 0, 1), seg(0, 1, 0, 2)];
    const { user } = getBuildAdvisorPrompt(
      makeContext(), null, makeCorridorMap(), undefined, [], segments, gridWithCities,
    );
    expect(user).toContain('YOUR TRACK NETWORK');
    expect(user).toContain('Chain:');
  });

  it('should annotate city names in chain', () => {
    const segments = [seg(0, 0, 0, 1), seg(0, 1, 0, 2)];
    const { user } = getBuildAdvisorPrompt(
      makeContext(), null, makeCorridorMap(), undefined, [], segments, gridWithCities,
    );
    expect(user).toContain('Berlin');
    expect(user).toContain('Warsaw');
  });

  it('should show connected chain as arrow-separated nodes', () => {
    const segments = [seg(0, 0, 0, 1), seg(0, 1, 0, 2)];
    const { user } = getBuildAdvisorPrompt(
      makeContext(), null, makeCorridorMap(), undefined, [], segments, gridWithCities,
    );
    expect(user).toMatch(/Chain:.*→.*→/);
  });
});

// ─── AC6: Ferry connections section omitted when no ferries in corridor ────────

describe('AC6: FERRY CONNECTIONS section omitted when empty', () => {
  it('should omit FERRY CONNECTIONS section when no ferries exist', () => {
    const { user } = getBuildAdvisorPrompt(makeContext(), null, makeCorridorMap(), undefined, []);
    expect(user).not.toContain('FERRY CONNECTIONS');
  });

  it('should omit FERRY CONNECTIONS section when ferries are outside corridor bounds', () => {
    const ferryOutside: FerryConnection = {
      Name: 'Far Away Ferry',
      connections: [
        { row: 50, col: 50, x: 0, y: 0, id: 'f1', terrain: TerrainType.FerryPort },
        { row: 51, col: 51, x: 0, y: 0, id: 'f2', terrain: TerrainType.FerryPort },
      ],
      cost: 10,
    };
    const corridorMap = makeCorridorMap(0, 10, 0, 10); // ferry is at row 50,51 — outside
    const { user } = getBuildAdvisorPrompt(makeContext(), null, corridorMap, undefined, [ferryOutside]);
    expect(user).not.toContain('FERRY CONNECTIONS');
  });

  it('should omit FERRY CONNECTIONS section when one port is outside corridor', () => {
    // Decision: only ferries FULLY within corridor are included (ADR decision option A)
    const ferryPartial: FerryConnection = {
      Name: 'Partial Ferry',
      connections: [
        { row: 5, col: 5, x: 0, y: 0, id: 'f1', terrain: TerrainType.FerryPort },  // inside
        { row: 15, col: 5, x: 0, y: 0, id: 'f2', terrain: TerrainType.FerryPort }, // outside (row > 10)
      ],
      cost: 8,
    };
    const corridorMap = makeCorridorMap(0, 10, 0, 10);
    const { user } = getBuildAdvisorPrompt(makeContext(), null, corridorMap, undefined, [ferryPartial]);
    expect(user).not.toContain('FERRY CONNECTIONS');
  });
});

// ─── AC7: Track network section omitted when no segments ─────────────────────

describe('AC7: YOUR TRACK NETWORK section omitted when no segments', () => {
  it('should omit YOUR TRACK NETWORK section when bot has no segments', () => {
    const { user } = getBuildAdvisorPrompt(makeContext(), null, makeCorridorMap(), undefined, [], []);
    expect(user).not.toContain('YOUR TRACK NETWORK');
  });

  it('should omit YOUR TRACK NETWORK section when segments array not provided', () => {
    const { user } = getBuildAdvisorPrompt(makeContext(), null, makeCorridorMap());
    expect(user).not.toContain('YOUR TRACK NETWORK');
  });
});

// ─── Chain building: disconnected segments form multiple chains ───────────────

describe('Track chain building', () => {
  const gridWithCities: GridPoint[] = [
    gp(0, 0, TerrainType.MajorCity, 'Berlin'),
    gp(0, 1, TerrainType.Clear),
    gp(0, 2, TerrainType.MajorCity, 'Warsaw'),
    gp(5, 5, TerrainType.Clear),
    gp(5, 6, TerrainType.MajorCity, 'Wien'),
  ];

  it('should produce two chains for disconnected segments', () => {
    const segments = [
      seg(0, 0, 0, 1), // chain 1: Berlin → (0,1)
      seg(5, 5, 5, 6), // chain 2: (5,5) → Wien
    ];
    const { user } = getBuildAdvisorPrompt(
      makeContext(), null, makeCorridorMap(), undefined, [], segments, gridWithCities,
    );
    // Two separate "Chain:" entries
    const chainMatches = user.match(/Chain:/g);
    expect(chainMatches).toHaveLength(2);
  });
});
