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

export const useAuthStore = create<AuthStore>((set, get) => ({
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
    const isDevelopment = import.meta.env.DEV;
    
    // In development mode, set authenticated state without API validation
    if (isDevelopment) {
      set({
        user: { id: 'dev-user', username: 'dev-user', email: 'dev@example.com' },
        token: 'dev-token',
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
      return;
    }
    
    if (!token || !userJson) {
      return;
    }

    try {
      const user = JSON.parse(userJson);
      
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
    set({
      user: { id: 'dev-user', username: 'dev-user', email: 'dev@example.com' },
      token: 'dev-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });
  },
}));