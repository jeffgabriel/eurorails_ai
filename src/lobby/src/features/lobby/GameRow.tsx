// features/lobby/GameRow.tsx
import { Crown, User } from 'lucide-react';
import { Avatar, AvatarFallback } from '../../components/ui/avatar';
import { Badge } from '../../components/ui/badge';
import type { Player } from '../../shared/types';
import { useAuthStore } from '../../store/auth.store';
import { useLobbyStore } from '../../store/lobby.store';

interface GameRowProps {
  player: Player;
}

export function GameRow({ player }: GameRowProps) {
  const currentUser = useAuthStore((state) => state.user);
  const currentGame = useLobbyStore((state) => state.currentGame);
  
  const isCurrentUser = currentUser?.id === player.userId;
  const isCreator = currentGame?.createdBy === player.userId;

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/5 transition-colors">
      <div className="relative">
        <Avatar className="size-10">
          <AvatarFallback 
            className="text-sm"
            style={{ backgroundColor: player.color + '20', color: player.color }}
          >
            <User className="size-5" />
          </AvatarFallback>
        </Avatar>
        
        {/* Online status indicator */}
        <div className={`absolute -bottom-1 -right-1 size-3 rounded-full border-2 border-background ${
          player.isOnline ? 'bg-green-500' : 'bg-gray-400'
        }`} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium truncate">
            {player.name}
            {isCurrentUser && ' (You)'}
          </p>
          
          {isCreator && (
            <Crown className="size-4 text-yellow-500" />
          )}
        </div>
        
        <div className="flex items-center gap-2">
          <Badge 
            variant={player.isOnline ? 'secondary' : 'outline'}
            className="text-xs"
          >
            {player.isOnline ? 'Online' : 'Offline'}
          </Badge>
          
          {isCreator && (
            <Badge variant="default" className="text-xs">
              Creator
            </Badge>
          )}
        </div>
      </div>

      {/* Player color indicator */}
      <div 
        className="size-6 rounded-full border-2 border-background shadow-sm"
        style={{ backgroundColor: player.color }}
        title={`Player color: ${player.color}`}
      />
    </div>
  );
}