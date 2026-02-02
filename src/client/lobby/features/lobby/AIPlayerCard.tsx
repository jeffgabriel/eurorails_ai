// features/lobby/AIPlayerCard.tsx
import { Bot, X, Brain, Network, Zap, Shield, Anchor, Sparkles } from 'lucide-react';
import { Avatar, AvatarFallback } from '../../components/ui/avatar';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import type { Player, AIDifficulty, AIPersonality } from '../../shared/types';
import { useAuthStore } from '../../store/auth.store';
import { useLobbyStore } from '../../store/lobby.store';

interface AIPlayerCardProps {
  player: Player;
  onRemove?: (playerId: string) => void;
}

const difficultyConfig: Record<AIDifficulty, { label: string; color: string; bgColor: string }> = {
  easy: { label: 'Easy', color: 'text-green-700', bgColor: 'bg-green-100' },
  medium: { label: 'Medium', color: 'text-yellow-700', bgColor: 'bg-yellow-100' },
  hard: { label: 'Hard', color: 'text-red-700', bgColor: 'bg-red-100' },
};

const personalityConfig: Record<AIPersonality, { label: string; icon: typeof Brain; description: string }> = {
  optimizer: { label: 'Optimizer', icon: Brain, description: 'ROI focused' },
  network_builder: { label: 'Network Builder', icon: Network, description: 'Infrastructure first' },
  opportunist: { label: 'Opportunist', icon: Zap, description: 'High risk' },
  blocker: { label: 'Blocker', icon: Shield, description: 'Deny others' },
  steady_hand: { label: 'Steady Hand', icon: Anchor, description: 'Low risk' },
  chaos_agent: { label: 'Chaos Agent', icon: Sparkles, description: 'Unpredictable' },
};

export function AIPlayerCard({ player, onRemove }: AIPlayerCardProps) {
  const currentUser = useAuthStore((state) => state.user);
  const currentGame = useLobbyStore((state) => state.currentGame);

  const isCreator = currentGame?.createdBy === currentUser?.id;
  const difficulty = player.aiDifficulty || 'medium';
  const personality = player.aiPersonality || 'optimizer';

  const difficultyInfo = difficultyConfig[difficulty];
  const personalityInfo = personalityConfig[personality];
  const PersonalityIcon = personalityInfo.icon;

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/5 transition-colors">
      <div className="relative">
        <Avatar className="size-10">
          <AvatarFallback
            className="text-sm bg-purple-100"
            style={{ color: player.color }}
          >
            <Bot className="size-5" />
          </AvatarFallback>
        </Avatar>

        {/* AI indicator */}
        <div className="absolute -bottom-1 -right-1 size-3 rounded-full border-2 border-background bg-purple-500" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium truncate">
            {player.name}
          </p>
          <Bot className="size-4 text-purple-500" />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant="outline"
            className={`text-xs ${difficultyInfo.color} ${difficultyInfo.bgColor} border-0`}
          >
            {difficultyInfo.label}
          </Badge>

          <Badge variant="secondary" className="text-xs flex items-center gap-1">
            <PersonalityIcon className="size-3" />
            {personalityInfo.label}
          </Badge>
        </div>
      </div>

      {/* Player color indicator */}
      <div
        className="size-6 rounded-full border-2 border-background shadow-sm"
        style={{ backgroundColor: player.color }}
        title={`Player color: ${player.color}`}
      />

      {/* Remove button - only shown to game creator */}
      {isCreator && onRemove && (
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={() => onRemove(player.id)}
          aria-label={`Remove ${player.name}`}
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}
