import { useState } from 'react';
import { Bot, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { BotSkillLevel, LLMProvider, LLM_DEFAULT_MODELS } from '../../../../shared/types/GameTypes';
import { getSkillLevelDisplay } from '../../shared/botDisplayUtils';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';

interface BotConfigPopoverProps {
  gameId: string;
  onAddBot: (config: { skillLevel: string; name?: string; provider?: string; model?: string }) => Promise<void>;
  disabled?: boolean;
}

export function BotConfigPopover({ gameId, onAddBot, disabled }: BotConfigPopoverProps) {
  const [open, setOpen] = useState(false);
  const [skillLevel, setSkillLevel] = useState<string>(BotSkillLevel.Easy);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<string>(LLMProvider.Anthropic);
  const [model, setModel] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const defaultModel = LLM_DEFAULT_MODELS[provider as LLMProvider]?.[skillLevel as BotSkillLevel] ?? '';

  const resetForm = () => {
    setSkillLevel(BotSkillLevel.Easy);
    setName('');
    setProvider(LLMProvider.Anthropic);
    setModel('');
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    // Close popover and reset immediately — the socket lobby-updated event
    // may unmount this component before the API response arrives, leaving
    // the Radix portal stranded if we wait to close after the await.
    setOpen(false);
    const config = {
      skillLevel,
      name: name.trim() || undefined,
      provider: provider || undefined,
      model: model.trim() || undefined,
    };
    resetForm();
    try {
      await onAddBot(config);
      toast.success('Bot added to the game');
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
            <p className="text-xs text-muted-foreground">Configure the bot's difficulty.</p>
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
            <Label htmlFor="bot-provider">LLM Provider</Label>
            <Select value={provider} onValueChange={(v) => { setProvider(v); setModel(''); }} disabled={isSubmitting}>
              <SelectTrigger id="bot-provider" aria-label="LLM provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(LLMProvider).map((p) => (
                  <SelectItem key={p} value={p}>
                    {p === LLMProvider.Anthropic ? 'Anthropic (Claude)' : 'Google (Gemini)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bot-model">Model (optional)</Label>
            <Input
              id="bot-model"
              aria-label="Model override"
              placeholder={defaultModel}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={isSubmitting}
            />
            <p className="text-xs text-muted-foreground">Leave blank for default based on skill level.</p>
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
