import { cn } from '../ui/utils';

const ARCHETYPE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  backbone_builder: { bg: 'bg-blue-100', text: 'text-blue-800', border: 'border-blue-300' },
  freight_optimizer: { bg: 'bg-green-100', text: 'text-green-800', border: 'border-green-300' },
  trunk_sprinter: { bg: 'bg-yellow-100', text: 'text-yellow-800', border: 'border-yellow-300' },
  continental_connector: { bg: 'bg-purple-100', text: 'text-purple-800', border: 'border-purple-300' },
  opportunist: { bg: 'bg-orange-100', text: 'text-orange-800', border: 'border-orange-300' },
};

const ARCHETYPE_ABBREVIATIONS: Record<string, string> = {
  backbone_builder: 'BB',
  freight_optimizer: 'FO',
  trunk_sprinter: 'TS',
  continental_connector: 'CC',
  opportunist: 'OP',
};

const DEFAULT_COLORS = { bg: 'bg-gray-100', text: 'text-gray-800', border: 'border-gray-300' };

interface ArchetypeBadgeProps {
  archetype: string;
  className?: string;
}

export function ArchetypeBadge({ archetype, className }: ArchetypeBadgeProps) {
  const colors = ARCHETYPE_COLORS[archetype] || DEFAULT_COLORS;
  const abbreviation = ARCHETYPE_ABBREVIATIONS[archetype] || archetype.slice(0, 2).toUpperCase();

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
