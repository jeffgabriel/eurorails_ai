// app/Router.tsx
import React, { useEffect, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/auth.store';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { LobbyPage } from '../features/lobby/LobbyPage';
import { NotFound } from '../shared/NotFound';
import { ErrorBoundary } from '../shared/ErrorBoundary';
import { debug } from '../shared/config';

// GamePage component was removed - games are now handled by the main App.tsx

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

function LocationLogger() {
  const location = useLocation();
  
  useEffect(() => {
    debug.log('Navigating to:', location.pathname + location.search);
  }, [location]);
  
  return null;
}

export function Router() {
  return (
    <BrowserRouter>
      <LocationLogger />
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
                <div className="size-full flex items-center justify-center bg-background">
                  <div className="flex flex-col items-center gap-4">
                    <p className="text-muted-foreground">Game functionality moved to main app</p>
                    <button 
                      onClick={() => window.location.href = '/game/' + window.location.pathname.split('/').pop()}
                      className="px-4 py-2 bg-accent text-accent-foreground rounded"
                    >
                      Go to Game
                    </button>
                  </div>
                </div>
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
  );
}