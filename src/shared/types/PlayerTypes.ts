import { Milepost } from './GameTypes';
import { PlayerTrackState } from './TrackTypes';

// Core types for graph representation
export interface TrackNetwork {
  nodes: Set<Milepost>;  // Set of mileposts in the network
  edges: Map<Milepost, Set<Milepost>>;  // Adjacency list representation
}

// Re-export PlayerTrackState for backward compatibility
export type { PlayerTrackState } from './TrackTypes';