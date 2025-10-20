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
    const userJson = localStorage.getItem('eurorails.user');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    
    if (userJson) {
      try {
        const user = JSON.parse(userJson);
        if (user.id) {
          headers['x-user-id'] = user.id;
        }
      } catch (error) {
        console.warn('Failed to parse user from localStorage:', error);
      }
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
        const errorResponse = await response.json();
        errorData = {
          error: errorResponse.error || `HTTP_${response.status}`,
          message: errorResponse.message || response.statusText || 'Network error',
          details: errorResponse.details
        };
      } catch {
        errorData = {
          error: `HTTP_${response.status}`,
          message: response.statusText || 'Network error',
        };
      }
      throw errorData;
    }

    const result = await response.json() as any;
    if (typeof result.success === 'boolean' && !result.success) {
      throw { 
        error: result.error || `API_${endpoint}`, 
        message: result.message || 'API error',
        details: result.details
      };
    }
    return result as T;
  }

  // Auth endpoints
  async register(data: RegisterForm): Promise<AuthResult> {
    const response = await this.request<{ success: boolean; data: AuthResult; message: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return response.data;
  }

  async login(data: LoginForm): Promise<AuthResult> {
    const response = await this.request<{ success: boolean; data: AuthResult; message: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return response.data;
  }

  async getCurrentUser(): Promise<User> {
    const response = await this.request<{ success: boolean; data: { user: User }; message: string }>('/api/auth/me');
    return response.data.user;
  }

  // Game endpoints
  async createGame(data: CreateGameForm = {}): Promise<{ game: Game }> {
    const response = await this.request<{ success: boolean; data: Game }>('/api/lobby/games', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return { game: response.data };
  }

  async joinGame(data: JoinGameForm): Promise<{ game: Game }> {
    const response = await this.request<{ success: boolean; data: Game }>('/api/lobby/games/join', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return { game: response.data };
  }

  async getGame(gameId: ID): Promise<{ game: Game }> {
    const response = await this.request<{ success: boolean; data: Game }>(`/api/lobby/games/${gameId}`);
    return { game: response.data };
  }

  async getGameByJoinCode(joinCode: string): Promise<{ game: Game }> {
    const response = await this.request<{ success: boolean; data: Game }>(`/api/lobby/games/by-join-code/${joinCode}`);
    return { game: response.data };
  }

  async getAvailableColors(gameId: ID): Promise<{ colors: string[] }> {
    const response = await this.request<{ success: boolean; data: string[] }>(`/api/lobby/games/${gameId}/available-colors`);
    return { colors: response.data };
  }

  async getGamePlayers(gameId: ID): Promise<{ players: Player[] }> {
    const response = await this.request<{ success: boolean; data: Player[] }>(`/api/lobby/games/${gameId}/players`);
    return { players: response.data };
  }

  async startGame(gameId: ID): Promise<void> {
    await this.request<{ success: boolean; message: string }>(`/api/lobby/games/${gameId}/start`, {
      method: 'POST',
    });
  }

  async leaveGame(gameId: ID): Promise<void> {
    await this.request<{ success: boolean; message: string }>(`/api/lobby/games/${gameId}/leave`, {
      method: 'POST',
    });
  }

  async updatePlayerPresence(userId: ID, isOnline: boolean): Promise<void> {
    await this.request<{ success: boolean; message: string }>('/api/lobby/players/presence', {
      method: 'POST',
      body: JSON.stringify({ userId, isOnline }),
    });
  }

  async healthCheck(): Promise<{ message: string }> {
    const response = await this.request<{ success: boolean; message: string; timestamp: string; service: string }>('/api/lobby/health');
    return { message: response.message };
  }
}

export const api = new ApiClient();

// Utility function to handle common API error codes
export function getErrorMessage(error: ApiError): string {
  const commonMessages: Record<string, string> = {
    // Auth errors
    LOGIN_FAILED: 'Invalid email or password',
    REGISTRATION_FAILED: 'Registration failed',
    INVALID_CREDENTIALS: 'Invalid email or password',
    USER_EXISTS: 'User already exists with this email',
    UNAUTHORIZED: 'Authentication required',
    EMAIL_NOT_VERIFIED: 'Email verification required',
    INVALID_REFRESH_TOKEN: 'Invalid or expired refresh token',
    PASSWORD_CHANGE_FAILED: 'Password change failed',
    
    // Game errors
    GAME_NOT_FOUND: 'Game not found',
    GAME_FULL: 'Game is full',
    GAME_ALREADY_STARTED: 'Game has already started',
    INVALID_JOIN_CODE: 'Invalid join code',
    NOT_GAME_CREATOR: 'Only the game creator can start the game',
    
    // HTTP errors
    HTTP_401: 'Authentication required',
    HTTP_403: 'Access forbidden',
    HTTP_404: 'Resource not found',
    HTTP_500: 'Server error',
    VALIDATION_ERROR: 'Invalid input data',
    INTERNAL_SERVER_ERROR: 'Server error',
  };

  return commonMessages[error.error] || error.message || 'An error occurred';
}