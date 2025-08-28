// features/game/Toasts.tsx
import { useEffect } from 'react';
import { toast } from 'sonner@2.0.3';
import { UserPlus, UserMinus, RotateCcw } from 'lucide-react';
import { useGameStore } from '../../store/game.store';
import { useAuthStore } from '../../store/auth.store';

export function Toasts() {
  const gameState = useGameStore((state) => state.gameState);
  const currentUser = useAuthStore((state) => state.user);

  // Listen for turn changes and show notifications
  useEffect(() => {
    if (!gameState || !currentUser) return;

    const currentPlayer = gameState.players.find(
      player => player.userId === gameState.currentTurnUserId
    );

    if (!currentPlayer) return;

    const isCurrentUserTurn = currentUser.id === currentPlayer.userId;

    if (isCurrentUserTurn) {
      toast.success('Your turn!', {
        icon: <RotateCcw className="size-4" />,
        description: "It's your turn to make a move",
        duration: 3000,
      });
    } else {
      toast.info(`${currentPlayer.name}'s turn`, {
        icon: <RotateCcw className="size-4" />,
        description: `Waiting for ${currentPlayer.name} to play`,
        duration: 2000,
      });
    }
  }, [gameState?.currentTurnUserId, currentUser]);

  // Listen for player presence changes
  useEffect(() => {
    if (!gameState || !currentUser) return;

    // This would ideally be triggered by presence update events
    // For now, it's just a placeholder for the component structure
  }, [gameState?.players, currentUser]);

  // Component doesn't render anything - it just handles toast notifications
  return null;
}