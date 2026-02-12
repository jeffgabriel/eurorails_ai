import { useState } from 'react';
import { Bot, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { BotSkillLevel, BotArchetype } from '../../../../shared/types/GameTypes';
import { getArchetypeDisplay, getSkillLevelDisplay } from '../../shared/botDisplayUtils';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';

interface BotConfigPopoverProps {
  gameId: string;
  onAddBot: (config: { skillLevel: string; archetype: string; name?: string }) => Promise<void>;
  disabled?: boolean;
}

export function BotConfigPopover({ gameId, onAddBot, disabled }: BotConfigPopoverProps) {
  const [open, setOpen] = useState(false);
  const [skillLevel, setSkillLevel] = useState<string>(BotSkillLevel.Medium);
  const [archetype, setArchetype] = useState<string>('random');
  const [name, setName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetForm = () => {
    setSkillLevel(BotSkillLevel.Medium);
    setArchetype('random');
    setName('');
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await onAddBot({
        skillLevel,
        archetype,
        name: name.trim() || undefined,
      });
      toast.success('Bot added to the game');
      setOpen(false);
      resetForm();
    } catch {
      toast.error('Failed to add bot');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setOpen(false);
    resetForm();
  };

  const nameError = name.length > 20 ? 'Name must be 20 characters or fewer' : '';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <Bot className="size-4 mr-1" />
          Add Bot
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="space-y-4">
          <div className="space-y-1">
            <h4 className="font-medium text-sm">Add AI Bot</h4>
            <p className="text-xs text-muted-foreground">Configure the bot's difficulty and play style.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bot-skill-level">Skill Level</Label>
            <Select value={skillLevel} onValueChange={setSkillLevel} disabled={isSubmitting}>
              <SelectTrigger id="bot-skill-level" aria-label="Skill level">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(BotSkillLevel).map((level) => {
                  const display = getSkillLevelDisplay(level);
                  return (
                    <SelectItem key={level} value={level}>
                      <span className={display.color}>{display.label}</span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bot-archetype">Play Style</Label>
            <Select value={archetype} onValueChange={setArchetype} disabled={isSubmitting}>
              <SelectTrigger id="bot-archetype" aria-label="Play style">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="random">Random</SelectItem>
                {Object.values(BotArchetype).map((arch) => {
                  const display = getArchetypeDisplay(arch);
                  return (
                    <SelectItem key={arch} value={arch}>
                      <span className={display.color}>{display.label}</span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bot-name">Bot Name (optional)</Label>
            <Input
              id="bot-name"
              aria-label="Bot name"
              placeholder="Auto-generated if empty"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              disabled={isSubmitting}
            />
            {nameError && (
              <p className="text-xs text-destructive" aria-live="polite">{nameError}</p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={isSubmitting || !!nameError}>
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 mr-1 animate-spin" />
                  Adding...
                </>
              ) : (
                'Add Bot'
              )}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
