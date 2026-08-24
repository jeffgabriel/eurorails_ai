import { Player } from "../../shared/types/GameTypes";

/**
 * Merge a server-authoritative player row into the locally-held player.
 *
 * Single source of truth for both sync paths (socket state:patch and HTTP
 * player refresh). Rules:
 * - Base: spread merge — server fields win, keys absent from the server row
 *   keep their local values (patches may carry partial rows).
 * - hand: server wins when provided (issue #176 — hands are public and
 *   server-authoritative).
 * - trainState, when the server row carries one:
 *   - local player with existing trainState: server trainState wins EXCEPT the
 *     client-managed fields — position (local kept if set; the server copy can
 *     be outdated mid-turn), movementHistory (local kept if non-empty; needed
 *     for direction-reversal checks), remainingMovement (server never manages
 *     it; critical for ferry half-rate), ferryState and justCrossedFerry
 *     (client-managed).
 *   - otherwise: server trainState taken as-is.
 * - trainState, when the server row omits it: local trainState kept. The HTTP
 *   refresh path's "reset non-local trainState to empty" is call-site policy
 *   in PlayerStateService, deliberately NOT applied here — the socket patch
 *   path must keep local state when a partial row omits trainState.
 *
 * Pure: neither input is mutated.
 */
export function mergeServerPlayerState(
  local: Player,
  server: Player,
  isLocalPlayer: boolean,
): Player {
  const merged: Player = {
    ...local,
    ...server,
    hand: server.hand || local.hand,
    trainState: local.trainState,
  };

  if (!server.trainState) {
    return merged;
  }

  if (isLocalPlayer && local.trainState) {
    merged.trainState = {
      ...server.trainState,
      position: local.trainState.position || server.trainState.position,
      movementHistory: local.trainState.movementHistory?.length
        ? local.trainState.movementHistory
        : (server.trainState.movementHistory || []),
      remainingMovement: typeof local.trainState.remainingMovement === "number"
        ? local.trainState.remainingMovement
        : server.trainState.remainingMovement,
      ferryState: local.trainState.ferryState ?? server.trainState.ferryState,
      justCrossedFerry: local.trainState.justCrossedFerry ?? server.trainState.justCrossedFerry,
    };
  } else {
    merged.trainState = server.trainState;
  }

  return merged;
}
