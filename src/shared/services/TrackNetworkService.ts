import { Milepost, TerrainType, TrackSegment, TrackNetwork as StringTrackNetwork } from '../types/GameTypes';
import { TrackNetwork } from '../types/PlayerTypes';

export interface SerializedNetwork {
    nodes: string[];  // We still serialize using IDs for storage
    edges: [string, string][];
}

export class TrackNetworkService {
    /**
     * Creates a new empty track network
     */
    createEmptyNetwork(): TrackNetwork {
        return {
            nodes: new Set<Milepost>(),
            edges: new Map<Milepost, Set<Milepost>>()
        };
    }

    /**
     * Adds a track segment to the network
     * Returns a new network with the added segment
     */
    addTrackSegment(network: TrackNetwork, from: Milepost, to: Milepost): TrackNetwork {
        // Create new network objects to maintain immutability
        const newNodes = new Set(network.nodes);
        const newEdges = new Map(network.edges);

        // Add nodes
        newNodes.add(from);
        newNodes.add(to);

        // Add edges (undirected graph, so add both directions)
        if (!newEdges.has(from)) {
            newEdges.set(from, new Set<Milepost>());
        }
        if (!newEdges.has(to)) {
            newEdges.set(to, new Set<Milepost>());
        }
        newEdges.get(from)!.add(to);
        newEdges.get(to)!.add(from);

        return {
            nodes: newNodes,
            edges: newEdges
        };
    }

    /**
     * Checks if two points in the network are connected
     * Uses breadth-first search
     * Considers both regular track edges and ferry connections
     */
    isConnected(network: TrackNetwork, from: Milepost, to: Milepost): boolean {
        if (!network.nodes.has(from) || !network.nodes.has(to)) {
            return false;
        }

        const visited = new Set<Milepost>();
        const queue: Milepost[] = [from];
        visited.add(from);

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (current === to) {
                return true;
            }

            // Check regular track edges
            const neighbors = network.edges.get(current) || new Set<Milepost>();
            for (const neighbor of neighbors) {
                if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    queue.push(neighbor);
                }
            }

