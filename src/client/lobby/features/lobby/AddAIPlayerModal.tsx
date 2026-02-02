// features/lobby/AddAIPlayerModal.tsx
import { useState } from 'react';
import { Brain, Network, Zap, Shield, Anchor, Sparkles, Bot } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group';
import type { AIDifficulty, AIPersonality } from '../../shared/types';

interface AddAIPlayerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddAIPlayer: (difficulty: AIDifficulty, personality: AIPersonality) => Promise<void>;
  isLoading?: boolean;
  availableColors: string[];
}

const difficulties: Array<{ value: AIDifficulty; label: string; description: string }> = [
  { value: 'easy', label: 'Easy', description: '1 turn planning' },
  { value: 'medium', label: 'Medium', description: '3 turns planning' },
  { value: 'hard', label: 'Hard', description: '5 turns planning' },
];

const personalities: Array<{
  value: AIPersonality;
  label: string;
  description: string;
  icon: typeof Brain;
}> = [
  { value: 'optimizer', label: 'Optimizer', description: 'ROI focused', icon: Brain },
  { value: 'network_builder', label: 'Network Builder', description: 'Infrastructure first', icon: Network },
  { value: 'opportunist', label: 'Opportunist', description: 'High risk', icon: Zap },
  { value: 'blocker', label: 'Blocker', description: 'Deny others', icon: Shield },
  { value: 'steady_hand', label: 'Steady Hand', description: 'Low risk', icon: Anchor },
  { value: 'chaos_agent', label: 'Chaos Agent', description: 'Unpredictable', icon: Sparkles },
];

function getPreviewDescription(difficulty: AIDifficulty, personality: AIPersonality): string {
  const difficultyText = {
    easy: 'Plans 1 turn ahead',
    medium: 'Plans 2-3 turns ahead',
    hard: 'Plans 4-5 turns ahead',
  }[difficulty];

  const personalityText = {
    optimizer: 'maximizing ROI on every decision with analytical precision',
    network_builder: 'building infrastructure for long-term strategic advantage',
    opportunist: 'chasing high-value opportunities with bold, adaptive moves',
    blocker: 'denying opponents key positions and resources',
    steady_hand: 'making consistent, low-risk progress toward victory',
    chaos_agent: 'keeping opponents guessing with unpredictable moves',
  }[personality];

  return `${difficultyText}, ${personalityText}.`;
}

export function AddAIPlayerModal({
  open,
  onOpenChange,
  onAddAIPlayer,
  isLoading = false,
  availableColors,
}: AddAIPlayerModalProps) {
  const [difficulty, setDifficulty] = useState<AIDifficulty>('medium');
  const [personality, setPersonality] = useState<AIPersonality>('optimizer');

  const handleSubmit = async () => {
    try {
      await onAddAIPlayer(difficulty, personality);
      onOpenChange(false);
      // Reset to defaults
      setDifficulty('medium');
      setPersonality('optimizer');
    } catch {
      // Error handling is done by the parent
    }
  };

  const handleCancel = () => {
    setDifficulty('medium');
    setPersonality('optimizer');
    onOpenChange(false);
  };

  const personalityInfo = personalities.find((p) => p.value === personality);
  const difficultyInfo = difficulties.find((d) => d.value === difficulty);
  const PersonalityIcon = personalityInfo?.icon || Brain;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-5 text-purple-500" />
            Add AI Player
          </DialogTitle>
          <DialogDescription>
            Configure an AI opponent to join your game.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Difficulty Selection */}
          <div className="space-y-3">
            <Label className="text-base font-medium">Difficulty</Label>
            <RadioGroup
              value={difficulty}
              onValueChange={(value) => setDifficulty(value as AIDifficulty)}
              className="grid grid-cols-3 gap-2"
            >
              {difficulties.map((d) => (
                <div key={d.value}>
                  <RadioGroupItem
                    value={d.value}
                    id={`difficulty-${d.value}`}
                    className="peer sr-only"
                    disabled={isLoading}
                  />
                  <Label
                    htmlFor={`difficulty-${d.value}`}
                    className={`flex flex-col items-center justify-center rounded-lg border-2 p-3 cursor-pointer transition-all
                      hover:bg-accent/5
                      peer-data-[state=checked]:border-purple-500 peer-data-[state=checked]:bg-purple-50
                      peer-disabled:cursor-not-allowed peer-disabled:opacity-50
                      ${difficulty === d.value ? 'border-purple-500 bg-purple-50' : 'border-muted'}`}
                  >
                    <span className="font-medium text-sm">{d.label}</span>
                    <span className="text-xs text-muted-foreground">{d.description}</span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          {/* Personality Selection */}
          <div className="space-y-3">
            <Label className="text-base font-medium">Personality</Label>
            <RadioGroup
              value={personality}
              onValueChange={(value) => setPersonality(value as AIPersonality)}
              className="grid grid-cols-2 gap-2"
            >
              {personalities.map((p) => {
                const Icon = p.icon;
                return (
                  <div key={p.value}>
                    <RadioGroupItem
                      value={p.value}
                      id={`personality-${p.value}`}
                      className="peer sr-only"
                      disabled={isLoading}
                    />
                    <Label
                      htmlFor={`personality-${p.value}`}
                      className={`flex items-center gap-2 rounded-lg border-2 p-3 cursor-pointer transition-all
                        hover:bg-accent/5
                        peer-data-[state=checked]:border-purple-500 peer-data-[state=checked]:bg-purple-50
                        peer-disabled:cursor-not-allowed peer-disabled:opacity-50
                        ${personality === p.value ? 'border-purple-500 bg-purple-50' : 'border-muted'}`}
                    >
                      <Icon className="size-4 text-purple-500 shrink-0" />
                      <div className="min-w-0">
                        <span className="font-medium text-sm block truncate">{p.label}</span>
                        <span className="text-xs text-muted-foreground block truncate">{p.description}</span>
                      </div>
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>
          </div>

          {/* Preview */}
          <div className="rounded-lg border bg-muted/50 p-4">
            <div className="flex items-center gap-2 mb-2">
              <PersonalityIcon className="size-4 text-purple-500" />
              <span className="font-medium text-sm">
                {difficultyInfo?.label} {personalityInfo?.label}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {getPreviewDescription(difficulty, personality)}
            </p>
          </div>

          {/* Available colors info */}
          {availableColors.length === 0 && (
            <p className="text-sm text-destructive">
              No colors available. The game is full.
            </p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isLoading || availableColors.length === 0}
            >
              {isLoading ? 'Adding...' : 'Add Player'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
