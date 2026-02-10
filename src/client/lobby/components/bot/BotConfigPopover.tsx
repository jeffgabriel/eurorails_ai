import * as React from 'react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import type { ArchetypeId, SkillLevel } from '../../../../server/ai/types';

interface BotConfigPopoverProps {
  children: React.ReactNode;
  onAddBot: (config: { skillLevel: SkillLevel; archetype: ArchetypeId | 'random'; botName: string }) => void;
  disabled?: boolean;
}

const SKILL_LEVELS: { value: SkillLevel; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
];

const ARCHETYPES: { value: ArchetypeId | 'random'; label: string }[] = [
  { value: 'random', label: 'Random' },
  { value: 'backbone_builder', label: 'Backbone Builder' },
  { value: 'freight_optimizer', label: 'Freight Optimizer' },
  { value: 'trunk_sprinter', label: 'Trunk Sprinter' },
  { value: 'continental_connector', label: 'Continental Connector' },
  { value: 'opportunist', label: 'Opportunist' },
];

function BotConfigPopover({ children, onAddBot, disabled }: BotConfigPopoverProps) {
  const [open, setOpen] = useState(false);
  const [skillLevel, setSkillLevel] = useState<SkillLevel>('medium');
  const [archetype, setArchetype] = useState<ArchetypeId | 'random'>('random');
  const [botName, setBotName] = useState('');

  const handleSubmit = () => {
    onAddBot({
      skillLevel,
      archetype,
      botName: botName.trim() || '',
    });
    setOpen(false);
    setSkillLevel('medium');
    setArchetype('random');
    setBotName('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {children}
      </PopoverTrigger>
      <PopoverContent className="w-72" align="start">
        <div className="space-y-4">
          <h4 className="font-medium text-sm">Add Bot Player</h4>

          <div className="space-y-2">
            <Label htmlFor="bot-name">Name (optional)</Label>
            <Input
              id="bot-name"
              placeholder="Auto-generated"
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
              maxLength={20}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="skill-level">Skill Level</Label>
            <Select value={skillLevel} onValueChange={(v) => setSkillLevel(v as SkillLevel)}>
              <SelectTrigger id="skill-level">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SKILL_LEVELS.map((level) => (
                  <SelectItem key={level.value} value={level.value}>
                    {level.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="archetype">Strategy</Label>
            <Select value={archetype} onValueChange={(v) => setArchetype(v as ArchetypeId | 'random')}>
              <SelectTrigger id="archetype">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ARCHETYPES.map((a) => (
                  <SelectItem key={a.value} value={a.value}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button onClick={handleSubmit} className="w-full" size="sm">
            Add Bot
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export { BotConfigPopover };
export type { BotConfigPopoverProps };
