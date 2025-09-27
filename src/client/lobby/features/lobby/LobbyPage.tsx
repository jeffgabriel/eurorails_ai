// features/lobby/LobbyPage.tsx
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, Users, LogOut, Play } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Separator } from '../../components/ui/separator';
import { CreateGameModal } from './CreateGameModal';
import { JoinGameModal } from './JoinGameModal';
import { GameRow } from './GameRow';
import { useAuthStore } from '../../store/auth.store';
import { useLobbyStore } from '../../store/lobby.store';
import { getErrorMessage } from '../../shared/api';

export function LobbyPage() {
  const navigate = useNavigate();
  const { gameId } = useParams<{ gameId?: string }>();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  
  const { user, logout } = useAuthStore();
  const { 
    currentGame, 
    players, 
    isLoading, 
    error, 
    clearError,
    leaveGame,
    loadGameFromUrl,
    restoreGameState
  } = useLobbyStore();
  
  // Get function to access store state
  const get = useLobbyStore.getState;

  useEffect(() => {
    if (error) {
      toast.error(getErrorMessage(error));
      clearError();
    }
  }, [error, clearError]);

  // State recovery on component mount
  useEffect(() => {
    const recoverState = async () => {
      // Check if we have a current game and it's active
      if (currentGame && currentGame.status === 'ACTIVE') {
        navigate(`/game/${currentGame.id}`);
        return;
      }
      
      if (gameId && !currentGame) {
        // Load from URL
        try {
          await loadGameFromUrl(gameId);
          
          // Validate the loaded game
          const game = get().currentGame;
          if (!game) {
            throw new Error('Game not found');
          }
          
          // Validate game properties
          if (!game.id || !game.joinCode || !game.status) {
            throw new Error('Invalid game data');
          }
          
          // Check if game is accessible (not abandoned or completed)
          if (game.status === 'ABANDONED' || game.status === 'COMPLETE') {
            toast.error('This game is no longer available');
            navigate('/lobby');
            return;
          }
          
          // If game is active, redirect to the game
          if (game.status === 'ACTIVE') {
            navigate(`/game/${game.id}`);
            return;
          }
          
        } catch (error) {
          // If URL load fails, try localStorage
          const restored = await restoreGameState();
          if (!restored) {
            // If both fail, redirect to main lobby
            toast.error('Game not found. Redirecting to lobby...');
            navigate('/lobby');
          }
        }
      } else if (!gameId && !currentGame) {
        // Try to restore from localStorage
        const restored = await restoreGameState();
        if (restored) {
          // Get the updated currentGame from the store
          const updatedGame = get().currentGame;
          if (updatedGame) {
            // Only redirect if we're not already on a game route
            const currentPath = window.location.pathname;
            if (!currentPath.startsWith('/game/')) {
              // Redirect to lobby with game ID
              navigate(`/lobby/game/${updatedGame.id}`);
            }
          }
        }
      }
    };
    
    recoverState();
  }, [gameId]);

  // Navigate to lobby with game ID when currentGame changes (from create/join operations)
  useEffect(() => {
    if (currentGame && !gameId) {
      // Only redirect if we're not already on a game route
      const currentPath = window.location.pathname;
      if (!currentPath.startsWith('/game/')) {
        // We have a current game but no gameId in URL - navigate to lobby with game ID
        navigate(`/lobby/game/${currentGame.id}`, { replace: true });
      }
    }
  }, [currentGame, gameId, navigate]);

  const handleStartGame = async () => {
    if (!currentGame) return;

    // Just navigate to the game setup - don't call the start game API
    toast.success('Going to game setup!');
    navigate(`/game/${currentGame.id}`);
  };

  const handleLeaveGame = () => {
    leaveGame();
    toast.info('Left the game');
    // Navigate back to main lobby page
    navigate('/lobby');
  };

  const handleLogout = () => {
    logout();
    toast.info('Logged out successfully');
  };

  const canStartGame = currentGame && 
    currentGame.createdBy === user?.id && 
    currentGame.status === 'IN_SETUP' &&
    players.length >= 2; // Minimum players needed

  // Show loading state when recovering game state
  if (isLoading && !currentGame) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="size-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-muted-foreground">
            {gameId ? 'Loading game...' : 'Restoring game state...'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-accent">EuroRails</h1>
            <p className="text-sm text-muted-foreground">
              Welcome, {user?.username}
            </p>
            {process.env.NODE_ENV === 'development' && (
              <p className="text-xs text-orange-600 bg-orange-100 px-2 py-1 rounded mt-1 inline-block">
                🧪 Development Mode - Using Mock Data
              </p>
            )}
          </div>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleLogout}
          >
            <LogOut className="size-4 mr-2" />
            Logout
          </Button>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {!currentGame ? (
          // No current game - show create/join options
          <div className="space-y-8">
            <div className="text-center">
              <h2 className="text-3xl font-bold mb-4">Ready to Play?</h2>
              <p className="text-muted-foreground mb-8">
                Create a new game or join an existing one to start building your railway empire.
              </p>
              
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Button 
                  size="lg"
                  onClick={() => setShowCreateModal(true)}
                  disabled={isLoading}
                >
                  <Plus className="size-5 mr-2" />
                  Create New Game
                </Button>
                
                <Button 
                  variant="outline" 
                  size="lg"
                  onClick={() => setShowJoinModal(true)}
                  disabled={isLoading}
                >
                  <Users className="size-5 mr-2" />
                  Join Game
                </Button>
              </div>
            </div>

            {/* Game Rules / Info */}
            <Card>
              <CardHeader>
                <CardTitle>How to Play</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="text-center">
                    <div className="size-12 bg-accent/10 rounded-lg flex items-center justify-center mx-auto mb-3">
                      <Plus className="size-6 text-accent" />
                    </div>
                    <h3 className="font-semibold mb-2">Create Game</h3>
                    <p className="text-sm text-muted-foreground">
                      Start a new railway network and invite friends with a join code
                    </p>
                  </div>
                  
                  <div className="text-center">
                    <div className="size-12 bg-accent/10 rounded-lg flex items-center justify-center mx-auto mb-3">
                      <Users className="size-6 text-accent" />
                    </div>
                    <h3 className="font-semibold mb-2">Build Railways</h3>
                    <p className="text-sm text-muted-foreground">
                      Construct tracks across Europe to connect cities and deliver cargo
                    </p>
                  </div>
                  
                  <div className="text-center">
                    <div className="size-12 bg-accent/10 rounded-lg flex items-center justify-center mx-auto mb-3">
                      <Play className="size-6 text-accent" />
                    </div>
                    <h3 className="font-semibold mb-2">Win the Game</h3>
                    <p className="text-sm text-muted-foreground">
                      Complete deliveries and expand your network to achieve victory
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Development Mode - Available Test Games */}
            {process.env.NODE_ENV === 'development' && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    🧪 Development Mode
                  </CardTitle>
                  <CardDescription>
                    Available test games for development and testing
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="p-4 border rounded-lg">
                      <h4 className="font-semibold mb-2">Game ABC123</h4>
                      <p className="text-sm text-muted-foreground mb-2">Created by dev-user</p>
                      <Badge variant="secondary" className="mb-2">IN_SETUP</Badge>
                      <p className="text-xs text-muted-foreground">2/4 players</p>
                    </div>
                    
                    <div className="p-4 border rounded-lg">
                      <h4 className="font-semibold mb-2">Game DEF456</h4>
                      <p className="text-sm text-muted-foreground mb-2">Created by other-user</p>
                      <Badge variant="secondary" className="mb-2">IN_SETUP</Badge>
                      <p className="text-xs text-muted-foreground">2/3 players</p>
                    </div>
                    
                    <div className="p-4 border rounded-lg">
                      <h4 className="font-semibold mb-2">Game GHI789</h4>
                      <p className="text-sm text-muted-foreground mb-2">Created by dev-user</p>
                      <Badge variant="default" className="mb-2">ACTIVE</Badge>
                      <p className="text-xs text-muted-foreground">3/4 players</p>
                    </div>
                  </div>
                  
                  <div className="p-4 bg-muted rounded-lg">
                    <h4 className="font-medium mb-2">Test Instructions:</h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Use join code <strong>ABC123</strong> to join a game in setup</li>
                      <li>• Use join code <strong>DEF456</strong> to join another game</li>
                      <li>• Try joining <strong>GHI789</strong> (will show "already started" error)</li>
                      <li>• Create a new game to test the full flow</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        ) : (
          // Current game - show waiting room
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Game Lobby</CardTitle>
                    <CardDescription>
                      Waiting for players to join...
                    </CardDescription>
                  </div>
                  <Badge variant={currentGame.status === 'IN_SETUP' ? 'secondary' : 'default'}>
                    {currentGame.status === 'IN_SETUP' ? 'Setting Up' : currentGame.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                  <div>
                    <p className="font-medium">Join Code</p>
                    <p className="text-2xl font-mono font-bold text-accent">
                      {currentGame.joinCode}
                    </p>
                  </div>
                  <Button 
                    variant="outline"
                    onClick={() => {
                      navigator.clipboard.writeText(currentGame.joinCode);
                      toast.success('Join code copied!');
                    }}
                  >
                    Copy Code
                  </Button>
                </div>

                <Separator />

                <div>
                  <h3 className="font-semibold mb-4 flex items-center gap-2">
                    <Users className="size-4" />
                    Players ({players.length}/{currentGame.maxPlayers})
                  </h3>
                  
                  <div className="space-y-2">
                    {players.length === 0 ? (
                      <p className="text-muted-foreground text-center py-4">
                        No players yet. Share the join code to invite others!
                      </p>
                    ) : (
                      players.map((player) => (
                        <GameRow key={player.id} player={player} />
                      ))
                    )}
                  </div>
                </div>

                <div className="flex gap-2">
                  {canStartGame && (
                    <Button 
                      onClick={handleStartGame}
                      disabled={isLoading}
                      className="flex-1"
                    >
                      <Play className="size-4 mr-2" />
                      {isLoading ? 'Starting...' : 'Start Game'}
                    </Button>
                  )}
                  
                  <Button 
                    variant="outline" 
                    onClick={handleLeaveGame}
                  >
                    Leave Game
                  </Button>
                </div>

                {!canStartGame && currentGame.status === 'IN_SETUP' && (
                  <p className="text-sm text-muted-foreground text-center">
                    {currentGame.createdBy !== user?.id 
                      ? 'Waiting for the game creator to start the game...'
                      : players.length < 2
                      ? 'Need at least 2 players to start the game'
                      : 'Ready to start!'
                    }
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Modals */}
      <CreateGameModal 
        open={showCreateModal}
        onOpenChange={setShowCreateModal}
      />
      
      <JoinGameModal 
        open={showJoinModal}
        onOpenChange={setShowJoinModal}
      />
    </div>
  );
}