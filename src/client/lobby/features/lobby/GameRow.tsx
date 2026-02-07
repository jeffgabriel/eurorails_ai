// features/lobby/GameRow.tsx
import { Crown, User, Bot, X } from 'lucide-react';
import { Avatar, AvatarFallback } from '../../components/ui/avatar';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import type { Player } from '../../shared/types';
import { useAuthStore } from '../../store/auth.store';
import { useLobbyStore } from '../../store/lobby.store';
import { ArchetypeBadge } from './ArchetypeBadge';

interface GameRowProps {
  player: Player;
  onRemoveBot?: (playerId: string) => void;
}

export function GameRow({ player, onRemoveBot }: GameRowProps) {
  const currentUser = useAuthStore((state) => state.user);
  const currentGame = useLobbyStore((state) => state.currentGame);

  const isCurrentUser = currentUser?.id === player.userId;
  const isCreator = currentGame?.createdBy === currentUser?.id;
  const isGameCreator = currentGame?.createdBy === player.userId;

  return (
    <div
      className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
        player.isAI
          ? 'bg-muted/50 border-dashed hover:bg-muted/70'
          : 'bg-card hover:bg-accent/5'
      }`}
      role="listitem"
      aria-label={player.isAI ? `AI bot: ${player.name}` : `Player: ${player.name}`}
    >
      <div className="relative">
        <Avatar className="size-10">
          <AvatarFallback
            className="text-sm"
            style={{ backgroundColor: player.color + '20', color: player.color }}
          >
            {player.isAI ? (
              <Bot className="size-5" aria-label="AI bot player" />
            ) : (
              <User className="size-5" aria-label="Human player" />
            )}
          </AvatarFallback>
        </Avatar>

        {/* Online status indicator */}
        {!player.isAI && (
          <div className={`absolute -bottom-1 -right-1 size-3 rounded-full border-2 border-background ${
            player.isOnline ? 'bg-green-500' : 'bg-gray-400'
          }`} />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium truncate">
            {player.name}
            {isCurrentUser && ' (You)'}
          </p>

          {isGameCreator && (
            <Crown className="size-4 text-yellow-500" />
          )}
        </div>

        <div className="flex items-center gap-2">
          {player.isAI ? (
            <>
              <Badge variant="secondary" className="text-xs">
                Bot
              </Badge>
              {player.aiDifficulty && (
                <Badge variant="outline" className="text-xs capitalize">
                  {player.aiDifficulty}
                </Badge>
              )}
              {player.aiArchetype && (
                <ArchetypeBadge archetype={player.aiArchetype} />
              )}
            </>
          ) : (
            <>
              <Badge
                variant={player.isOnline ? 'secondary' : 'outline'}
                className="text-xs"
              >
                {player.isOnline ? 'Online' : 'Offline'}
              </Badge>

              {isGameCreator && (
                <Badge variant="default" className="text-xs">
                  Creator
                </Badge>
              )}
            </>
          )}
        </div>
      </div>

      {/* Player color indicator */}
      <div
        className="size-6 rounded-full border-2 border-background shadow-sm shrink-0"
        style={{ backgroundColor: player.color }}
        title={`Player color: ${player.color}`}
      />

      {/* Remove bot button - only shown to host */}
      {player.isAI && isCreator && onRemoveBot && (
        <Button
          variant="ghost"
          size="sm"
          className="size-8 p-0 text-muted-foreground hover:text-destructive"
          onClick={() => onRemoveBot(player.id)}
          aria-label={`Remove ${player.name}`}
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}
