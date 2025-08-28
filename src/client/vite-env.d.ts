// Environment variable types for webpack
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV: 'development' | 'production' | 'test';
      VITE_APP_TITLE?: string;
      VITE_API_URL?: string;
      VITE_DEBUG?: string;
    }
  }
}

export {};
