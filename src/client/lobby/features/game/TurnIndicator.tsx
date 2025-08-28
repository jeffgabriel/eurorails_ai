// features/game/TurnIndicator.tsx
import { Clock, User } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Avatar, AvatarFallback } from '../../components/ui/avatar';
import { useGameStore } from '../../store/game.store';
import { useAuthStore } from '../../store/auth.store';

export function TurnIndicator() {
  const gameState = useGameStore((state) => state.gameState);
  const currentUser = useAuthStore((state) => state.user);

  if (!gameState) {
    return (
      <Badge variant="outline" className="flex items-center gap-2">
        <Clock className="size-3" />
        Loading...
      </Badge>
    );
  }

  const currentPlayer = gameState.players.find(
    player => player.userId === gameState.currentTurnUserId
  );

  if (!currentPlayer) {
    return (
      <Badge variant="outline" className="flex items-center gap-2">
        <Clock className="size-3" />
        Unknown Turn
      </Badge>
    );
  }

  const isCurrentUserTurn = currentUser?.id === currentPlayer.userId;

  return (
    <div className="flex items-center gap-2">
      <Avatar className="size-6">
        <AvatarFallback 
          className="text-xs"
          style={{ 
            backgroundColor: currentPlayer.color + '20', 
            color: currentPlayer.color 
          }}
        >
          <User className="size-3" />
        </AvatarFallback>
      </Avatar>
      
      <Badge 
        variant={isCurrentUserTurn ? 'default' : 'secondary'}
        className="flex items-center gap-1"
      >
        <Clock className="size-3" />
        {isCurrentUserTurn ? 'Your Turn' : `${currentPlayer.name}'s Turn`}
      </Badge>
    </div>
  );
}