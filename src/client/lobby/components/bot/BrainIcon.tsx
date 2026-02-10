import * as React from 'react';
import { Brain } from 'lucide-react';
import { cn } from '../ui/utils';

interface BrainIconProps {
  isPulsing?: boolean;
  onClick: () => void;
  className?: string;
  size?: number;
}

function BrainIcon({ isPulsing = false, onClick, className, size = 18 }: BrainIconProps) {
  return (
    <button
      data-slot="brain-icon"
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center justify-center rounded-md p-1',
        'text-muted-foreground hover:text-foreground hover:bg-accent',
        'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isPulsing && 'animate-pulse',
        className,
      )}
      aria-label="View bot strategy"
    >
      <Brain size={size} />
    </button>
  );
}

export { BrainIcon };
