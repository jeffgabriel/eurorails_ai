import { BotSkillLevel } from '../../../shared/types/GameTypes';

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
