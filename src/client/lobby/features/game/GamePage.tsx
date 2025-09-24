// features/game/GamePage.tsx
import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Wifi, WifiOff } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { PhaserCanvas } from './PhaserCanvas';
import { PlayerSidebar } from './PlayerSidebar';
import { TurnIndicator } from './TurnIndicator';
import { Toasts } from './Toasts';
import { useAuthStore } from '../../store/auth.store';
import { useGameStore } from '../../store/game.store';
import { getErrorMessage } from '../../shared/api';

const isDevelopment = process.env.NODE_ENV === 'development';

export function GamePage() {
  const { id: gameId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  
  const { user, token } = useAuthStore();
  const { 
    gameState, 
    isConnected, 
    isLoading, 
    error, 
    connectionStatus,
    connect, 
    disconnect,
    clearError 
  } = useGameStore();

  useEffect(() => {
    // Skip auth check in development mode
    if (isDevelopment) {
      // Create mock game state for development
      return;
    }

    if (!gameId || !token) {
      navigate('/lobby');
      return;
    }

    // Connect to game
    connect(gameId, token);

    // Cleanup on unmount
    return () => {
      disconnect();
    };
  }, [gameId, token, connect, disconnect, navigate, isDevelopment]);

  useEffect(() => {
    if (error) {
      toast.error(getErrorMessage(error));
      clearError();
    }
  }, [error, clearError]);

  const handleBackToLobby = () => {
    navigate('/lobby');
  };

  if (!gameId) {
    return null;
  }

  if (isLoading || !gameState) {
    return (
      <div className="size-full flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="size-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-muted-foreground">
            {connectionStatus === 'connecting' ? 'Connecting to game...' : 
             connectionStatus === 'reconnecting' ? 'Reconnecting...' : 
             'Loading game...'}
          </p>
        </div>
      </div>
    );
  }


  return (
    <div className="size-full bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleBackToLobby}
          >
            <ArrowLeft className="size-4 mr-2" />
            Back to Lobby
          </Button>
          
          <div className="text-sm text-muted-foreground">
            Game ID: {gameId}
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Connection status */}
          <div className="flex items-center gap-2">
            {isConnected ? (
              <Wifi className="size-4 text-green-500" />
            ) : (
              <WifiOff className="size-4 text-red-500" />
            )}
            <span className="text-sm text-muted-foreground">
              {connectionStatus === 'connected' ? 'Connected' : 
               connectionStatus === 'connecting' ? 'Connecting' :
               connectionStatus === 'reconnecting' ? 'Reconnecting' :
               'Disconnected'}
            </span>
          </div>

          <TurnIndicator />
        </div>
      </header>

      {/* Main game area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Game canvas */}
        <div className="flex-1 relative">
          <PhaserCanvas gameState={gameState} />
        </div>

        {/* Right sidebar - players and game info */}
        <div className="w-80 border-l border-border bg-card">
          <PlayerSidebar gameState={gameState} />
        </div>
      </div>

      {/* Toast notifications */}
      <Toasts />
    </div>
  );
}