import { useEffect } from 'react';
import { Router } from './app/Router';
import { useAuthStore } from './store/auth.store';
import { useLobbyStore } from './store/lobby.store';
import { Toaster } from './components/ui/sonner';
import { ErrorBoundary } from './shared/ErrorBoundary';
import { debug } from './shared/config';

export default function App() {
  const { loadPersistedAuth, isLoading: authLoading } = useAuthStore();
  const { restoreGameState, isLoading: lobbyLoading } = useLobbyStore();

  useEffect(() => {
    // Load persisted authentication on app start
    debug.log('App starting, loading persisted auth...');

    try {
      loadPersistedAuth();
    } catch (error) {
      debug.error('Error loading persisted auth:', error);
    }

    // Log current location for debugging route issues
    debug.log('Current location:', window.location.href);
  }, [loadPersistedAuth]);

  // Restore game state on app load (after auth is loaded)
  useEffect(() => {
    if (!authLoading) {
      // Try to restore game state from localStorage
      restoreGameState().catch(error => {
        console.warn('Failed to restore game state on app load:', error);
      });
    }
  }, [authLoading, restoreGameState]);

  const isLoading = authLoading || lobbyLoading;

  if (isLoading) {
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
        <Router />
        <Toaster />
      </div>
    </ErrorBoundary>
  );
}