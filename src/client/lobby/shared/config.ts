// shared/config.ts
// Configuration utility to handle environment variables safely

interface Config {
  apiBaseUrl: string;
  socketUrl: string;
  isDevelopment: boolean;
  debugEnabled: boolean;
}

function getEnvVar(key: string, defaultValue: string): string {
  if (typeof import.meta === 'undefined' || !import.meta.env) {
    return defaultValue;
  }
  
  return import.meta.env[key] || defaultValue;
}

export const config: Config = {
  apiBaseUrl: getEnvVar('VITE_API_BASE_URL', 'http://localhost:3000'),
  socketUrl: getEnvVar('VITE_SOCKET_URL', 'http://localhost:3000'),
  isDevelopment: getEnvVar('NODE_ENV', 'development') === 'development',
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