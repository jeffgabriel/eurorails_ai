import { Badge } from '../../components/ui/badge';

const ARCHETYPE_DISPLAY: Record<string, { label: string; icon: string }> = {
  backbone_builder: { label: 'Backbone Builder', icon: '🦴' },
  freight_optimizer: { label: 'Freight Optimizer', icon: '📦' },
  trunk_sprinter: { label: 'Trunk Sprinter', icon: '🚄' },
  continental_connector: { label: 'Continental Connector', icon: '🗺️' },
  opportunist: { label: 'Opportunist', icon: '🔀' },
};

interface ArchetypeBadgeProps {
  archetype: string;
}

export function ArchetypeBadge({ archetype }: ArchetypeBadgeProps) {
  const display = ARCHETYPE_DISPLAY[archetype];
  if (!display) return null;

  return (
    <Badge
      variant="outline"
      className="text-xs"
      aria-label={`Strategy: ${display.label}`}
    >
      <span aria-hidden="true">{display.icon}</span>
      {display.label}
    </Badge>
  );
}
