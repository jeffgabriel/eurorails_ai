// Core types for graph representation
export interface TrackNetwork {
  nodes: Set<string>;  // Set of milepost IDs in the network
  edges: Map<string, Set<string>>;  // Adjacency list representation
}

// Database storage - we can serialize this efficiently
export interface PlayerTrackState {
  playerId: string;
  gameId: string;
  // Store as JSON - can be reconstructed into TrackNetwork
  networkState: {
      nodes: string[];  // Array of milepost IDs
      edges: [string, string][]; // Array of [from, to] pairs
  };
  totalCost: number;
  lastTurnCost: number;
  lastBuildTimestamp: Date;
}