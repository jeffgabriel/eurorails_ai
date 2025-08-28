// features/game/PlayerSidebar.tsx
import { Crown, User, Wifi, WifiOff } from 'lucide-react';
import { Avatar, AvatarFallback } from '../../components/ui/avatar';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { ScrollArea } from '../../components/ui/scroll-area';
import { Separator } from '../../components/ui/separator';
import type { GameState } from '../../shared/types';
import { useAuthStore } from '../../store/auth.store';

interface PlayerSidebarProps {
  gameState: GameState;
}

export function PlayerSidebar({ gameState }: PlayerSidebarProps) {
  const currentUser = useAuthStore((state) => state.user);
  const currentPlayer = gameState.players.find(p => p.userId === gameState.currentTurnUserId);

  return (
    <div className="h-full flex flex-col">
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Current Turn */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Current Turn</CardTitle>
            </CardHeader>
            <CardContent>
              {currentPlayer ? (
                <div className="flex items-center gap-3">
                  <Avatar className="size-8">
                    <AvatarFallback 
                      className="text-xs"
                      style={{ 
                        backgroundColor: currentPlayer.color + '20', 
                        color: currentPlayer.color 
                      }}
                    >
                      <User className="size-4" />
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium text-sm">
                      {currentPlayer.name}
                      {currentUser?.id === currentPlayer.userId && ' (You)'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {currentUser?.id === currentPlayer.userId ? 
                        "It's your turn!" : 
                        'Waiting for their move...'}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Loading...</p>
              )}
            </CardContent>
          </Card>

          {/* Players List */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">
                Players ({gameState.players.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {gameState.players.map((player, index) => {
                  const isCurrentUser = currentUser?.id === player.userId;
                  const isCurrentTurn = player.userId === gameState.currentTurnUserId;
                  
                  return (
                    <div key={player.id}>
                      <div className={`flex items-center gap-3 p-2 rounded-lg ${
                        isCurrentTurn ? 'bg-accent/10 ring-1 ring-accent/20' : ''
                      }`}>
                        <div className="relative">
                          <Avatar className="size-8">
                            <AvatarFallback 
                              className="text-xs"
                              style={{ 
                                backgroundColor: player.color + '20', 
                                color: player.color 
                              }}
                            >
                              <User className="size-4" />
                            </AvatarFallback>
                          </Avatar>
                          
                          {/* Online status */}
                          <div className="absolute -bottom-0.5 -right-0.5">
                            {player.isOnline ? (
                              <Wifi className="size-3 text-green-500" />
                            ) : (
                              <WifiOff className="size-3 text-red-500" />
                            )}
                          </div>
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1">
                            <p className="text-sm font-medium truncate">
                              {player.name}
                              {isCurrentUser && ' (You)'}
                            </p>
                            
                            {index === 0 && (
                              <Crown className="size-3 text-yellow-500" />
                            )}
                          </div>
                          
                          <div className="flex items-center gap-1">
                            <Badge 
                              variant={player.isOnline ? 'secondary' : 'outline'}
                              className="text-xs px-1"
                            >
                              {player.isOnline ? 'Online' : 'Offline'}
                            </Badge>
                            
                            {isCurrentTurn && (
                              <Badge variant="default" className="text-xs px-1">
                                Active
                              </Badge>
                            )}
                          </div>
                        </div>

                        {/* Player color */}
                        <div 
                          className="size-4 rounded-full border border-border shadow-sm"
                          style={{ backgroundColor: player.color }}
                        />
                      </div>
                      
                      {index < gameState.players.length - 1 && (
                        <Separator className="my-2" />
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Game Stats */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Game Statistics</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Tracks:</span>
                  <span>{gameState.tracks.length}</span>
                </div>
                
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Active Players:</span>
                  <span>
                    {gameState.players.filter(p => p.isOnline).length} / {gameState.players.length}
                  </span>
                </div>

                <div className="flex justify-between">
                  <span className="text-muted-foreground">Game Status:</span>
                  <Badge variant="secondary" className="text-xs">
                    Active
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Track Ownership */}
          {gameState.tracks.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Track Ownership</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {gameState.players.map(player => {
                    const playerTracks = gameState.tracks.filter(
                      track => track.ownerUserId === player.userId
                    );
                    
                    if (playerTracks.length === 0) return null;

                    return (
                      <div key={player.id} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div 
                            className="size-3 rounded-full border border-border"
                            style={{ backgroundColor: player.color }}
                          />
                          <span className="text-sm truncate">
                            {player.name}
                            {currentUser?.id === player.userId && ' (You)'}
                          </span>
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {playerTracks.length} track{playerTracks.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}