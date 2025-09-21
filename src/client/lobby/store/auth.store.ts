// store/auth.store.ts
import { create } from 'zustand';
import type { User, AuthResult, LoginForm, RegisterForm, ApiError } from '../shared/types';
import { api } from '../shared/api';

interface AuthState {
  user: User | null;
  token: string | null;
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
}

type AuthStore = AuthState & AuthActions;

const JWT_STORAGE_KEY = 'eurorails.jwt';
const USER_STORAGE_KEY = 'eurorails.user';

export const useAuthStore = create<AuthStore>((set) => ({
  // Initial state
  user: null,
  token: null,
  isLoading: false,
  error: null,
  isAuthenticated: false,

  // Actions
  login: async (credentials: LoginForm) => {
    set({ isLoading: true, error: null });
    
    try {
      const result: AuthResult = await api.login(credentials);
      
      // Persist auth data
      localStorage.setItem(JWT_STORAGE_KEY, result.token);
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(result.user));
      
      set({
        user: result.user,
        token: result.token,
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

  register: async (userData: RegisterForm) => {
    set({ isLoading: true, error: null });
    
    try {
      const result: AuthResult = await api.register(userData);
      
      // Persist auth data
      localStorage.setItem(JWT_STORAGE_KEY, result.token);
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(result.user));
      
      set({
        user: result.user,
        token: result.token,
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
    // Clear persisted data
    localStorage.removeItem(JWT_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);
    
    set({
      user: null,
      token: null,
      isAuthenticated: false,
      error: null,
    });
  },

  loadPersistedAuth: async () => {
    const token = localStorage.getItem(JWT_STORAGE_KEY);
    const userJson = localStorage.getItem(USER_STORAGE_KEY);
    const isDevelopment = process.env.NODE_ENV === 'development';
    
    // In development mode, only set authenticated state for localhost
    if (isDevelopment && typeof window !== 'undefined') {
      const isLocalhost = window.location.hostname === 'localhost' || 
                         window.location.hostname === '127.0.0.1';
      
      if (isLocalhost) {
        const devUser = { id: '123e4567-e89b-12d3-a456-426614174000', username: 'dev-user', email: 'dev@example.com' };
        
        // Store in localStorage for API client
        localStorage.setItem('eurorails.jwt', 'dev-token');
        localStorage.setItem('eurorails.user', JSON.stringify(devUser));
        
        set({
          user: devUser,
          token: 'dev-token',
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
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      // Token is invalid, clear storage
      localStorage.removeItem(JWT_STORAGE_KEY);
      localStorage.removeItem(USER_STORAGE_KEY);
      
      set({
        user: null,
        token: null,
        isAuthenticated: false,
        isLoading: false,
        error: error as ApiError,
      });
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
        const devUser = { id: '123e4567-e89b-12d3-a456-426614174000', username: 'dev-user', email: 'dev@example.com' };
        
        // Also store in localStorage for API client
        localStorage.setItem('eurorails.jwt', 'dev-token');
        localStorage.setItem('eurorails.user', JSON.stringify(devUser));
        
        set({
          user: devUser,
          token: 'dev-token',
          isAuthenticated: true,
          isLoading: false,
          error: null,
        });
      }
    }
  },
}));