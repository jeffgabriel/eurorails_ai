import { GameStateSerializer } from '../../services/ai/GameStateSerializer';
import {
  FeasibleOption,
  AIActionType,
  WorldSnapshot,
  BotSkillLevel,
  BotMemoryState,
  TerrainType,
} from '../../../shared/types/GameTypes';

// Mock MapTopology — loadGridPoints returns a configurable map
const mockGridPoints = new Map<string, { row: number; col: number; terrain: number; name?: string }>();
jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => mockGridPoints),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  _resetCache: jest.fn(),
}));

// Mock majorCityGroups (used by getConnectedCityNames)
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => []),
}));

// Mock OptionGenerator.getRankedChains (used by serialize)
jest.mock('../../services/ai/OptionGenerator', () => ({
  OptionGenerator: {
    getRankedChains: jest.fn(() => []),
  },
}));

function makeSnapshot(overrides?: Partial<WorldSnapshot>): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: 10, col: 5 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
    ...overrides,
  };
}

function makeMemory(overrides?: Partial<BotMemoryState>): BotMemoryState {
  return {
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutivePassTurns: 0,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 0,
    activePlan: null,
    turnsOnPlan: 0,
    planHistory: [],
    ...overrides,
  };
}

function makeBuildOption(overrides?: Partial<FeasibleOption>): FeasibleOption {
  return {
    action: AIActionType.BuildTrack,
    feasible: true,
    reason: 'Build toward target',
    targetCity: 'Milano',
    estimatedCost: 12,
    segments: [
      { from: { x: 0, y: 0, row: 20, col: 10, terrain: TerrainType.Clear }, to: { x: 0, y: 0, row: 21, col: 10, terrain: TerrainType.Clear }, cost: 1 },
      { from: { x: 0, y: 0, row: 21, col: 10, terrain: TerrainType.Clear }, to: { x: 0, y: 0, row: 22, col: 10, terrain: TerrainType.Clear }, cost: 1 },
    ],
    ...overrides,
  };
}

describe('GameStateSerializer build option annotations', () => {
  beforeEach(() => {
    mockGridPoints.clear();
  });

  it('annotates build origin when segments[0].from is a known city', () => {
    // Place "Lyon" at the origin of the build segments
    mockGridPoints.set('20,10', { row: 20, col: 10, terrain: TerrainType.Clear, name: 'Lyon' });

    const snapshot = makeSnapshot();
    const memory = makeMemory();
    const buildOption = makeBuildOption();

    const result = GameStateSerializer.serialize(
      snapshot, [], [buildOption], memory, BotSkillLevel.Hard,
    );

    expect(result).toContain('from Lyon toward Milano');
  });

  it('annotates build origin with "near X" when segments[0].from is near a city', () => {
    // Place "Lyon" close (but not at) the origin
    mockGridPoints.set('21,11', { row: 21, col: 11, terrain: TerrainType.Clear, name: 'Lyon' });

    const snapshot = makeSnapshot();
    const memory = makeMemory();
    const buildOption = makeBuildOption();

    const result = GameStateSerializer.serialize(
      snapshot, [], [buildOption], memory, BotSkillLevel.Hard,
    );

    expect(result).toContain('from near Lyon toward Milano');
  });

  it('tags [CONTINUES current build] when target matches memory.currentBuildTarget', () => {
    mockGridPoints.set('20,10', { row: 20, col: 10, terrain: TerrainType.Clear, name: 'Lyon' });

    const snapshot = makeSnapshot();
    const memory = makeMemory({ currentBuildTarget: 'Milano' });
    const buildOption = makeBuildOption({ targetCity: 'Milano' });

    const result = GameStateSerializer.serialize(
      snapshot, [], [buildOption], memory, BotSkillLevel.Hard,
    );

    expect(result).toContain('[CONTINUES current build]');
  });

  it('tags [NEW SPUR] when target differs from memory.currentBuildTarget', () => {
    mockGridPoints.set('20,10', { row: 20, col: 10, terrain: TerrainType.Clear, name: 'Paris' });

    const snapshot = makeSnapshot();
    const memory = makeMemory({ currentBuildTarget: 'Milano' });
    const buildOption = makeBuildOption({ targetCity: 'Bremen' });

    const result = GameStateSerializer.serialize(
      snapshot, [], [buildOption], memory, BotSkillLevel.Hard,
    );

    expect(result).toContain('[NEW SPUR]');
  });

  it('omits spur tag when memory has no currentBuildTarget', () => {
    mockGridPoints.set('20,10', { row: 20, col: 10, terrain: TerrainType.Clear, name: 'Lyon' });

    const snapshot = makeSnapshot();
    const memory = makeMemory({ currentBuildTarget: null });
    const buildOption = makeBuildOption();

    const result = GameStateSerializer.serialize(
      snapshot, [], [buildOption], memory, BotSkillLevel.Hard,
    );

    expect(result).toContain('from Lyon toward Milano');
    expect(result).not.toContain('[CONTINUES');
    expect(result).not.toContain('[NEW SPUR]');
  });

  it('serializeMinimal omits spur tags (no memory available)', () => {
    mockGridPoints.set('20,10', { row: 20, col: 10, terrain: TerrainType.Clear, name: 'Lyon' });

    const snapshot = makeSnapshot();
    const buildOption = makeBuildOption();

    const result = GameStateSerializer.serializeMinimal(
      snapshot, [], [buildOption],
    );

    // Origin should still appear
    expect(result).toContain('from Lyon toward Milano');
    // But no spur tags since no memory is passed
    expect(result).not.toContain('[CONTINUES');
    expect(result).not.toContain('[NEW SPUR]');
  });

  it('handles undefined segments without crashing', () => {
    const snapshot = makeSnapshot();
    const memory = makeMemory({ currentBuildTarget: 'Milano' });
    const buildOption = makeBuildOption({ segments: undefined });

    const result = GameStateSerializer.serialize(
      snapshot, [], [buildOption], memory, BotSkillLevel.Hard,
    );

    expect(result).toContain('BUILD: toward Milano');
    expect(result).not.toContain('from');
    expect(result).not.toContain('[CONTINUES');
    expect(result).not.toContain('[NEW SPUR]');
  });

  it('handles empty segments array without crashing', () => {
    const snapshot = makeSnapshot();
    const memory = makeMemory({ currentBuildTarget: 'Milano' });
    const buildOption = makeBuildOption({ segments: [] });

    const result = GameStateSerializer.serialize(
      snapshot, [], [buildOption], memory, BotSkillLevel.Hard,
    );

    expect(result).toContain('BUILD: toward Milano');
    expect(result).not.toContain('[CONTINUES');
    expect(result).not.toContain('[NEW SPUR]');
  });
});
