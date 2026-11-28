import { TrackSegment } from '../../shared/types/GameTypes';
import { PlayerTrackState } from '../../shared/types/TrackTypes';
import { config } from '../config/apiConfig';
import { authenticatedFetch } from './authenticatedFetch';

/** What the server did with the track a player drew. */
export type TrackBuildResult =
  | {
      ok: true;
      /** The sections as the server stored them, with the server's costs. */
      segments: TrackSegment[];
      /** Total cost of those sections, in ECU millions. */
      cost: number;
      /** The player's build spend this turn that has not been charged yet. */
      turnBuildCost: number;
    }
  | { ok: false; message: string };

/** What the server did with a request to undo the last section built this turn. */
export type TrackUndoResult =
  | {
      ok: true;
      removedSegment: TrackSegment;
      turnBuildCost: number;
      /** The player's money after any refund. */
      money: number;
    }
  | { ok: false; message: string };

const BUILD_FAILED_MESSAGE = 'Track could not be built';
const UNDO_FAILED_MESSAGE = 'Track could not be undone';

/** The server's explanation for a refusal, when the response carries one. */
async function refusalMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    const details = (body as { details?: unknown } | null)?.details;
    return typeof details === 'string' && details.length > 0 ? details : fallback;
  } catch {
    return fallback;
  }
}

export class TrackService {
  /**
   * Ask the server to build the sections the player drew. Only the mileposts
   * are sent: the server checks the build rules and works out every cost
   * itself. It builds all of the sections or none of them.
   */
  async buildTrack(gameId: string, segments: readonly TrackSegment[]): Promise<TrackBuildResult> {
    try {
      const response = await authenticatedFetch(`${config.apiBaseUrl}/api/tracks/build`, {
        method: 'POST',
        body: JSON.stringify({
          gameId,
          segments: segments.map((segment: TrackSegment) => ({
            from: { row: segment.from.row, col: segment.from.col },
            to: { row: segment.to.row, col: segment.to.col },
          })),
        })
      });
      if (!response.ok) {
        return { ok: false, message: await refusalMessage(response, BUILD_FAILED_MESSAGE) };
      }
      const result = await response.json();
      return { ok: true, segments: result.segments, cost: result.cost, turnBuildCost: result.turnBuildCost };
    } catch (error) {
      console.error('TrackService.buildTrack error:', error);
      return { ok: false, message: BUILD_FAILED_MESSAGE };
    }
  }

  /** Ask the server to remove the last section the player built this turn. */
  async undoLastSegment(gameId: string): Promise<TrackUndoResult> {
    try {
      const response = await authenticatedFetch(`${config.apiBaseUrl}/api/tracks/undo-segment`, {
        method: 'POST',
        body: JSON.stringify({ gameId })
      });
      if (!response.ok) {
        return { ok: false, message: await refusalMessage(response, UNDO_FAILED_MESSAGE) };
      }
      const result = await response.json();
      return {
        ok: true,
        removedSegment: result.removedSegment,
        turnBuildCost: result.turnBuildCost,
        money: result.money,
      };
    } catch (error) {
      console.error('TrackService.undoLastSegment error:', error);
      return { ok: false, message: UNDO_FAILED_MESSAGE };
    }
  }

  async loadTrackState(gameId: string, playerId: string): Promise<PlayerTrackState | null> {
    try {
      const response = await authenticatedFetch(`${config.apiBaseUrl}/api/tracks/${gameId}/${playerId}`);
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      console.error('TrackService.loadTrackState error:', error);
      return null;
    }
  }

  async loadAllTracks(gameId: string): Promise<PlayerTrackState[]> {
    try {
      const response = await authenticatedFetch(`${config.apiBaseUrl}/api/tracks/${gameId}`);
      if (!response.ok) {
        throw new Error(`Failed to load tracks: HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      console.error('TrackService.loadAllTracks error:', error);
      throw error;
    }
  }
} 