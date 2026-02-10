import * as React from 'react';
import { cn } from '../ui/utils';

interface ScoreBarProps {
  score: number;
  maxScore?: number;
  className?: string;
}

function ScoreBar({ score, maxScore = 100, className }: ScoreBarProps) {
  const percentage = maxScore > 0 ? Math.min(100, Math.max(0, (score / maxScore) * 100)) : 0;

  return (
    <div
      data-slot="score-bar"
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-primary/20', className)}
      role="meter"
      aria-valuenow={score}
      aria-valuemin={0}
      aria-valuemax={maxScore}
      aria-label={`Score: ${score} of ${maxScore}`}
    >
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}

export { ScoreBar };
