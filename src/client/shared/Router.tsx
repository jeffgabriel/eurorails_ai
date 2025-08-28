import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuthStore } from '../lobby/store/auth.store';
import { LoginPage } from '../lobby/features/auth/LoginPage';
import { RegisterPage } from '../lobby/features/auth/RegisterPage';
import { LobbyPage } from '../lobby/features/lobby/LobbyPage';
import { GamePage } from '../lobby/features/game/GamePage';
import { NotFound } from '../lobby/shared/NotFound';
import { ErrorBoundary } from '../lobby/shared/ErrorBoundary';
import { debug } from '../lobby/shared/config';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

function ProtectedRoute({ children }: ProtectedRouteProps) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isDevelopment = import.meta.env?.DEV || process.env.NODE_ENV === 'development';
  
  // Allow access in development mode or if authenticated
  if (!isAuthenticated && !isDevelopment) {
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
                <GamePage />
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
