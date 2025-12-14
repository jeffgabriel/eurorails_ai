// store/auth.store.ts
import { create } from 'zustand';
import type { User, AuthResult, LoginForm, RegisterForm, ApiError } from '../shared/types';
import { api } from '../shared/api';

interface AuthState {
  user: User | null;
  token: string | null;
  refreshToken: string | null;
  isLoading: boolean;
  error: ApiError | null;
  isAuthenticated: boolean;
}

interface AuthActions {
  login: (credentials: LoginForm) => Promise<void>;
  register: (userData: RegisterForm) => Promise<void>;
  logout: () => void;
  loadPersistedAuth: () => Promise<void>;
  clearError: () => void;
  setDevAuth: () => void;
  refreshAccessToken: () => Promise<boolean>;
}

type AuthStore = AuthState & AuthActions;

const JWT_STORAGE_KEY = 'eurorails.jwt';
const USER_STORAGE_KEY = 'eurorails.user';
const REFRESH_TOKEN_STORAGE_KEY = 'eurorails.refreshToken';

export const useAuthStore = create<AuthStore>((set, get) => ({
  // Initial state
  user: null,
  token: null,
  refreshToken: null,
  isLoading: false,
  error: null,
  isAuthenticated: false,

  // Actions
  login: async (credentials: LoginForm) => {
    set({ isLoading: true, error: null });

    try {
      const result: AuthResult = await api.login(credentials);

      // Persist auth data including refresh token
      localStorage.setItem(JWT_STORAGE_KEY, result.token);
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(result.user));
      if (result.refreshToken) {
        localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, result.refreshToken);
      }

      set({
        user: result.user,
        token: result.token,
        refreshToken: result.refreshToken || null,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      // Clear any existing auth data on login failure
      localStorage.removeItem(JWT_STORAGE_KEY);
      localStorage.removeItem(USER_STORAGE_KEY);
      localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);

      set({
        user: null,
        token: null,
        refreshToken: null,
        isLoading: false,
        error: error as ApiError,
        isAuthenticated: false,
      });
      throw error;
    }
  },

  register: async (userData: RegisterForm) => {
    set({ isLoading: true, error: null });
    
    try {
      const result: AuthResult = await api.register(userData);
      
      // Persist auth data including refresh token
      localStorage.setItem(JWT_STORAGE_KEY, result.token);
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(result.user));
      if (result.refreshToken) {
        localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, result.refreshToken);
      }
      
      set({
        user: result.user,
        token: result.token,
        refreshToken: result.refreshToken || null,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error as ApiError,
        isAuthenticated: false,
      });
      throw error;
    }
  },

  logout: () => {
    // Clear persisted data including refresh token
    localStorage.removeItem(JWT_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);
    localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
    
    set({
      user: null,
      token: null,
      refreshToken: null,
      isAuthenticated: false,
      error: null,
    });
  },

  refreshAccessToken: async (): Promise<boolean> => {
    const refreshToken = get().refreshToken || localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);
    
    if (!refreshToken) {
      console.warn('No refresh token available for refresh');
      return false;
    }

    try {
      const result = await api.refreshToken(refreshToken);
      
      // Update stored tokens
      localStorage.setItem(JWT_STORAGE_KEY, result.token);
      if (result.refreshToken) {
        localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, result.refreshToken);
      }
      
      set({
        token: result.token,
        refreshToken: result.refreshToken || refreshToken,
        isAuthenticated: true,
      });
      
      return true;
    } catch (error) {
      console.error('Failed to refresh token:', error);
      // Clear auth on refresh failure
      get().logout();
      return false;
    }
  },

  loadPersistedAuth: async () => {
    const token = localStorage.getItem(JWT_STORAGE_KEY);
    const userJson = localStorage.getItem(USER_STORAGE_KEY);
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);
    const devAuthEnabled = process.env.REACT_APP_DEV_AUTH === 'true';

    // In dev auth mode, only set authenticated state for localhost
    if (devAuthEnabled && typeof window !== 'undefined') {
      const isLocalhost = window.location.hostname === 'localhost' ||
                         window.location.hostname === '127.0.0.1';

      if (isLocalhost) {
        const devUser = {
          id: '123e4567-e89b-12d3-a456-426614174000',
          username: 'dev-user',
          email: 'dev@example.com',
          emailVerified: true,
          createdAt: new Date(),
          lastActive: new Date()
        };

        // Store in localStorage for API client
        localStorage.setItem('eurorails.jwt', 'dev-token');
        localStorage.setItem('eurorails.user', JSON.stringify(devUser));

        set({
          user: devUser,
          token: 'dev-token',
          refreshToken: null,
          isAuthenticated: true,
          isLoading: false,
          error: null,
        });
        return;
      }
    }
    
    if (!token || !userJson) {
      return;
    }

    try {
      // Validate token is still valid by making an API call
      set({ isLoading: true });
      const currentUser = await api.getCurrentUser();
      
      set({
        user: currentUser,
        token,
        refreshToken: refreshToken || null,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      const apiError = error as ApiError;
      
      // Check for authentication errors
      const isAuthError = apiError.error === 'UNAUTHORIZED' ||
                         apiError.error === 'HTTP_401' || 
                         apiError.error === 'HTTP_403' ||
                         apiError.message?.toLowerCase().includes('unauthorized') ||
                         apiError.message?.toLowerCase().includes('forbidden') ||
                         apiError.message?.toLowerCase().includes('invalid') ||
                         apiError.message?.toLowerCase().includes('expired');
      
      if (isAuthError && refreshToken) {
        // Try to refresh the token
        const refreshed = await get().refreshAccessToken();
        if (refreshed) {
          // Retry getting current user
          try {
            const currentUser = await api.getCurrentUser();
            set({
              user: currentUser,
              isAuthenticated: true,
              isLoading: false,
              error: null,
            });
            return;
          } catch (retryError) {
            // Refresh worked but getCurrentUser failed - clear auth
            get().logout();
            return;
          }
        }
      }
      
      if (isAuthError) {
        console.warn('Invalid or expired auth token, clearing storage');
        get().logout();
      } else {
        // For network errors, clear auth for security
        console.warn('Server not available or network error - clearing auth state for security');
        get().logout();
      }
    }
  },

  clearError: () => {
    set({ error: null });
  },

  setDevAuth: () => {
    // Only allow dev auth for localhost in development mode
    if (typeof window !== 'undefined') {
      const isLocalhost = window.location.hostname === 'localhost' || 
                         window.location.hostname === '127.0.0.1';
      
      if (isLocalhost) {
        const devUser = { 
          id: '123e4567-e89b-12d3-a456-426614174000', 
          username: 'dev-user', 
          email: 'dev@example.com',
          emailVerified: true,
          createdAt: new Date(),
          lastActive: new Date()
        };
        
        // Also store in localStorage for API client
        localStorage.setItem('eurorails.jwt', 'dev-token');
        localStorage.setItem('eurorails.user', JSON.stringify(devUser));
        
        set({
          user: devUser,
          token: 'dev-token',
          refreshToken: null,
          isAuthenticated: true,
          isLoading: false,
          error: null,
        });
      }
    }
  },
}));