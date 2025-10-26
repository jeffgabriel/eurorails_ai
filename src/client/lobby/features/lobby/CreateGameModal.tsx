// features/lobby/CreateGameModal.tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '../../components/ui/form';
import { Switch } from '../../components/ui/switch';
import { useLobbyStore } from '../../store/lobby.store';
import type { CreateGameForm } from '../../shared/types';

const createGameSchema = z.object({
  isPublic: z.boolean().default(false),
  creatorColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a valid hex code (e.g., #ff0000)').optional(),
});

interface CreateGameModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateGameModal({ open, onOpenChange }: CreateGameModalProps) {
  const { createGame, isLoading } = useLobbyStore();

  const form = useForm<CreateGameForm>({
    resolver: zodResolver(createGameSchema),
    defaultValues: {
      isPublic: false,
      creatorColor: '#ff0000', // Default to red
    },
  });

  const onSubmit = async (data: CreateGameForm) => {
    try {
      const game = await createGame(data);
      toast.success(`Game created! Join code: ${game.joinCode}`);
      onOpenChange(false);
      form.reset();
    } catch {
      // Error handling is done via the lobby store and useEffect
    }
  };

  const handleCancel = () => {
    form.reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create New Game</DialogTitle>
          <DialogDescription>
            Set up a new EuroRails game and invite your friends to join.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="isPublic"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">
                      Public Game
                    </FormLabel>
                    <div className="text-sm text-muted-foreground">
                      Allow anyone to find and join your game
                    </div>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={isLoading}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="creatorColor"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-base">Choose Your Color</FormLabel>
                  <div className="grid grid-cols-3 gap-2 mt-2">
                    {[
                      { name: 'Red', value: '#ff0000' },
                      { name: 'Blue', value: '#0000ff' },
                      { name: 'Green', value: '#008000' },
                      { name: 'Yellow', value: '#ffd700' },
                      { name: 'Black', value: '#000000' },
                      { name: 'Brown', value: '#8b4513' },
                    ].map((color) => (
                      <button
                        key={color.value}
                        type="button"
                        className={`w-full h-12 rounded transition-all relative ${
                          field.value === color.value
                            ? 'scale-105 shadow-lg border-4'
                            : 'border-2 border-gray-300 hover:border-gray-500'
                        }`}
                        style={{ 
                          backgroundColor: color.value,
                          borderColor: field.value === color.value ? '#60a5fa' : undefined,
                          boxShadow: field.value === color.value ? '0 0 0 3px rgba(96, 165, 250, 0.5), 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)' : undefined
                        }}
                        onClick={() => field.onChange(color.value)}
                        disabled={isLoading}
                      >
                        <span className="text-white font-semibold text-xs drop-shadow-lg">
                          {color.name}
                        </span>
                      </button>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

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
                type="submit" 
                disabled={isLoading}
              >
                {isLoading ? 'Creating...' : 'Create Game'}
              </Button>
            </div>
          </form>
        </Form>

        <div className="mt-4 p-4 bg-muted rounded-lg">
          <h4 className="font-medium mb-2">Game Settings</h4>
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>• Maximum players: 6</p>
            <p>• Game mode: Classic EuroRails</p>
            <p>• Turn time limit: 5 minutes</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}