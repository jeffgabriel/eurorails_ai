import * as React from 'react';
import { cn } from '../ui/utils';
import { getArchetypeColors, getArchetypeAbbreviation } from './archetypeColors';
import type { ArchetypeId } from '../../../../server/ai/types';

interface ArchetypeBadgeProps {
  archetype: ArchetypeId;
  className?: string;
}

function ArchetypeBadge({ archetype, className }: ArchetypeBadgeProps) {
  const colors = getArchetypeColors(archetype);
  const abbreviation = getArchetypeAbbreviation(archetype);

  return (
    <span
      data-slot="archetype-badge"
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        colors.bg,
        colors.text,
        colors.border,
        className,
      )}
    >
      {abbreviation}
    </span>
  );
}

export { ArchetypeBadge };
