// shared/config.ts
// Configuration utility to handle environment variables safely

interface Config {
  apiBaseUrl: string;
  socketUrl: string;
  isDevelopment: boolean;
  debugEnabled: boolean;
}

function getEnvVar(key: string, defaultValue: string): string {
  // For webpack, we can access process.env directly
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key] || defaultValue;
  }
  
  // Fallback for browser environment
  return defaultValue;
}

export const config: Config = {
  apiBaseUrl: getEnvVar('VITE_API_BASE_URL', 'http://localhost:3000'),
  socketUrl: getEnvVar('VITE_SOCKET_URL', 'http://localhost:3000'),
  isDevelopment: process.env.NODE_ENV === 'development',
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