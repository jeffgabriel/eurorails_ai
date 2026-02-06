import { useState } from 'react';
import { Bot, Plus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { api } from '../../shared/api';

const DIFFICULTY_OPTIONS = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
] as const;

const ARCHETYPE_OPTIONS = [
  { value: 'backbone_builder', label: 'Backbone Builder', icon: '🦴' },
  { value: 'freight_optimizer', label: 'Freight Optimizer', icon: '📦' },
  { value: 'trunk_sprinter', label: 'Trunk Sprinter', icon: '🚄' },
  { value: 'continental_connector', label: 'Continental Connector', icon: '🗺️' },
  { value: 'opportunist', label: 'Opportunist', icon: '🔀' },
] as const;

interface AddBotPopoverProps {
  gameId: string;
  disabled?: boolean;
  onBotAdded: () => void;
}

export function AddBotPopover({ gameId, disabled, onBotAdded }: AddBotPopoverProps) {
  const [open, setOpen] = useState(false);
  const [difficulty, setDifficulty] = useState<string>('medium');
  const [archetype, setArchetype] = useState<string>('backbone_builder');
  const [botName, setBotName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setDifficulty('medium');
    setArchetype('backbone_builder');
    setBotName('');
    setError(null);
  };

  const handleSubmit = async () => {
    setIsLoading(true);
    setError(null);

    try {
      await api.addAIPlayer(gameId, {
        difficulty,
        archetype,
        ...(botName.trim() ? { name: botName.trim() } : {}),
      });
      toast.success('Bot added to game');
      setOpen(false);
      resetForm();
      onBotAdded();
    } catch (err: unknown) {
      const message = (err && typeof err === 'object' && 'message' in err)
        ? String((err as { message: string }).message)
        : 'Failed to add bot';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={(isOpen) => {
      setOpen(isOpen);
      if (!isOpen) resetForm();
    }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label="Add AI bot player"
        >
          <Bot className="size-4 mr-2" />
          Add Bot
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="space-y-4">
          <div>
            <h4 className="font-medium text-sm">Add AI Player</h4>
            <p className="text-xs text-muted-foreground mt-1">
              Configure the bot's difficulty and strategy.
            </p>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="bot-difficulty">Difficulty</Label>
              <Select value={difficulty} onValueChange={setDifficulty} disabled={isLoading}>
                <SelectTrigger id="bot-difficulty" aria-label="Select difficulty">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIFFICULTY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="bot-archetype">Strategy</Label>
              <Select value={archetype} onValueChange={setArchetype} disabled={isLoading}>
                <SelectTrigger id="bot-archetype" aria-label="Select strategy archetype">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ARCHETYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.icon} {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="bot-name">Name (optional)</Label>
              <Input
                id="bot-name"
                placeholder="Auto-generated if empty"
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
                maxLength={30}
                disabled={isLoading}
                aria-label="Bot name"
              />
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <Button
            className="w-full"
            onClick={handleSubmit}
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />
                Adding...
              </>
            ) : (
              <>
                <Plus className="size-4 mr-2" />
                Add Bot
              </>
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
