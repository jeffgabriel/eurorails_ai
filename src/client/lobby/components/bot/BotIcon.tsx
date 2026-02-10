import * as React from 'react';
import { Bot } from 'lucide-react';
import { cn } from '../ui/utils';

interface BotIconProps {
  className?: string;
  size?: number;
}

function BotIcon({ className, size = 16 }: BotIconProps) {
  return (
    <Bot
      data-slot="bot-icon"
      className={cn('text-muted-foreground', className)}
      size={size}
      aria-label="Bot player"
    />
  );
}

export { BotIcon };
