import * as React from 'react';
import { X } from 'lucide-react';
import { Avatar, AvatarFallback } from '../ui/avatar';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { BotIcon } from './BotIcon';
import { ArchetypeBadge } from './ArchetypeBadge';
import type { Player } from '../../shared/types';
import type { ArchetypeId } from '../../../../server/ai/types';

interface BotPlayerRowProps {
  player: Player;
  canRemove: boolean;
  onRemove: (playerId: string) => void;
}

const SKILL_LABELS: Record<string, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

function BotPlayerRow({ player, canRemove, onRemove }: BotPlayerRowProps) {
  const botConfig = player.botConfig;

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/5 transition-colors">
      <div className="relative">
        <Avatar className="size-10">
          <AvatarFallback
            className="text-sm"
            style={{ backgroundColor: player.color + '20', color: player.color }}
          >
            <BotIcon size={20} className="text-current" />
          </AvatarFallback>
        </Avatar>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium truncate">{player.name}</p>
          <BotIcon size={14} />
        </div>

        <div className="flex items-center gap-2">
          {botConfig && (
            <>
              <Badge variant="outline" className="text-xs">
                {SKILL_LABELS[botConfig.skillLevel] || botConfig.skillLevel}
              </Badge>
              <ArchetypeBadge archetype={botConfig.archetype as ArchetypeId} />
            </>
          )}
        </div>
      </div>

      {/* Player color indicator */}
      <div
        className="size-6 rounded-full border-2 border-background shadow-sm"
        style={{ backgroundColor: player.color }}
        title={`Player color: ${player.color}`}
      />

      {canRemove && (
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive"
          onClick={() => onRemove(player.id)}
          title="Remove bot"
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}

export { BotPlayerRow };
export type { BotPlayerRowProps };
