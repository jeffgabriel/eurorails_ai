// features/lobby/LobbyPage.tsx
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, Users, LogOut, Play } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Separator } from '../../components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { Checkbox } from '../../components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { CreateGameModal } from './CreateGameModal';
import { JoinGameModal } from './JoinGameModal';
import { GameRow } from './GameRow';
import { useAuthStore } from '../../store/auth.store';
import { useLobbyStore } from '../../store/lobby.store';
import { getErrorMessage, api } from '../../shared/api';

export function LobbyPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { gameId } = useParams<{ gameId?: string }>();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);

  // Active game delete/transfer dialog state
  const [activeDeleteGameId, setActiveDeleteGameId] = useState<string | null>(null);
  const [activeDeletePlayers, setActiveDeletePlayers] = useState<Array<{ userId: string; name: string; isOnline: boolean }> | null>(null);
  const [activeTransferToUserId, setActiveTransferToUserId] = useState<string | null>(null);

  // Archived multi-select delete state
  const [archivedSelectedIds, setArchivedSelectedIds] = useState<Set<string>>(new Set());
  const [showArchivedDeleteDialog, setShowArchivedDeleteDialog] = useState(false);
  const [hardDeleteOwnedArchived, setHardDeleteOwnedArchived] = useState(false);

  // Switch setup game dialog state (when a setup game is already loaded)
  const [showSwitchSetupDialog, setShowSwitchSetupDialog] = useState(false);
  const [switchToSetupGameId, setSwitchToSetupGameId] = useState<string | null>(null);
  
  const { user, logout, token } = useAuthStore();
  const { 
    currentGame, 
    players, 
    myGames,
    isLoadingMyGames,
    isLoading, 
    error, 
    clearError,
    leaveGame,
    loadGameFromUrl,
    restoreGameState,
    clearGameState,
    loadMyGames,
    connectToLobbySocket,
    disconnectFromLobbySocket,
    onGameStarted
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
          if (game.status === 'abandoned' || game.status === 'completed') {
            toast.error('This game is no longer available');
            navigate('/lobby');
            return;
          }
          
          // If game is active and not completed/abandoned, redirect to the game
          if (game.status === 'active' || game.status === 'initialBuild') {
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
      }
    };
    
    recoverState();
  }, [gameId]);

  // Ensure users can land on /lobby without being forced into a game/setup view.
  // If they're on the lobby home route, clear any persisted "current game" state.
  useEffect(() => {
    if (location.pathname === '/lobby' && currentGame) {
      clearGameState();
    }
  }, [location.pathname, currentGame, clearGameState]);

  // Socket connection for real-time lobby updates
  useEffect(() => {
    if (currentGame && currentGame.status === 'setup' && token) {
      // Connect to socket and join lobby room
      connectToLobbySocket(currentGame.id, token);
      
      // Listen for game started event
      onGameStarted((gameId) => {
        navigate(`/game/${gameId}`);
      });
      
      // Cleanup on unmount
      return () => {
        disconnectFromLobbySocket(currentGame.id);
      };
    }
  }, [currentGame?.id, currentGame?.status, token, connectToLobbySocket, disconnectFromLobbySocket, onGameStarted, navigate]);

  const handleStartGame = async () => {
    if (!currentGame || !user) return;

    try {
      // Call the API to start the game
      await api.startGame(currentGame.id);
      
      toast.success('Game starting!');
      // Navigate to the game - the socket event will also trigger this
      navigate(`/game/${currentGame.id}`);
    } catch (error) {
      console.error('Failed to start game:', error);
      toast.error('Failed to start game');
    }
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
    currentGame.status === 'setup' &&
    players && players.length >= 2; // Minimum players needed

  // Load my games when on lobby home (no current game)
  useEffect(() => {
    if (!currentGame) {
      loadMyGames().catch((e) => {
        // Non-blocking, but don't swallow useful debugging info.
        console.warn('Failed to load My Games list:', e);
      });
    }
  }, [currentGame, loadMyGames]);

  const renderStatusBadge = (status: string) => {
    switch (status) {
      case 'setup':
        return <Badge variant="secondary">Setup</Badge>;
      case 'initialBuild':
      case 'active':
        return <Badge variant="default">In Progress</Badge>;
      case 'completed':
        return <Badge variant="outline">Completed</Badge>;
      case 'abandoned':
        return <Badge variant="outline">Abandoned</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const openActiveDeleteDialog = async (gameId: string) => {
    setActiveDeleteGameId(gameId);
    setActiveDeletePlayers(null);
    setActiveTransferToUserId(null);
    try {
      const result = await api.getGamePlayers(gameId);
      setActiveDeletePlayers(result.players.map(p => ({ userId: p.userId, name: p.name, isOnline: p.isOnline })));
    } catch (e) {
      // Fallback: show dialog without transfer options
      setActiveDeletePlayers([]);
    }
  };

  const clearArchivedSelection = () => {
    setArchivedSelectedIds(new Set());
    setHardDeleteOwnedArchived(false);
  };

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
            {process.env.REACT_APP_MOCK_MODE === 'true' && (
              <p className="text-xs text-orange-600 bg-orange-100 px-2 py-1 rounded mt-1 inline-block">
                🧪 Mock Mode - Using Mock Data
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
          // No current game - show my games + create/join
          <div className="space-y-8">
            <Card>
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <CardTitle>My Games</CardTitle>
                    <CardDescription>
                      Resume a game in progress, continue setup, or manage archived games.
                    </CardDescription>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button onClick={() => setShowCreateModal(true)} disabled={isLoading}>
                      <Plus className="size-4 mr-2" />
                      Create
                    </Button>
                    <Button variant="outline" onClick={() => setShowJoinModal(true)} disabled={isLoading}>
                      <Users className="size-4 mr-2" />
                      Join
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="in-progress">
                  <TabsList>
                    <TabsTrigger value="in-progress">In Progress</TabsTrigger>
                    <TabsTrigger value="setup">Setup (Owned)</TabsTrigger>
                    <TabsTrigger value="archived">Completed/Abandoned</TabsTrigger>
                  </TabsList>

                  <TabsContent value="in-progress" className="mt-4">
                    {isLoadingMyGames ? (
                      <div className="flex items-center justify-center py-8">
                        <div className="size-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : !myGames || myGames.active.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-6">No games in progress.</p>
                    ) : (
                      <div className="overflow-auto rounded-md border" style={{ maxHeight: '60vh' }}>
                        <table className="w-full caption-bottom text-sm">
                          <TableHeader>
                            <TableRow>
                              <TableHead className="sticky top-0 z-10 bg-background">Status</TableHead>
                              <TableHead className="sticky top-0 z-10 bg-background">Players</TableHead>
                              <TableHead className="sticky top-0 z-10 bg-background">Join Code</TableHead>
                              <TableHead className="sticky top-0 z-10 bg-background text-right">Action</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {myGames.active.map((g) => (
                              <TableRow key={g.id}>
                                <TableCell>{renderStatusBadge(g.status)}</TableCell>
                                <TableCell>{g.onlineCount}/{g.playerCount} online</TableCell>
                                <TableCell className="font-mono">{g.joinCode ?? '-'}</TableCell>
                                <TableCell className="text-right">
                                  <div className="flex justify-end gap-2">
                                    <Button size="sm" onClick={() => navigate(`/game/${g.id}`)}>
                                      Join game in progress
                                    </Button>
                                    {g.isOwner && (
                                      <Button
                                        size="sm"
                                        variant="destructive"
                                        onClick={() => openActiveDeleteDialog(g.id)}
                                      >
                                        Delete
                                      </Button>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </table>
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="setup" className="mt-4">
                    {isLoadingMyGames ? (
                      <div className="flex items-center justify-center py-8">
                        <div className="size-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : !myGames || myGames.setupOwned.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-6">No setup games you own.</p>
                    ) : (
                      <div className="overflow-auto rounded-md border" style={{ maxHeight: '60vh' }}>
                        <table className="w-full caption-bottom text-sm">
                          <TableHeader>
                            <TableRow>
                              <TableHead className="sticky top-0 z-10 bg-background">Status</TableHead>
                              <TableHead className="sticky top-0 z-10 bg-background">Players</TableHead>
                              <TableHead className="sticky top-0 z-10 bg-background">Join Code</TableHead>
                              <TableHead className="sticky top-0 z-10 bg-background text-right">Action</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {myGames.setupOwned.map((g) => (
                              <TableRow key={g.id}>
                                <TableCell>{renderStatusBadge(g.status)}</TableCell>
                                <TableCell>{g.onlineCount}/{g.playerCount} online</TableCell>
                                <TableCell className="font-mono">{g.joinCode ?? '-'}</TableCell>
                                <TableCell className="text-right">
                                  <Button
                                    size="sm"
                                    onClick={async () => {
                                      try {
                                        await loadGameFromUrl(g.id);
                                        navigate(`/lobby/game/${g.id}`);
                                      } catch {
                                        toast.error('Failed to load game');
                                      }
                                    }}
                                  >
                                    Continue setup
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </table>
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="archived" className="mt-4">
                    {isLoadingMyGames ? (
                      <div className="flex items-center justify-center py-8">
                        <div className="size-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : !myGames || myGames.archived.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-6">No completed or abandoned games.</p>
                    ) : (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <p className="text-sm text-muted-foreground">
                            Select games to remove from your list. If you own a game, you can permanently delete it for everyone.
                          </p>
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={archivedSelectedIds.size === 0}
                            onClick={() => setShowArchivedDeleteDialog(true)}
                          >
                            Delete selected ({archivedSelectedIds.size})
                          </Button>
                        </div>

                        <div className="overflow-auto rounded-md border" style={{ maxHeight: '60vh' }}>
                          <table className="w-full caption-bottom text-sm">
                            <TableHeader>
                              <TableRow>
                                <TableHead className="sticky top-0 z-10 bg-background">
                                  <Checkbox
                                    checked={archivedSelectedIds.size === myGames.archived.length}
                                    onCheckedChange={(checked) => {
                                      if (checked) {
                                        setArchivedSelectedIds(new Set(myGames.archived.map(g => g.id)));
                                      } else {
                                        setArchivedSelectedIds(new Set());
                                      }
                                    }}
                                  />
                                </TableHead>
                                <TableHead className="sticky top-0 z-10 bg-background">Status</TableHead>
                                <TableHead className="sticky top-0 z-10 bg-background">Players</TableHead>
                                <TableHead className="sticky top-0 z-10 bg-background">Join Code</TableHead>
                                <TableHead className="sticky top-0 z-10 bg-background text-right">Owner</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {myGames.archived.map((g) => {
                                const isSelected = archivedSelectedIds.has(g.id);
                                return (
                                  <TableRow key={g.id}>
                                    <TableCell>
                                      <Checkbox
                                        checked={isSelected}
                                        onCheckedChange={(checked) => {
                                          const next = new Set(archivedSelectedIds);
                                          if (checked) next.add(g.id);
                                          else next.delete(g.id);
                                          setArchivedSelectedIds(next);
                                        }}
                                      />
                                    </TableCell>
                                    <TableCell>{renderStatusBadge(g.status)}</TableCell>
                                    <TableCell>{g.onlineCount}/{g.playerCount} online</TableCell>
                                    <TableCell className="font-mono">{g.joinCode ?? '-'}</TableCell>
                                    <TableCell className="text-right">
                                      {g.isOwner ? <Badge variant="secondary">You</Badge> : <span className="text-muted-foreground text-sm">—</span>}
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </table>
                        </div>
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
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
                  <Badge variant={currentGame.status === 'setup' ? 'secondary' : 'default'}>
                    {currentGame.status === 'setup' ? 'Setting Up' : currentGame.status}
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
                    Players ({(players?.length || 0)}/{currentGame.maxPlayers})
                  </h3>
                  
                  <div className="space-y-2">
                    {!players || players.length === 0 ? (
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

                  {currentGame.status === 'setup' && currentGame.createdBy === user?.id && (
                    <Button
                      variant="outline"
                      onClick={async () => {
                        await loadMyGames().catch(() => {});
                        setSwitchToSetupGameId(null);
                        setShowSwitchSetupDialog(true);
                      }}
                    >
                      Switch setup game
                    </Button>
                  )}
                </div>

                {!canStartGame && currentGame.status === 'setup' && (
                  <p className="text-sm text-muted-foreground text-center">
                    {currentGame.createdBy !== user?.id 
                      ? 'Waiting for the game creator to start the game...'
                      : !players || players.length < 2
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

      {/* Active game owner delete/transfer dialog */}
      <AlertDialog open={!!activeDeleteGameId} onOpenChange={(open) => { if (!open) setActiveDeleteGameId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete active game</AlertDialogTitle>
            <AlertDialogDescription>
              You can permanently delete this game for everyone, or transfer ownership to another online player and leave the game.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {activeDeletePlayers && (
            <div className="space-y-3">
              {activeDeletePlayers.filter(p => p.userId !== user?.id && p.isOnline).length > 0 ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Transfer ownership to</p>
                  <Select value={activeTransferToUserId ?? undefined} onValueChange={(v) => setActiveTransferToUserId(v)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select an online player" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeDeletePlayers
                        .filter(p => p.userId !== user?.id && p.isOnline)
                        .map(p => (
                          <SelectItem key={p.userId} value={p.userId}>
                            {p.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No other online players are present. Ownership transfer is unavailable.
                </p>
              )}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setActiveDeleteGameId(null)}>Cancel</AlertDialogCancel>

            <AlertDialogAction
              disabled={!activeDeleteGameId || !activeTransferToUserId}
              onClick={async () => {
                if (!activeDeleteGameId || !activeTransferToUserId) return;
                try {
                  await api.deleteGame(activeDeleteGameId, { mode: 'transfer', newOwnerUserId: activeTransferToUserId });
                  toast.success('Ownership transferred');
                  setActiveDeleteGameId(null);
                  await loadMyGames();
                } catch (e) {
                  toast.error('Failed to transfer ownership');
                }
              }}
            >
              Transfer and leave
            </AlertDialogAction>

            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!activeDeleteGameId) return;
                try {
                  await api.deleteGame(activeDeleteGameId, { mode: 'hard' });
                  toast.success('Game deleted');
                  setActiveDeleteGameId(null);
                  await loadMyGames();
                } catch (e) {
                  toast.error('Failed to delete game');
                }
              }}
            >
              Delete for all users
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Archived multi-select delete dialog */}
      <AlertDialog open={showArchivedDeleteDialog} onOpenChange={(open) => { if (!open) { setShowArchivedDeleteDialog(false); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete selected games</AlertDialogTitle>
            <AlertDialogDescription>
              Choose whether games you own should be permanently deleted for everyone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {myGames && (
            (() => {
              const selected = myGames.archived.filter(g => archivedSelectedIds.has(g.id));
              const owned = selected.filter(g => g.isOwner).map(g => g.id);
              const notOwned = selected.filter(g => !g.isOwner).map(g => g.id);
              return (
                <div className="space-y-4">
                  <div className="text-sm text-muted-foreground">
                    {notOwned.length > 0 && <div>- {notOwned.length} game(s) will be removed from your list only.</div>}
                    {owned.length > 0 && (
                      <div>- {owned.length} game(s) are owned by you and can be permanently deleted.</div>
                    )}
                  </div>

                  {owned.length > 0 && (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={hardDeleteOwnedArchived}
                        onCheckedChange={(checked) => setHardDeleteOwnedArchived(Boolean(checked))}
                      />
                      <span className="text-sm">
                        Permanently delete games I own (cannot be undone)
                      </span>
                    </div>
                  )}
                </div>
              );
            })()
          )}

          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setShowArchivedDeleteDialog(false); }}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!myGames) return;
                const selected = myGames.archived.filter(g => archivedSelectedIds.has(g.id));
                const owned = selected.filter(g => g.isOwner).map(g => g.id);
                const notOwned = selected.filter(g => !g.isOwner).map(g => g.id);
                try {
                  if (notOwned.length > 0) {
                    await api.bulkDeleteGames({ gameIds: notOwned, mode: 'soft' });
                  }
                  if (owned.length > 0) {
                    await api.bulkDeleteGames({ gameIds: owned, mode: hardDeleteOwnedArchived ? 'hard' : 'soft' });
                  }
                  toast.success('Games deleted');
                  setShowArchivedDeleteDialog(false);
                  clearArchivedSelection();
                  await loadMyGames();
                } catch (e) {
                  toast.error('Failed to delete games');
                }
              }}
            >
              Confirm delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Switch setup game dialog */}
      <AlertDialog open={showSwitchSetupDialog} onOpenChange={(open) => { if (!open) setShowSwitchSetupDialog(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch setup game?</AlertDialogTitle>
            <AlertDialogDescription>
              Switching will leave the current setup game. If you are the last player, it will be marked as abandoned.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {myGames && currentGame && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Continue setup for</p>
              <Select
                value={switchToSetupGameId ?? undefined}
                onValueChange={(v) => setSwitchToSetupGameId(v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a setup game" />
                </SelectTrigger>
                <SelectContent>
                  {myGames.setupOwned
                    .filter(g => g.id !== currentGame.id)
                    .map(g => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.joinCode ?? g.id}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {myGames.setupOwned.filter(g => g.id !== currentGame.id).length === 0 && (
                <p className="text-sm text-muted-foreground">
                  You don’t have any other setup games.
                </p>
              )}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowSwitchSetupDialog(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!switchToSetupGameId}
              onClick={async () => {
                if (!switchToSetupGameId) return;
                try {
                  await leaveGame();
                  await loadGameFromUrl(switchToSetupGameId);
                  setShowSwitchSetupDialog(false);
                  navigate(`/lobby/game/${switchToSetupGameId}`);
                } catch (e) {
                  toast.error('Failed to switch setup games');
                }
              }}
            >
              Switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}