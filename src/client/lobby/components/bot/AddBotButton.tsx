import * as React from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../ui/button';
import { BotConfigPopover } from './BotConfigPopover';
import { BotIcon } from './BotIcon';
import type { ArchetypeId, SkillLevel } from '../../../../server/ai/types';

interface AddBotButtonProps {
  onAddBot: (config: { skillLevel: SkillLevel; archetype: ArchetypeId | 'random'; botName: string }) => void;
  disabled?: boolean;
  playerCount: number;
  maxPlayers: number;
}

function AddBotButton({ onAddBot, disabled, playerCount, maxPlayers }: AddBotButtonProps) {
  const isFull = playerCount >= maxPlayers;

  return (
    <BotConfigPopover onAddBot={onAddBot} disabled={disabled || isFull}>
      <Button
        variant="outline"
        size="sm"
        className="w-full border-dashed"
        disabled={disabled || isFull}
      >
        <Plus className="size-4 mr-1" />
        <BotIcon size={14} className="mr-1" />
        {isFull ? 'Game Full' : 'Add Bot'}
      </Button>
    </BotConfigPopover>
  );
}

export { AddBotButton };
export type { AddBotButtonProps };
