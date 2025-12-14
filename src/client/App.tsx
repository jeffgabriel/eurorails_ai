import React, { Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './lobby/store/auth.store';
import { LoginPage } from './lobby/features/auth/LoginPage';
import { RegisterPage } from './lobby/features/auth/RegisterPage';
import { LobbyPage } from './lobby/features/lobby/LobbyPage';
import { NotFound } from './lobby/shared/NotFound';
import { ErrorBoundary } from './lobby/shared/ErrorBoundary';
import { Toaster } from './lobby/components/ui/sonner';
import { debug } from './lobby/shared/config';
import './lobby/index.css';

// Lazy load the standalone game component
const StandaloneGame = React.lazy(() => import('./game/StandaloneGame').then(module => ({ default: module.StandaloneGame })));

interface ProtectedRouteProps {
  children: React.ReactNode;
}

function ProtectedRoute({ children }: ProtectedRouteProps) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const devAuthEnabled = process.env.REACT_APP_DEV_AUTH === 'true';

  // Only allow development bypass for localhost when explicitly enabled
  const isLocalhost = typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  if (!isAuthenticated && !(devAuthEnabled && isLocalhost)) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

interface PublicRouteProps {
  children: React.ReactNode;
}

function PublicRoute({ children }: PublicRouteProps) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  
  if (isAuthenticated) {
    return <Navigate to="/lobby" replace />;
  }
  
  return <>{children}</>;
}

export default function App() {
  const { loadPersistedAuth, isLoading } = useAuthStore();
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);

  useEffect(() => {
    // IMPORTANT:
    // On a hard refresh of a protected deep-link (e.g. /game/:id), React renders once
    // before effects run. If we render routes immediately, ProtectedRoute will redirect
    // while isAuthenticated is still false, causing a replace() navigation back to /login
    // then /lobby. That looks like "refresh always returns to lobby" and also wipes
    // /game/:id from browser history.
    const initializeApp = async () => {
      debug.log('App starting, loading persisted auth...');
      try {
        await loadPersistedAuth();
      } catch (error) {
        debug.error('Error loading persisted auth:', error);
      } finally {
        setInitialLoadComplete(true);
      }

      debug.log('Current location:', window.location.href);
    };

    initializeApp();
  }, [loadPersistedAuth]);

  // Block initial routing until auth hydration completes to prevent deep-link refresh redirects.
  if (!initialLoadComplete || isLoading) {
    return (
      <div className="size-full flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="size-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-muted-foreground">Loading EuroRails...</p>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="size-full bg-background text-foreground">
        <BrowserRouter>
          <Routes>
            <Route
              path="/login"
              element={
                <PublicRoute>
                  <ErrorBoundary>
                    <LoginPage />
                  </ErrorBoundary>
                </PublicRoute>
              }
            />
            <Route
              path="/register"
              element={
                <PublicRoute>
                  <ErrorBoundary>
                    <RegisterPage />
                  </ErrorBoundary>
                </PublicRoute>
              }
            />
            <Route
              path="/lobby/game/:gameId"
              element={
                <ProtectedRoute>
                  <ErrorBoundary>
                    <LobbyPage />
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            />
            <Route
              path="/lobby"
              element={
                <ProtectedRoute>
                  <ErrorBoundary>
                    <LobbyPage />
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            />
            <Route
              path="/game/:id"
              element={
                <ProtectedRoute>
                  <ErrorBoundary>
                    <Suspense fallback={
                      <div className="size-full flex items-center justify-center bg-background">
                        <div className="flex flex-col items-center gap-4">
                          <div className="size-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                          <p className="text-muted-foreground">Loading game...</p>
                        </div>
                      </div>
                    }>
                      <StandaloneGame />
                    </Suspense>
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            />
            <Route path="/" element={<Navigate to="/lobby" replace />} />
            
            {/* Handle preview_page.html specifically */}
            <Route 
              path="/preview_page.html" 
              element={<Navigate to="/lobby" replace />} 
            />
            
            {/* Catch-all route for unknown paths */}
            <Route 
              path="*" 
              element={<NotFound />} 
            />
          </Routes>
        </BrowserRouter>
        <Toaster />
      </div>
    </ErrorBoundary>
  );
}
