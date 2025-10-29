import { useEffect, useState } from 'react';
import { Router } from './app/Router';
import { useAuthStore } from './store/auth.store';
import { useLobbyStore } from './store/lobby.store';
import { Toaster } from './components/ui/sonner';
import { ErrorBoundary } from './shared/ErrorBoundary';
import { debug } from './shared/config';

export default function App() {
  console.log('[App] Rendering');
  const { loadPersistedAuth } = useAuthStore();
  const { restoreGameState } = useLobbyStore();
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);

  useEffect(() => {
    // Load persisted authentication on app start
    debug.log('App starting, loading persisted auth...');

    const initializeApp = async () => {
      try {
        await loadPersistedAuth();
        await restoreGameState().catch(error => {
          console.warn('Failed to restore game state on app load:', error);
        });
      } catch (error) {
        debug.error('Error loading persisted auth:', error);
      } finally {
        console.log('[App] Initial load complete, showing router');
        setInitialLoadComplete(true);
      }

      // Log current location for debugging route issues
      debug.log('Current location:', window.location.href);
    };

    initializeApp();
  }, [loadPersistedAuth, restoreGameState]);

  useEffect(() => {
    console.log('[App] initialLoadComplete:', initialLoadComplete);
  }, [initialLoadComplete]);

  if (!initialLoadComplete) {
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