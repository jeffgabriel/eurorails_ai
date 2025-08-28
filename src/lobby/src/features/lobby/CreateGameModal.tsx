// features/lobby/CreateGameModal.tsx
import { useForm } from 'react-hook-form@7.55.0';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner@2.0.3';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '../../components/ui/form';
import { Switch } from '../../components/ui/switch';
import { useLobbyStore } from '../../store/lobby.store';
import type { CreateGameForm } from '../../shared/types';

const createGameSchema = z.object({
  isPublic: z.boolean().default(false),
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