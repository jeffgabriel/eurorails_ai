import { Milepost } from './GameTypes';
import { PlayerTrackState, TrackBuildOptions } from './TrackTypes';

// Core types for graph representation
export interface TrackNetwork {
  nodes: Set<Milepost>;  // Set of mileposts in the network
  edges: Map<Milepost, Set<Milepost>>;  // Adjacency list representation
  buildCost?: number;  // Added to support tests
}

// Re-export types for backward compatibility
export type { PlayerTrackState, TrackBuildOptions } from './TrackTypes';