// features/lobby/JoinGameModal.tsx
import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '../../components/ui/form';
import { useLobbyStore } from '../../store/lobby.store';
import { api } from '../../shared/api';
import type { JoinGameForm } from '../../shared/types';

const getColorName = (colorValue: string): string => {
  const colorMap: Record<string, string> = {
    '#ff0000': 'Red',
    '#0000ff': 'Blue',
    '#008000': 'Green',
    '#ffd700': 'Yellow',
    '#000000': 'Black',
    '#8b4513': 'Brown',
  };
  return colorMap[colorValue] || 'Unknown';
};

const joinGameSchema = z.object({
  joinCode: z.string()
    .min(1, 'Join code is required')
    .regex(/^[A-Z0-9]+$/, 'Join code must contain only letters and numbers')
    .transform(val => val.toUpperCase()),
  selectedColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a valid hex code (e.g., #ff0000)').optional(),
});

interface JoinGameModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function JoinGameModal({ open, onOpenChange }: JoinGameModalProps) {
  const { joinGame, isLoading } = useLobbyStore();
  const [joinStep, setJoinStep] = useState<'code' | 'color'>('code');
  const [availableColors, setAvailableColors] = useState<string[]>([]);
  const [validatedGameId, setValidatedGameId] = useState<string>('');
  const [isValidatingCode, setIsValidatingCode] = useState(false);
  const [joinCodeValue, setJoinCodeValue] = useState('');

  const form = useForm<JoinGameForm>({
    resolver: zodResolver(joinGameSchema),
    defaultValues: {
      joinCode: '',
      selectedColor: '',
    },
  });

  const validateJoinCode = useCallback(async (joinCode: string) => {
    if (!joinCode || joinCode.length !== 8) {
      // Reset state if join code is invalid
      setValidatedGameId('');
      setAvailableColors([]);
      setJoinStep('code');
      return;
    }

    setIsValidatingCode(true);
    try {
      // First, validate the join code by getting the game
      const gameResult = await api.getGameByJoinCode(joinCode);
      
      // Race condition prevention: Check if join code is still current
      const currentJoinCode = form.getValues('joinCode');
      if (currentJoinCode !== joinCode) {
        return;
      }
      
      const gameId = gameResult.game.id;
      setValidatedGameId(gameId);
      
      // Then fetch available colors for this game
      const colorsResult = await api.getAvailableColors(gameId);
      
      // Race condition prevention: Check again if join code is still current
      const currentJoinCodeAfterColors = form.getValues('joinCode');
      if (currentJoinCodeAfterColors !== joinCode) {
        return;
      }
      
      setAvailableColors(colorsResult.colors);
      
      // Check if game is full (no available colors)
      if (colorsResult.colors.length === 0) {
        toast.error('This game is full - no available colors. Please try another game.');
        return;
      }
      
      // Set the first available color as default
      form.setValue('selectedColor', colorsResult.colors[0]);
      
      // Move to color selection step
      setJoinStep('color');
      
    } catch (error) {
      console.error('Validation error:', error);
      // Only update state if this is still the current join code
      const currentJoinCode = form.getValues('joinCode');
      if (currentJoinCode === joinCode) {
        setValidatedGameId('');
        setAvailableColors([]);
        setJoinStep('code');
      }
    } finally {
      setIsValidatingCode(false);
    }
  }, [form, api]);

  // Debounced validation effect
  useEffect(() => {
    const timer = setTimeout(() => {
      if (joinCodeValue && joinCodeValue.length === 8) {
        validateJoinCode(joinCodeValue);
      } else {
        // Reset if code is too short or empty
        setValidatedGameId('');
        setAvailableColors([]);
        setJoinStep('code');
      }
    }, 800); // 800ms debounce

    return () => clearTimeout(timer);
  }, [joinCodeValue, validateJoinCode]);

  const onSubmit = async (data: JoinGameForm) => {
    try {
      const game = await joinGame(data);
      toast.success(`Joined game successfully!`);
      onOpenChange(false);
      form.reset();
      setJoinStep('code');
      setAvailableColors([]);
      setValidatedGameId('');
    } catch {
      // Error handling is done via the lobby store and useEffect
    }
  };

  const handleCancel = () => {
    form.reset();
    setJoinStep('code');
    setAvailableColors([]);
    setValidatedGameId('');
    onOpenChange(false);
  };

  const handleBackToCode = () => {
    setJoinStep('code');
    setAvailableColors([]);
    setValidatedGameId('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Join Game</DialogTitle>
          <DialogDescription>
            Enter the join code provided by the game creator.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {joinStep === 'code' ? (
              <>
                <FormField
                  control={form.control}
                  name="joinCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Join Code</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Enter join code (e.g., ABCD1234)"
                          className="font-mono text-lg text-center tracking-wider"
                          {...field}
                          value={field.value.toUpperCase()}
                          onChange={(e) => {
                            const upperValue = e.target.value.toUpperCase();
                            field.onChange(upperValue);
                            setJoinCodeValue(upperValue);
                          }}
                          disabled={isValidatingCode}
                        />
                      </FormControl>
                      <FormMessage />
                      {isValidatingCode && (
                        <p className="text-sm text-blue-600 mt-2">
                          🔍 Validating join code...
                        </p>
                      )}
                      {validatedGameId && !isValidatingCode && (
                        <p className="text-sm text-green-600 mt-2">
                          ✅ Join code is valid! Available colors loaded.
                        </p>
                      )}
                    </FormItem>
                  )}
                />

                <div className="flex justify-end gap-2">
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={handleCancel}
                    disabled={isValidatingCode}
                  >
                    Cancel
                  </Button>
                  <Button 
                    type="button"
                    onClick={() => validateJoinCode(form.getValues('joinCode'))}
                    disabled={!form.getValues('joinCode') || isValidatingCode || !!validatedGameId}
                  >
                    {isValidatingCode ? 'Validating...' : validatedGameId ? 'Validated ✓' : 'Next'}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="text-center mb-4">
                  <p className="text-sm text-muted-foreground">
                    Join code <span className="font-mono font-semibold">{form.getValues('joinCode')}</span> is valid!
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Choose your color from the available options:
                  </p>
                </div>

                <FormField
                  control={form.control}
                  name="selectedColor"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base">Choose Your Color</FormLabel>
                      <div className="grid grid-cols-3 gap-2 mt-2">
                        {availableColors.map((colorValue) => {
                          const colorName = getColorName(colorValue);
                          return (
                            <button
                              key={colorValue}
                              type="button"
                              className={`w-full h-12 rounded transition-all relative ${
                                field.value === colorValue
                                  ? 'scale-105 shadow-lg border-4'
                                  : 'border-2 border-gray-300 hover:border-gray-500'
                              }`}
                              style={{ 
                                backgroundColor: colorValue,
                                borderColor: field.value === colorValue ? '#60a5fa' : undefined,
                                boxShadow: field.value === colorValue ? '0 0 0 3px rgba(96, 165, 250, 0.5), 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)' : undefined
                              }}
                              onClick={() => field.onChange(colorValue)}
                              disabled={isLoading}
                            >
                              <span className="text-white font-semibold text-xs drop-shadow-lg">
                                {colorName}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex justify-between gap-2">
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={handleBackToCode}
                    disabled={isLoading}
                  >
                    Back
                  </Button>
                  <div className="flex gap-2">
                    <Button 
                      type="button" 
                      variant="outline" 
                      onClick={handleCancel}
                      disabled={isLoading}
                    >
                      Cancel
                    </Button>
                    <Button 
                      type="submit" 
                      disabled={isLoading || !form.getValues('selectedColor')}
                    >
                      {isLoading ? 'Joining...' : 'Join Game'}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </form>
        </Form>

        <div className="mt-4 p-4 bg-muted rounded-lg">
          <h4 className="font-medium mb-2">Tips</h4>
          <div className="space-y-1 text-sm text-muted-foreground">
            {joinStep === 'code' ? (
              <>
                <p>• Join codes are case-insensitive</p>
                <p>• Make sure the game hasn't started yet</p>
                <p>• Contact the game creator if you have issues</p>
              </>
            ) : (
              <>
                <p>• Only available colors are shown</p>
                <p>• Each player must have a unique color</p>
                <p>• You can go back to change the join code</p>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}