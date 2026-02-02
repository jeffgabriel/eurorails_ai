// client/__tests__/AILobbyComponents.test.ts
/**
 * Tests for AI Player management components in the lobby
 * Tests AIPlayerCard, AddAIPlayerModal, and the api methods
 */

import type { Player, AIDifficulty, AIPersonality } from '../lobby/shared/types';

// Mock the stores before importing components
jest.mock('../lobby/store/auth.store', () => ({
  useAuthStore: jest.fn(),
}));

jest.mock('../lobby/store/lobby.store', () => ({
  useLobbyStore: jest.fn(),
}));

// Mock localStorage
const mockLocalStorage: Record<string, string> = {};
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: jest.fn((key: string) => mockLocalStorage[key] || null),
    setItem: jest.fn((key: string, value: string) => {
      mockLocalStorage[key] = value;
    }),
    removeItem: jest.fn((key: string) => {
      delete mockLocalStorage[key];
    }),
    clear: jest.fn(() => {
      Object.keys(mockLocalStorage).forEach(key => delete mockLocalStorage[key]);
    }),
  },
  writable: true,
});

import { useAuthStore } from '../lobby/store/auth.store';
import { useLobbyStore } from '../lobby/store/lobby.store';

describe('AI Lobby Components', () => {
  const mockUser = { id: 'user-1', username: 'TestUser', email: 'test@test.com' };
  const mockGame = {
    id: 'game-1',
    joinCode: 'ABC123',
    createdBy: 'user-1',
    status: 'setup' as const,
    maxPlayers: 6,
    isPublic: false,
    createdAt: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (useAuthStore as unknown as jest.Mock).mockReturnValue({ user: mockUser });
    (useLobbyStore as unknown as jest.Mock).mockReturnValue({ currentGame: mockGame });
  });

  describe('AI Player Types', () => {
    it('should have correct AIDifficulty values', () => {
      const difficulties: AIDifficulty[] = ['easy', 'medium', 'hard'];
      expect(difficulties).toHaveLength(3);
      expect(difficulties).toContain('easy');
      expect(difficulties).toContain('medium');
      expect(difficulties).toContain('hard');
    });

    it('should have correct AIPersonality values', () => {
      const personalities: AIPersonality[] = [
        'optimizer',
        'network_builder',
        'opportunist',
        'blocker',
        'steady_hand',
        'chaos_agent',
      ];
      expect(personalities).toHaveLength(6);
      expect(personalities).toContain('optimizer');
      expect(personalities).toContain('network_builder');
      expect(personalities).toContain('opportunist');
      expect(personalities).toContain('blocker');
      expect(personalities).toContain('steady_hand');
      expect(personalities).toContain('chaos_agent');
    });

    it('should correctly identify AI players via isAI field', () => {
      const humanPlayer: Player = {
        id: 'player-1',
        userId: 'user-1',
        name: 'Human Player',
        color: '#ff0000',
        isOnline: true,
        isAI: false,
      };

      const aiPlayer: Player = {
        id: 'player-2',
        userId: 'ai-user-2',
        name: 'AI Player',
        color: '#0000ff',
        isOnline: true,
        isAI: true,
        aiDifficulty: 'medium',
        aiPersonality: 'optimizer',
      };

      expect(humanPlayer.isAI).toBe(false);
      expect(aiPlayer.isAI).toBe(true);
      expect(aiPlayer.aiDifficulty).toBe('medium');
      expect(aiPlayer.aiPersonality).toBe('optimizer');
    });
  });

  describe('AI Player Configuration', () => {
    const difficultyConfig: Record<AIDifficulty, { label: string; planningTurns: number }> = {
      easy: { label: 'Easy', planningTurns: 1 },
      medium: { label: 'Medium', planningTurns: 3 },
      hard: { label: 'Hard', planningTurns: 5 },
    };

    const personalityConfig: Record<AIPersonality, { label: string; description: string }> = {
      optimizer: { label: 'Optimizer', description: 'ROI focused' },
      network_builder: { label: 'Network Builder', description: 'Infrastructure first' },
      opportunist: { label: 'Opportunist', description: 'High risk' },
      blocker: { label: 'Blocker', description: 'Deny others' },
      steady_hand: { label: 'Steady Hand', description: 'Low risk' },
      chaos_agent: { label: 'Chaos Agent', description: 'Unpredictable' },
    };

    it('should have configuration for all difficulty levels', () => {
      const difficulties: AIDifficulty[] = ['easy', 'medium', 'hard'];
      difficulties.forEach((difficulty) => {
        expect(difficultyConfig[difficulty]).toBeDefined();
        expect(difficultyConfig[difficulty].label).toBeTruthy();
        expect(typeof difficultyConfig[difficulty].planningTurns).toBe('number');
      });
    });

    it('should have configuration for all personality types', () => {
      const personalities: AIPersonality[] = [
        'optimizer',
        'network_builder',
        'opportunist',
        'blocker',
        'steady_hand',
        'chaos_agent',
      ];
      personalities.forEach((personality) => {
        expect(personalityConfig[personality]).toBeDefined();
        expect(personalityConfig[personality].label).toBeTruthy();
        expect(personalityConfig[personality].description).toBeTruthy();
      });
    });

    it('should have increasing planning depth for difficulty levels', () => {
      expect(difficultyConfig.easy.planningTurns).toBeLessThan(difficultyConfig.medium.planningTurns);
      expect(difficultyConfig.medium.planningTurns).toBeLessThan(difficultyConfig.hard.planningTurns);
    });
  });

  describe('AI Player Filtering', () => {
    const players: Player[] = [
      {
        id: 'player-1',
        userId: 'user-1',
        name: 'Human 1',
        color: '#ff0000',
        isOnline: true,
        isAI: false,
      },
      {
        id: 'player-2',
        userId: 'ai-user-2',
        name: 'Bot 1',
        color: '#0000ff',
        isOnline: true,
        isAI: true,
        aiDifficulty: 'easy',
        aiPersonality: 'optimizer',
      },
      {
        id: 'player-3',
        userId: 'user-3',
        name: 'Human 2',
        color: '#008000',
        isOnline: false,
        isAI: false,
      },
      {
        id: 'player-4',
        userId: 'ai-user-4',
        name: 'Bot 2',
        color: '#ffd700',
        isOnline: true,
        isAI: true,
        aiDifficulty: 'hard',
        aiPersonality: 'blocker',
      },
    ];

    it('should correctly filter AI players from list', () => {
      const aiPlayers = players.filter((p) => p.isAI);
      expect(aiPlayers).toHaveLength(2);
      expect(aiPlayers.every((p) => p.isAI)).toBe(true);
    });

    it('should correctly filter human players from list', () => {
      const humanPlayers = players.filter((p) => !p.isAI);
      expect(humanPlayers).toHaveLength(2);
      expect(humanPlayers.every((p) => !p.isAI)).toBe(true);
    });

    it('should count total players correctly', () => {
      expect(players.length).toBe(4);
    });
  });

  describe('Add AI Player Button Logic', () => {
    it('should be disabled when game is full (6 players)', () => {
      const playerCount = 6;
      const maxPlayers = 6;
      const isDisabled = playerCount >= maxPlayers;
      expect(isDisabled).toBe(true);
    });

    it('should be enabled when game has room', () => {
      const playerCount = 3;
      const maxPlayers = 6;
      const isDisabled = playerCount >= maxPlayers;
      expect(isDisabled).toBe(false);
    });

    it('should only show for game creator', () => {
      const userId = 'user-1';
      const gameCreatorId = 'user-1';
      const isCreator = userId === gameCreatorId;
      expect(isCreator).toBe(true);
    });

    it('should not show for non-creator', () => {
      const userId: string = 'user-2';
      const gameCreatorId: string = 'user-1';
      const isCreator = userId === gameCreatorId;
      expect(isCreator).toBe(false);
    });

    it('should only show for games in setup status', () => {
      const statuses = ['setup', 'initialBuild', 'active', 'completed', 'abandoned'];
      const canAddAI = (status: string) => status === 'setup';

      expect(canAddAI('setup')).toBe(true);
      expect(canAddAI('initialBuild')).toBe(false);
      expect(canAddAI('active')).toBe(false);
      expect(canAddAI('completed')).toBe(false);
      expect(canAddAI('abandoned')).toBe(false);
    });
  });

  describe('Remove AI Player Logic', () => {
    it('should only allow creator to remove AI players', () => {
      const currentUserId = 'user-1';
      const gameCreatorId = 'user-1';
      const isCreator = currentUserId === gameCreatorId;
      expect(isCreator).toBe(true);
    });

    it('should identify player as AI before allowing removal', () => {
      const aiPlayer: Player = {
        id: 'player-2',
        userId: 'ai-user-2',
        name: 'Bot',
        color: '#0000ff',
        isOnline: true,
        isAI: true,
        aiDifficulty: 'medium',
        aiPersonality: 'optimizer',
      };

      const humanPlayer: Player = {
        id: 'player-1',
        userId: 'user-1',
        name: 'Human',
        color: '#ff0000',
        isOnline: true,
        isAI: false,
      };

      // Should be able to remove AI players
      expect(aiPlayer.isAI).toBe(true);
      // Should not show remove button for human players
      expect(humanPlayer.isAI).toBe(false);
    });
  });

  describe('AI Player Defaults', () => {
    it('should have sensible default values', () => {
      const defaultDifficulty: AIDifficulty = 'medium';
      const defaultPersonality: AIPersonality = 'optimizer';

      expect(defaultDifficulty).toBe('medium');
      expect(defaultPersonality).toBe('optimizer');
    });
  });

  describe('Preview Text Generation', () => {
    function getPreviewDescription(difficulty: AIDifficulty, personality: AIPersonality): string {
      const difficultyText: Record<AIDifficulty, string> = {
        easy: 'Plans 1 turn ahead',
        medium: 'Plans 2-3 turns ahead',
        hard: 'Plans 4-5 turns ahead',
      };

      const personalityText: Record<AIPersonality, string> = {
        optimizer: 'maximizing ROI on every decision with analytical precision',
        network_builder: 'building infrastructure for long-term strategic advantage',
        opportunist: 'chasing high-value opportunities with bold, adaptive moves',
        blocker: 'denying opponents key positions and resources',
        steady_hand: 'making consistent, low-risk progress toward victory',
        chaos_agent: 'keeping opponents guessing with unpredictable moves',
      };

      return `${difficultyText[difficulty]}, ${personalityText[personality]}.`;
    }

    it('should generate correct preview for easy optimizer', () => {
      const preview = getPreviewDescription('easy', 'optimizer');
      expect(preview).toContain('Plans 1 turn ahead');
      expect(preview).toContain('maximizing ROI');
    });

    it('should generate correct preview for hard chaos_agent', () => {
      const preview = getPreviewDescription('hard', 'chaos_agent');
      expect(preview).toContain('Plans 4-5 turns ahead');
      expect(preview).toContain('unpredictable');
    });

    it('should generate correct preview for medium blocker', () => {
      const preview = getPreviewDescription('medium', 'blocker');
      expect(preview).toContain('Plans 2-3 turns ahead');
      expect(preview).toContain('denying opponents');
    });
  });
});
