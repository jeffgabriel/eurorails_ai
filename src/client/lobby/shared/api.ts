// shared/api.ts
import type {
  User,
  AuthResult,
  Game,
  Player,
  ApiError,
  LoginForm,
  RegisterForm,
  CreateGameForm,
  JoinGameForm,
  ID
} from './types';
import { config, debug } from './config';

class ApiClient {
  private getAuthHeaders(): Record<string, string> {
    const token = localStorage.getItem('eurorails.jwt');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    
    return headers;
  }

  private async request<T>(
    endpoint: string, 
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${config.apiBaseUrl}${endpoint}`;
    
    debug.log('API Request:', { method: options.method || 'GET', url, endpoint });
    
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.getAuthHeaders(),
        ...options.headers,
      },
    });

    if (!response.ok) {
      let errorData: ApiError;
      try {
        errorData = await response.json();
      } catch {
        errorData = {
          code: `HTTP_${response.status}`,
          message: response.statusText || 'Network error',
        };
      }
      throw errorData;
    }

    return response.json();
  }

  // Auth endpoints
  async register(data: RegisterForm): Promise<AuthResult> {
    // TODO(server): Implement register endpoint
    return this.request<AuthResult>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async login(data: LoginForm): Promise<AuthResult> {
    // TODO(server): Implement login endpoint
    return this.request<AuthResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getCurrentUser(): Promise<User> {
    // TODO(server): Implement current user endpoint
    return this.request<User>('/me');
  }

  // Game endpoints
  async createGame(data: CreateGameForm = {}): Promise<{ game: Game }> {
    return this.request<{ game: Game }>('/api/lobby/games', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async joinGame(data: JoinGameForm): Promise<{ game: Game }> {
    return this.request<{ game: Game }>('/api/lobby/games/join', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getGame(gameId: ID): Promise<{ game: Game }> {
    return this.request<{ game: Game }>(`/api/lobby/games/${gameId}`);
  }

  async getGamePlayers(gameId: ID): Promise<{ players: Player[] }> {
    return this.request<{ players: Player[] }>(`/api/lobby/games/${gameId}/players`);
  }

  async startGame(gameId: ID): Promise<void> {
    await this.request<void>(`/api/lobby/games/${gameId}/start`, {
      method: 'POST',
    });
  }

  async leaveGame(gameId: ID): Promise<void> {
    await this.request<void>(`/api/lobby/games/${gameId}/leave`, {
      method: 'POST',
    });
  }

  async updatePlayerPresence(userId: ID, isOnline: boolean): Promise<void> {
    await this.request<void>('/api/lobby/players/presence', {
      method: 'POST',
      body: JSON.stringify({ userId, isOnline }),
    });
  }

  async healthCheck(): Promise<{ message: string }> {
    return this.request<{ message: string }>('/api/lobby/health');
  }
}

export const api = new ApiClient();

// Utility function to handle common API error codes
export function getErrorMessage(error: ApiError): string {
  const commonMessages: Record<string, string> = {
    INVALID_CREDENTIALS: 'Invalid email or password',
    USER_EXISTS: 'User already exists with this email',
    GAME_NOT_FOUND: 'Game not found',
    GAME_FULL: 'Game is full',
    GAME_ALREADY_STARTED: 'Game has already started',
    INVALID_JOIN_CODE: 'Invalid join code',
    NOT_GAME_CREATOR: 'Only the game creator can start the game',
    HTTP_401: 'Authentication required',
    HTTP_403: 'Access forbidden',
    HTTP_404: 'Resource not found',
    HTTP_500: 'Server error',
  };

  return commonMessages[error.code] || error.message || 'An error occurred';
}