import { BotArchetype, BotSkillLevel } from '../../../shared/types/GameTypes';
import { Swords, Shield, Scale, Eye, Hammer, type LucideIcon } from 'lucide-react';

export interface ArchetypeDisplay {
  label: string;
  icon: LucideIcon;
  color: string;
  bgColor: string;
  description: string;
}

const ARCHETYPE_DISPLAY: Record<BotArchetype, ArchetypeDisplay> = {
  [BotArchetype.Aggressive]: {
    label: 'Aggressive',
    icon: Swords,
    color: 'text-red-600',
    bgColor: 'bg-red-100',
    description: 'Prioritizes fast deliveries and risky routes',
  },
  [BotArchetype.Defensive]: {
    label: 'Defensive',
    icon: Shield,
    color: 'text-blue-600',
    bgColor: 'bg-blue-100',
    description: 'Builds safe networks and avoids opponents',
  },
  [BotArchetype.Balanced]: {
    label: 'Balanced',
    icon: Scale,
    color: 'text-green-600',
    bgColor: 'bg-green-100',
    description: 'Balances building and delivering evenly',
  },
  [BotArchetype.Opportunistic]: {
    label: 'Opportunistic',
    icon: Eye,
    color: 'text-amber-600',
    bgColor: 'bg-amber-100',
    description: 'Adapts strategy based on available opportunities',
  },
  [BotArchetype.BuilderFirst]: {
    label: 'Builder First',
    icon: Hammer,
    color: 'text-purple-600',
    bgColor: 'bg-purple-100',
    description: 'Focuses on building a large network before delivering',
  },
};

export function getArchetypeDisplay(archetype: BotArchetype): ArchetypeDisplay {
  return ARCHETYPE_DISPLAY[archetype];
}

export function getSkillLevelDisplay(level: BotSkillLevel): { label: string; color: string } {
  switch (level) {
    case BotSkillLevel.Easy:
      return { label: 'Easy', color: 'text-green-600' };
    case BotSkillLevel.Medium:
      return { label: 'Medium', color: 'text-amber-600' };
    case BotSkillLevel.Hard:
      return { label: 'Hard', color: 'text-red-600' };
  }
}
