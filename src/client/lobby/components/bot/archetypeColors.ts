import type { ArchetypeId } from '../../../../server/ai/types';

export interface ArchetypeColorToken {
  bg: string;
  text: string;
  border: string;
  fill: string;
}

const ARCHETYPE_COLORS: Record<ArchetypeId, ArchetypeColorToken> = {
  backbone_builder: {
    bg: 'bg-blue-100 dark:bg-blue-900/30',
    text: 'text-blue-700 dark:text-blue-300',
    border: 'border-blue-300 dark:border-blue-700',
    fill: 'bg-blue-500',
  },
  freight_optimizer: {
    bg: 'bg-amber-100 dark:bg-amber-900/30',
    text: 'text-amber-700 dark:text-amber-300',
    border: 'border-amber-300 dark:border-amber-700',
    fill: 'bg-amber-500',
  },
  trunk_sprinter: {
    bg: 'bg-emerald-100 dark:bg-emerald-900/30',
    text: 'text-emerald-700 dark:text-emerald-300',
    border: 'border-emerald-300 dark:border-emerald-700',
    fill: 'bg-emerald-500',
  },
  continental_connector: {
    bg: 'bg-purple-100 dark:bg-purple-900/30',
    text: 'text-purple-700 dark:text-purple-300',
    border: 'border-purple-300 dark:border-purple-700',
    fill: 'bg-purple-500',
  },
  opportunist: {
    bg: 'bg-rose-100 dark:bg-rose-900/30',
    text: 'text-rose-700 dark:text-rose-300',
    border: 'border-rose-300 dark:border-rose-700',
    fill: 'bg-rose-500',
  },
};

const ARCHETYPE_ABBREVIATIONS: Record<ArchetypeId, string> = {
  backbone_builder: 'BB',
  freight_optimizer: 'FO',
  trunk_sprinter: 'TS',
  continental_connector: 'CC',
  opportunist: 'OP',
};

export function getArchetypeColors(archetype: ArchetypeId): ArchetypeColorToken {
  return ARCHETYPE_COLORS[archetype];
}

export function getArchetypeAbbreviation(archetype: ArchetypeId): string {
  return ARCHETYPE_ABBREVIATIONS[archetype];
}

export { ARCHETYPE_COLORS, ARCHETYPE_ABBREVIATIONS };