            // Check ferry edges (virtual connections across ferry routes)
            if (network.ferryEdges) {
                const ferryNeighbor = network.ferryEdges.get(current);
                if (ferryNeighbor && !visited.has(ferryNeighbor)) {
                    visited.add(ferryNeighbor);
                    queue.push(ferryNeighbor);
                }
            }
        }

        return false;
    }

    /**
     * Finds a path between two points in the network
     * Returns array of mileposts or null if no path exists
     * Uses A* search algorithm for optimal path finding
     * Considers both regular track edges and ferry connections
     */
    findPath(network: TrackNetwork, from: Milepost, to: Milepost): Milepost[] | null {
        if (!network.nodes.has(from) || !network.nodes.has(to)) {
            return null;
        }

        // Priority queue for A* search
        const frontier: Array<[Milepost, number]> = [[from, 0]];
        const cameFrom = new Map<Milepost, Milepost>();
        const costSoFar = new Map<Milepost, number>();
        costSoFar.set(from, 0);

        while (frontier.length > 0) {
            frontier.sort((a, b) => a[1] - b[1]);
            const [current] = frontier.shift()!;

            if (current === to) {
                // Reconstruct path
                const path: Milepost[] = [current];
                let step = current;
                while (cameFrom.has(step)) {
                    step = cameFrom.get(step)!;
                    path.unshift(step);
                }
                return path;
            }

            // Collect all neighbors (track edges + ferry edges)
            const allNeighbors: Milepost[] = [];

            // Regular track edges
            const trackNeighbors = network.edges.get(current) || new Set<Milepost>();
            for (const neighbor of trackNeighbors) {
                allNeighbors.push(neighbor);
            }

            // Ferry edges (virtual connections across ferry routes)
            if (network.ferryEdges) {
                const ferryNeighbor = network.ferryEdges.get(current);
                if (ferryNeighbor) {
                    allNeighbors.push(ferryNeighbor);
                }
            }

            for (const next of allNeighbors) {
                const newCost = costSoFar.get(current)! + this.estimateDistance(current, next);

                if (!costSoFar.has(next) || newCost < costSoFar.get(next)!) {
                    costSoFar.set(next, newCost);
                    const priority = newCost + this.estimateDistance(next, to);
                    frontier.push([next, priority]);
                    cameFrom.set(next, current);
                }
            }
        }

        return null; // No path found
    }

    /**
     * Checks if a new segment can be added to the network
     * Segment must connect to existing network unless it's a major city start
     */
    canAddSegment(network: TrackNetwork, from: Milepost, to: Milepost): boolean {
        // If network is empty, must start from a major city
        if (network.nodes.size === 0) {
            return from.type === TerrainType.MajorCity
        }

        // Check if either point connects to existing network
        return this.isAdjacentToNetwork(network, from) || this.isAdjacentToNetwork(network, to);
    }

    /**
     * Checks if a milepost is adjacent to the existing network
     */
    isAdjacentToNetwork(network: TrackNetwork, milepost: Milepost): boolean {
        return network.nodes.has(milepost) || 
               Array.from(network.nodes).some(node => 
                   network.edges.get(node)?.has(milepost)
               );
    }

    /**
     * Gets all mileposts that can be reached from the current network
     */
    getReachableMileposts(network: TrackNetwork): Set<Milepost> {
        const reachable = new Set<Milepost>();
        
        // Add all directly connected nodes
        for (const node of network.nodes) {
            reachable.add(node);
            const neighbors = network.edges.get(node) || new Set<Milepost>();
            for (const neighbor of neighbors) {
                reachable.add(neighbor);
            }
        }

        return reachable;
    }

    /**
     * Serializes the network for storage
     */
    serializeNetwork(network: TrackNetwork): SerializedNetwork {
        const edges: [string, string][] = [];
        
        // Convert edges map to array of pairs
        for (const [from, toSet] of network.edges) {
            for (const to of toSet) {
                // Only add each edge once (avoid duplicates from undirected graph)
                if (from.id < to.id) {
                    edges.push([from.id, to.id]);
                }
            }
        }

        return {
            nodes: Array.from(network.nodes).map(node => node.id),
            edges: edges
        };
    }

    /**
     * Deserializes the network from storage
     */
    deserializeNetwork(serialized: SerializedNetwork, mileposts: Map<string, Milepost>): TrackNetwork {
        const network = this.createEmptyNetwork();

        // Add nodes
        for (const nodeId of serialized.nodes) {
            const milepost = mileposts.get(nodeId);
            if (milepost) {
                network.nodes.add(milepost);
            }
        }

        // Add edges
        for (const [fromId, toId] of serialized.edges) {
            const from = mileposts.get(fromId);
            const to = mileposts.get(toId);
            if (from && to) {
                if (!network.edges.has(from)) {
                    network.edges.set(from, new Set<Milepost>());
                }
                if (!network.edges.has(to)) {
                    network.edges.set(to, new Set<Milepost>());
                }
                network.edges.get(from)!.add(to);
                network.edges.get(to)!.add(from);
            }
        }

        return network;
    }

    /**
     * Helper: Estimates distance between two mileposts
     * Used for A* pathfinding
     */
    private estimateDistance(from: Milepost, to: Milepost): number {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        return Math.sqrt(dx * dx + dy * dy);
    }
}

/**
 * Build a string-keyed TrackNetwork adjacency list from TrackSegment[].
 * Node keys use the `row,col` format consistent with the rest of the codebase.
 */
export function buildTrackNetwork(segments: TrackSegment[]): StringTrackNetwork {
    const nodes = new Set<string>();
    const edges = new Map<string, Set<string>>();

    for (const seg of segments) {
        const fromKey = `${seg.from.row},${seg.from.col}`;
        const toKey = `${seg.to.row},${seg.to.col}`;

        nodes.add(fromKey);
        nodes.add(toKey);

        if (!edges.has(fromKey)) {
            edges.set(fromKey, new Set<string>());
        }
        if (!edges.has(toKey)) {
            edges.set(toKey, new Set<string>());
        }
        edges.get(fromKey)!.add(toKey);
        edges.get(toKey)!.add(fromKey);
    }

    return { nodes, edges };
}