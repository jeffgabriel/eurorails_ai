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

// Lazy load the GamePage component to avoid bundling Phaser until needed
const GamePage = React.lazy(() => import('../features/game/GamePage').then(module => ({ default: module.GamePage })));

interface ProtectedRouteProps {
  children: React.ReactNode;
}

function ProtectedRoute({ children }: ProtectedRouteProps) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  // Only allow development bypass for localhost in development mode
  const isLocalhost = typeof window !== 'undefined' && 
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  
  if (!isAuthenticated && !(isDevelopment && isLocalhost)) {
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
                <Suspense fallback={
                  <div className="size-full flex items-center justify-center bg-background">
                    <div className="flex flex-col items-center gap-4">
                      <div className="size-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                      <p className="text-muted-foreground">Loading game...</p>
                    </div>
                  </div>
                }>
                  <GamePage />
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
  );
}