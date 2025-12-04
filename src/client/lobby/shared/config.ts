// shared/config.ts
// Configuration utility to handle environment variables safely

interface Config {
  apiBaseUrl: string;
  socketUrl: string;
  isDevelopment: boolean;
  debugEnabled: boolean;
}

// Runtime configuration interface (optional, for edge cases)
// Primary configuration should be set at build time via webpack DefinePlugin
declare global {
  interface Window {
    __APP_CONFIG__?: {
      apiBaseUrl?: string;
      socketUrl?: string;
      debugEnabled?: boolean;
    };
  }
}

// Helper to get API base URL with proper webpack DefinePlugin support
// Must use direct process.env access (not dynamic keys) so webpack can replace at build time
function getApiBaseUrl(): string {
  // 1. Check for runtime configuration (window.__APP_CONFIG__) first
  //    This is optional and primarily for edge cases where build-time config isn't available
  if (typeof window !== 'undefined' && window.__APP_CONFIG__?.apiBaseUrl) {
    console.log('[Config] Using runtime API base URL:', window.__APP_CONFIG__.apiBaseUrl);
    return window.__APP_CONFIG__.apiBaseUrl;
  }
  
  // 2. Check build-time environment variable (injected by webpack DefinePlugin)
  //    Must use direct property access so webpack can statically replace it
  //    This is the primary method for configuration in production
  if (typeof process !== 'undefined' && process.env?.VITE_API_BASE_URL) {
    console.log('[Config] Using build-time VITE_API_BASE_URL:', process.env.VITE_API_BASE_URL);
    return process.env.VITE_API_BASE_URL;
  }
  
  // 3. Fallback to default value
  console.log('[Config] Using default value for VITE_API_BASE_URL: http://localhost:3001');
  return 'http://localhost:3001';
}

// Helper to get Socket URL with proper webpack DefinePlugin support
function getSocketUrl(): string {
  // 1. Check for runtime configuration first
  if (typeof window !== 'undefined' && window.__APP_CONFIG__?.socketUrl) {
    console.log('[Config] Using runtime Socket URL:', window.__APP_CONFIG__.socketUrl);
    return window.__APP_CONFIG__.socketUrl;
  }
  
  // 2. Check build-time environment variable (injected by webpack DefinePlugin)
  if (typeof process !== 'undefined' && process.env?.VITE_SOCKET_URL) {
    console.log('[Config] Using build-time VITE_SOCKET_URL:', process.env.VITE_SOCKET_URL);
    return process.env.VITE_SOCKET_URL;
  }
  
  // 3. Fallback to API base URL or default
  const apiBaseUrl = getApiBaseUrl();
  if (apiBaseUrl !== 'http://localhost:3001') {
    return apiBaseUrl;
  }
  
  console.log('[Config] Using default value for VITE_SOCKET_URL: http://localhost:3001');
  return 'http://localhost:3001';
}

// Helper to get debug flag
function getDebugEnabled(): boolean {
  // 1. Check for runtime configuration first
  if (typeof window !== 'undefined' && window.__APP_CONFIG__?.debugEnabled !== undefined) {
    return window.__APP_CONFIG__.debugEnabled;
  }
  
  // 2. Check build-time environment variable (injected by webpack DefinePlugin)
  if (typeof process !== 'undefined' && process.env?.VITE_DEBUG) {
    return process.env.VITE_DEBUG === 'true';
  }
  
  // 3. Fallback to default
  return false;
}

// Helper function to normalize URLs (ensure no trailing slash for base URLs)
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

// Use getters to ensure config is read dynamically, not at module load time
// Build-time configuration (via webpack DefinePlugin) is the primary method
// Direct process.env property access is required so webpack can statically replace values
export const config: Config = {
  get apiBaseUrl(): string {
    return normalizeBaseUrl(getApiBaseUrl());
  },
  get socketUrl(): string {
    return normalizeBaseUrl(getSocketUrl());
  },
  // isDevelopment: Check NODE_ENV injected by webpack at build time
  // In production builds, this will be 'production', otherwise 'development' or undefined
  // Default to false (production) if not explicitly set to 'development' for safety
  get isDevelopment(): boolean {
    return typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
  },
  get debugEnabled(): boolean {
    return getDebugEnabled();
  },
};

// Debug logging utility
export const debug = {
  log: (...args: any[]) => {
    if (config.debugEnabled || config.isDevelopment) {
      console.log('[EuroRails Debug]', ...args);
    }
  },
  warn: (...args: any[]) => {
    if (config.debugEnabled || config.isDevelopment) {
      console.warn('[EuroRails Debug]', ...args);
    }
  },
  error: (...args: any[]) => {
    if (config.debugEnabled || config.isDevelopment) {
      console.error('[EuroRails Debug]', ...args);
    }
  },
};