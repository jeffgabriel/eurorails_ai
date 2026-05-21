import { useState, useEffect } from 'react';
import { Bot, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { BotSkillLevel, LLMProvider, LLM_DEFAULT_MODELS } from '../../../../shared/types/GameTypes';
import { getSkillLevelDisplay } from '../../shared/botDisplayUtils';
import { getColorName } from '../../shared/colorDisplay';
import { api } from '../../shared/api';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';

/** Derive a friendly bot name from the model identifier, e.g. "claude-haiku-4-5..." → "Haiku" */
function defaultBotName(provider: string, skillLevel: string): string {
  const model = LLM_DEFAULT_MODELS[provider as LLMProvider]?.[skillLevel as BotSkillLevel] ?? '';
  if (provider === LLMProvider.Anthropic) {
    if (model.includes('haiku')) return 'Haiku';
    if (model.includes('sonnet')) return 'Sonnet';
    if (model.includes('opus')) return 'Opus';
  }
  if (provider === LLMProvider.Google) {
    if (model.includes('flash')) return 'Flash';
    if (model.includes('pro')) return 'Pro';
  }
  if (provider === LLMProvider.OpenAI) {
    if (model.includes('nano')) return 'Nano';
    if (model.includes('mini')) return 'Mini';
    if (model.includes('gpt-5.4')) return 'GPT-5.4';
  }
  return '';
}

interface BotConfigPopoverProps {
  gameId: string;
  onAddBot: (config: { skillLevel: string; name?: string; provider?: string; model?: string; color?: string }) => Promise<void>;
  disabled?: boolean;
}

export function BotConfigPopover({ gameId, onAddBot, disabled }: BotConfigPopoverProps) {
  const [open, setOpen] = useState(false);
  const [skillLevel, setSkillLevel] = useState<string>(BotSkillLevel.Easy);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<string>(LLMProvider.Anthropic);
  const [model, setModel] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Color picker state
  const [availableColors, setAvailableColors] = useState<string[]>([]);
  const [selectedColor, setSelectedColor] = useState<string | null>(null);
  const [isLoadingColors, setIsLoadingColors] = useState(false);
  const [colorsError, setColorsError] = useState<string | null>(null);

  const defaultModel = LLM_DEFAULT_MODELS[provider as LLMProvider]?.[skillLevel as BotSkillLevel] ?? '';
  const derivedName = defaultBotName(provider, skillLevel);

  const resetForm = () => {
    setSkillLevel(BotSkillLevel.Easy);
    setName('');
    setProvider(LLMProvider.Anthropic);
    setModel('');
    setSelectedColor(null);
    setAvailableColors([]);
    setColorsError(null);
  };

  const fetchColors = async () => {
    setIsLoadingColors(true);
    setColorsError(null);
    try {
      const result = await api.getAvailableColors(gameId);
      setAvailableColors(result.colors);
      // Do NOT auto-select — user must pick
      setSelectedColor(null);
    } catch {
      setColorsError('Failed to load available colors');
    } finally {
      setIsLoadingColors(false);
    }
  };

  // Fetch colors on open; reset all color state on close
  useEffect(() => {
    if (open) {
      fetchColors();
    } else {
      setAvailableColors([]);
      setSelectedColor(null);
      setIsLoadingColors(false);
      setColorsError(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    // Close popover immediately — the socket lobby-updated event
    // may unmount this component before the API response arrives.
    setOpen(false);
    const config = {
      skillLevel,
      name: name.trim() || derivedName || undefined,
      provider: provider || undefined,
      model: model.trim() || undefined,
      color: selectedColor ?? undefined,
    };
    resetForm();
    try {
      await onAddBot(config);
      toast.success('Bot added to the game');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('COLOR_TAKEN')) {
        // Re-open popover, refetch colors, deselect conflicting color
        setOpen(true);
        try {
          const result = await api.getAvailableColors(gameId);
          setAvailableColors(result.colors);
          // Deselect if the attempted color is no longer available
          if (config.color && !result.colors.includes(config.color)) {
            setSelectedColor(null);
          } else {
            setSelectedColor(config.color ?? null);
          }
        } catch {
          setColorsError('Failed to reload available colors');
        }
        toast.error('That color was just taken — pick another');
      } else {
        toast.error('Failed to add bot');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setOpen(false);
    resetForm();
  };

  const nameError = name.length > 20 ? 'Name must be 20 characters or fewer' : '';
  const submitDisabled = isSubmitting || !!nameError || selectedColor === null || availableColors.length === 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <Bot className="size-4 mr-1" />
          Add Bot
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" onKeyDown={(e) => {
        if (e.key === 'Enter' && !submitDisabled) {
          e.preventDefault();
          handleSubmit();
        }
      }}>
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
                    {p === LLMProvider.Anthropic ? 'Anthropic (Claude)' : p === LLMProvider.Google ? 'Google (Gemini)' : 'OpenAI (GPT)'}
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
              placeholder={derivedName || 'Auto-generated if empty'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              disabled={isSubmitting}
            />
            {nameError && (
              <p className="text-xs text-destructive" aria-live="polite">{nameError}</p>
            )}
          </div>

          {/* Color picker section */}
          <div className="space-y-2">
            <Label>Bot Color</Label>
            {isLoadingColors ? (
              <div className="min-h-[6rem] flex items-center justify-center" aria-busy="true" aria-label="Loading available colors">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : colorsError ? (
              <div className="min-h-[6rem] flex flex-col items-center justify-center gap-2">
                <p className="text-xs text-destructive">{colorsError}</p>
                <Button type="button" variant="outline" size="sm" onClick={fetchColors}>
                  Retry
                </Button>
              </div>
            ) : availableColors.length === 0 ? (
              <p className="text-xs text-destructive">No colors available — remove a player or bot first.</p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2 mt-2">
                  {availableColors.map((colorValue) => {
                    const colorName = getColorName(colorValue);
                    return (
                      <button
                        key={colorValue}
                        type="button"
                        aria-label={colorName}
                        aria-pressed={selectedColor === colorValue}
                        className={`w-full h-12 rounded transition-all relative ${
                          selectedColor === colorValue
                            ? 'scale-105 shadow-lg border-4'
                            : 'border-2 border-gray-300 hover:border-gray-500'
                        }`}
                        style={{
                          backgroundColor: colorValue,
                          borderColor: selectedColor === colorValue ? '#60a5fa' : undefined,
                          boxShadow: selectedColor === colorValue
                            ? '0 0 0 3px rgba(96, 165, 250, 0.5), 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)'
                            : undefined,
                        }}
                        onClick={() => setSelectedColor(colorValue)}
                        disabled={isSubmitting}
                      >
                        <span className="text-white font-semibold text-xs drop-shadow-lg">
                          {colorName}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {selectedColor && (
                  <p className="text-xs text-muted-foreground">Selected: {getColorName(selectedColor)}</p>
                )}
              </>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={submitDisabled}>
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
