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
  MyGamesResponse,
  ID
} from './types';
import type { LoadState, LoadType } from '../../../shared/types/LoadTypes';
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
    options: RequestInit = {},
    retryOn401: boolean = true
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

    // Handle 401 with automatic token refresh
    if (response.status === 401 && retryOn401) {
      const refreshToken = localStorage.getItem('eurorails.refreshToken');
      if (refreshToken) {
        try {
          // Import auth store dynamically to avoid circular dependency
          const { useAuthStore } = await import('../store/auth.store');
          const refreshed = await useAuthStore.getState().refreshAccessToken();
          
          if (refreshed) {
            // Retry the original request with new token (don't retry again to avoid infinite loop)
            return this.request<T>(endpoint, options, false);
          }
        } catch (refreshError) {
          console.error('Token refresh failed:', refreshError);
          // Fall through to normal error handling
        }
      }
    }

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

  async refreshToken(refreshToken: string): Promise<{ token: string; refreshToken: string }> {
    // Disable retry on 401 to prevent infinite loop if refresh token is invalid
    const response = await this.request<{ success: boolean; data: { token: string; refreshToken: string }; message: string }>('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }, false);
    return response.data;
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

  // Lobby listings / management
  async getMyGames(): Promise<MyGamesResponse> {
    const response = await this.request<{ success: boolean; data: MyGamesResponse }>('/api/lobby/my-games');
    return response.data;
  }

  async deleteGame(gameId: ID, data: { mode: 'soft' | 'hard' | 'transfer'; newOwnerUserId?: ID }): Promise<void> {
    await this.request<{ success: boolean; message: string }>(`/api/lobby/games/${gameId}/delete`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async bulkDeleteGames(data: { gameIds: ID[]; mode: 'soft' | 'hard' }): Promise<void> {
    await this.request<{ success: boolean; message: string }>(`/api/lobby/games/bulk-delete`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Load endpoints
  // Note: Load endpoints return unwrapped responses (arrays/objects directly, not { success, data })
  async getLoadState(): Promise<LoadState[]> {
    // This endpoint returns LoadState[] directly, not wrapped
    return this.request<LoadState[]>('/api/loads/state');
  }

  async getDroppedLoads(gameId?: string): Promise<Array<{city_name: string, type: LoadType}>> {
    // This endpoint returns array directly, not wrapped
    const endpoint = gameId ? `/api/loads/dropped?gameId=${gameId}` : '/api/loads/dropped';
    return this.request<Array<{city_name: string, type: LoadType}>>(endpoint);
  }

  async pickupLoad(data: { loadType: LoadType; city: string; gameId: string; isDropped: boolean }): Promise<{
    loadState: LoadState;
    droppedLoads: Array<{ city_name: string; type: LoadType }>;
  }> {
    // This endpoint returns { loadState, droppedLoads } directly, not wrapped
    return this.request<{
      loadState: LoadState;
      droppedLoads: Array<{ city_name: string; type: LoadType }>;
    }>('/api/loads/pickup', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async returnLoad(data: { loadType: LoadType; gameId: string; city?: string }): Promise<{
    loadState: LoadState;
    droppedLoads: Array<{ city_name: string; type: LoadType }>;
  }> {
    // This endpoint returns { loadState, droppedLoads } directly, not wrapped
    // Note: city is optional for backward compatibility
    return this.request<{
      loadState: LoadState;
      droppedLoads: Array<{ city_name: string; type: LoadType }>;
    }>('/api/loads/return', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async setLoadInCity(data: { city: string; loadType: LoadType; gameId: string }): Promise<{
    loadState: LoadState;
    droppedLoads: Array<{ city_name: string; type: LoadType }>;
  }> {
    // This endpoint returns { loadState, droppedLoads } directly, not wrapped
    return this.request<{
      loadState: LoadState;
      droppedLoads: Array<{ city_name: string; type: LoadType }>;
    }>('/api/loads/setInCity', {
      method: 'POST',
      body: JSON.stringify(data),
    });
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
    GAME_NOT_AVAILABLE: 'Game is no longer available',
    FORBIDDEN: 'Access forbidden',
    NEW_OWNER_NOT_ONLINE: 'Selected new owner must be online',
    
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