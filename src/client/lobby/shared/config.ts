// shared/config.ts
// Configuration utility to handle environment variables safely

interface Config {
  apiBaseUrl: string;
  socketUrl: string;
  isDevelopment: boolean;
  debugEnabled: boolean;
}

// Runtime configuration interface (injected via window for production deployments)
declare global {
  interface Window {
    __APP_CONFIG__?: {
      apiBaseUrl?: string;
      socketUrl?: string;
      debugEnabled?: boolean;
    };
  }
}

function getEnvVar(key: string, defaultValue: string): string {
  // 1. Check for runtime configuration (window.__APP_CONFIG__) first
  //    This allows deployment to inject config without rebuilding
  if (typeof window !== 'undefined' && window.__APP_CONFIG__) {
    const runtimeConfig = window.__APP_CONFIG__;
    if (key === 'VITE_API_BASE_URL' && runtimeConfig.apiBaseUrl) {
      return runtimeConfig.apiBaseUrl;
    }
    if (key === 'VITE_SOCKET_URL' && runtimeConfig.socketUrl) {
      return runtimeConfig.socketUrl;
    }
    if (key === 'VITE_DEBUG' && runtimeConfig.debugEnabled !== undefined) {
      return runtimeConfig.debugEnabled.toString();
    }
  }
  
  // 2. Check build-time environment variables (injected by webpack DefinePlugin)
  if (typeof process !== 'undefined' && process.env) {
    const value = process.env[key];
    if (value !== undefined) {
      return value;
    }
  }
  
  // 3. Fallback to default value
  return defaultValue;
}

// Helper function to normalize URLs (ensure no trailing slash for base URLs)
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export const config: Config = {
  apiBaseUrl: normalizeBaseUrl(getEnvVar('VITE_API_BASE_URL', 'http://localhost:3001')),
  socketUrl: normalizeBaseUrl(getEnvVar('VITE_SOCKET_URL', 'http://localhost:3001')),
  // isDevelopment: Check NODE_ENV injected by webpack at build time
  // In production builds, this will be 'production', otherwise 'development' or undefined
  // Default to false (production) if not explicitly set to 'development' for safety
  isDevelopment: typeof process !== 'undefined' && process.env?.NODE_ENV === 'development',
  debugEnabled: getEnvVar('VITE_DEBUG', 'false') === 'true',
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