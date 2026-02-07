// shared/types.ts
export type ID = string;

export interface User {
  id: ID;
  username: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  lastActive: Date;
}

export interface AuthResult {
  user: User;
  token: string;
  refreshToken?: string;
}

export interface Player {
  id: ID;
  userId: ID;
  name: string;
  color: string;
  isOnline: boolean;
}

export interface Game {
  id: ID;
  joinCode: string;
  createdBy: ID;
  // games.status is the single source of truth
  status: 'setup' | 'initialBuild' | 'active' | 'completed' | 'abandoned';
  maxPlayers: number;
  isPublic: boolean;
  createdAt: Date;
}

export interface GameSummary {
  id: ID;
  joinCode: string | null;
  createdBy: ID | null;
  status: Game['status'];
  maxPlayers: number;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
  playerCount: number;
  onlineCount: number;
  isOwner: boolean;
}

export interface MyGamesResponse {
  active: GameSummary[];
  setupOwned: GameSummary[];
  archived: GameSummary[];
}

// Minimal game state for UI
export interface GameState {
  id: ID;
  players: Player[];
  currentTurnUserId: ID;
  // board/track data summarized for client rendering (keep as server truth)
  tracks: Array<{ 
    ownerUserId: ID; 
    segments: Array<{ x: number; y: number }> 
  }>;
  // add fields as needed
}

// API Error types
export interface ApiError {
  error: string;
  message: string;
  details?: string;
}

// Socket.IO event types
export interface ClientToServerEvents {
  join: (data: { gameId: ID }) => void;
  action: (data: { gameId: ID; type: string; payload: unknown; clientSeq: number }) => void;
  'join-lobby': (data: { gameId: ID }) => void;
  'leave-lobby': (data: { gameId: ID }) => void;
  'join-game-chat': (data: { gameId: ID; userId: ID }) => void;
  'leave-game-chat': (data: { gameId: ID }) => void;
  'send-chat-message': (data: { gameId: ID; message: string; recipientType: 'game' | 'player'; recipientId: ID }) => void;
}

export interface ServerToClientEvents {
  'state:init': (data: { gameState: GameState; serverSeq: number }) => void;
  'state:patch': (data: { patch: Partial<GameState>; serverSeq: number }) => void;
  'presence:update': (data: { userId: ID; isOnline: boolean }) => void;
  'turn:change': (data: { currentTurnUserId: ID; serverSeq: number }) => void;
  'error': (data: { code: string; message: string }) => void;
  'lobby-updated': (data: { gameId: ID; players: Player[]; action: 'player-joined' | 'player-left'; timestamp: number }) => void;
  'game-started': (data: { gameId: ID; timestamp: number }) => void;
  'track:updated': (data: { gameId: ID; playerId: ID; timestamp: number }) => void;
  'victory:triggered': (data: {
    gameId: ID;
    triggerPlayerIndex: number;
    triggerPlayerName: string;
    finalTurnPlayerIndex: number;
    victoryThreshold: number;
    timestamp: number;
  }) => void;
  'game:over': (data: {
    gameId: ID;
    winnerId: ID;
    winnerName: string;
    timestamp: number;
  }) => void;
  'victory:tie-extended': (data: {
    gameId: ID;
    newThreshold: number;
    timestamp: number;
  }) => void;
  'chat-message': (data: { gameId: ID; message: any }) => void;
  'chat-status': (data: { gameId: ID; messageId: number; status: 'delivered' | 'read' }) => void;
  'chat-error': (data: { error: string; message: string }) => void;
}

// Form validation types
export interface LoginForm {
  email: string;
  password: string;
}

export interface RegisterForm {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export interface CreateGameForm {
  isPublic?: boolean;
  creatorColor?: string;
}

export interface JoinGameForm {
  joinCode: string;
  selectedColor?: string;
}