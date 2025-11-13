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
  status: 'IN_SETUP' | 'ACTIVE' | 'COMPLETE' | 'ABANDONED';
  gameStatus?: 'setup' | 'active' | 'completed' | 'abandoned';
  maxPlayers: number;
  isPublic: boolean;
  createdAt: Date;
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