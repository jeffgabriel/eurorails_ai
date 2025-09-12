// features/lobby/JoinGameModal.tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '../../components/ui/form';
import { useLobbyStore } from '../../store/lobby.store';
import type { JoinGameForm } from '../../shared/types';

const joinGameSchema = z.object({
  joinCode: z.string()
    .min(1, 'Join code is required')
    .regex(/^[A-Z0-9]+$/, 'Join code must contain only letters and numbers')
    .transform(val => val.toUpperCase()),
});

interface JoinGameModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function JoinGameModal({ open, onOpenChange }: JoinGameModalProps) {
  const { joinGame, isLoading } = useLobbyStore();

  const form = useForm<JoinGameForm>({
    resolver: zodResolver(joinGameSchema),
    defaultValues: {
      joinCode: '',
    },
  });

  const onSubmit = async (data: JoinGameForm) => {
    try {
      const game = await joinGame(data);
      toast.success(`Joined game successfully!`);
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
          <DialogTitle>Join Game</DialogTitle>
          <DialogDescription>
            Enter the join code provided by the game creator.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
                      onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                      disabled={isLoading}
                    />
                  </FormControl>
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
                {isLoading ? 'Joining...' : 'Join Game'}
              </Button>
            </div>
          </form>
        </Form>

        <div className="mt-4 p-4 bg-muted rounded-lg">
          <h4 className="font-medium mb-2">Tips</h4>
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>• Join codes are case-insensitive</p>
            <p>• Make sure the game hasn't started yet</p>
            <p>• Contact the game creator if you have issues</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}