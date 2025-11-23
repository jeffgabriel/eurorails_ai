import { PlayerTrackState } from '../../shared/types/TrackTypes';
import { config } from '../config/apiConfig';

export class TrackService {
  async saveTrackState(gameId: string, playerId: string, trackState: PlayerTrackState): Promise<boolean> {
    try {
      const response = await fetch(`${config.apiBaseUrl}/api/tracks/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId, playerId, trackState })
      });
      return response.ok;
    } catch (error) {
      console.error('TrackService.saveTrackState error:', error);
      return false;
    }
  }

  async loadTrackState(gameId: string, playerId: string): Promise<PlayerTrackState | null> {
    try {
      const response = await fetch(`${config.apiBaseUrl}/api/tracks/${gameId}/${playerId}`);
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      console.error('TrackService.loadTrackState error:', error);
      return null;
    }
  }

  async loadAllTracks(gameId: string): Promise<PlayerTrackState[]> {
    try {
      const response = await fetch(`${config.apiBaseUrl}/api/tracks/${gameId}`);
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