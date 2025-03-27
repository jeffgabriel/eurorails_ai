import { Milepost, TerrainType } from '../types/GameTypes';
import { TrackNetwork } from '../types/PlayerTypes';

export interface SerializedNetwork {
    nodes: string[];
    edges: [string, string][];
}

export class TrackNetworkService {
    /**
     * Creates a new empty track network
     */
    createEmptyNetwork(): TrackNetwork {
        return {
            nodes: new Set<string>(),
            edges: new Map<string, Set<string>>()
        };
    }

    /**
     * Adds a track segment to the network
     * Returns a new network with the added segment
     */
    addTrackSegment(network: TrackNetwork, from: string, to: string): TrackNetwork {
        // Create new network objects to maintain immutability
        const newNodes = new Set(network.nodes);
        const newEdges = new Map(network.edges);

        // Add nodes
        newNodes.add(from);
        newNodes.add(to);

        // Add edges (undirected graph, so add both directions)
        if (!newEdges.has(from)) {
            newEdges.set(from, new Set<string>());
        }
        if (!newEdges.has(to)) {
            newEdges.set(to, new Set<string>());
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
     */
    isConnected(network: TrackNetwork, from: string, to: string): boolean {
        if (!network.nodes.has(from) || !network.nodes.has(to)) {
            return false;
        }

        const visited = new Set<string>();
        const queue: string[] = [from];
        visited.add(from);

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (current === to) {
                return true;
            }

            const neighbors = network.edges.get(current) || new Set<string>();
            for (const neighbor of neighbors) {
                if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    queue.push(neighbor);
                }
            }
        }

        return false;
    }

    /**
     * Finds a path between two points in the network
     * Returns array of milepost IDs or null if no path exists
     * Uses A* search algorithm for optimal path finding
     */
    findPath(network: TrackNetwork, from: string, to: string, mileposts: Map<string, Milepost>): string[] | null {
        if (!network.nodes.has(from) || !network.nodes.has(to)) {
            return null;
        }

        // Priority queue for A* search
        const frontier: Array<[string, number]> = [[from, 0]];
        const cameFrom = new Map<string, string>();
        const costSoFar = new Map<string, number>();
        costSoFar.set(from, 0);

        while (frontier.length > 0) {
            frontier.sort((a, b) => a[1] - b[1]);
            const [current] = frontier.shift()!;

            if (current === to) {
                // Reconstruct path
                const path: string[] = [current];
                let step = current;
                while (cameFrom.has(step)) {
                    step = cameFrom.get(step)!;
                    path.unshift(step);
                }
                return path;
            }

            const neighbors = network.edges.get(current) || new Set<string>();
            for (const next of neighbors) {
                const newCost = costSoFar.get(current)! + this.estimateDistance(
                    mileposts.get(current)!,
                    mileposts.get(next)!
                );

                if (!costSoFar.has(next) || newCost < costSoFar.get(next)!) {
                    costSoFar.set(next, newCost);
                    const priority = newCost + this.estimateDistance(
                        mileposts.get(next)!,
                        mileposts.get(to)!
                    );
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
    canAddSegment(network: TrackNetwork, from: string, to: string, mileposts: Map<string, Milepost>): boolean {
        // If network is empty, must start from a major city
        if (network.nodes.size === 0) {
            return mileposts.get(from)?.type === 5 || mileposts.get(to)?.type === 5;  // 5 = TerrainType.MajorCity
        }

        // Check if either point connects to existing network
        return this.isAdjacentToNetwork(network, from) || this.isAdjacentToNetwork(network, to);
    }

    /**
     * Checks if a milepost is adjacent to the existing network
     */
    isAdjacentToNetwork(network: TrackNetwork, milepost: string): boolean {
        return network.nodes.has(milepost) || 
               Array.from(network.nodes).some(node => 
                   network.edges.get(node)?.has(milepost)
               );
    }

    /**
     * Gets all mileposts that can be reached from the current network
     */
    getReachableMileposts(network: TrackNetwork): Set<string> {
        const reachable = new Set<string>();
        
        // Add all directly connected nodes
        for (const node of network.nodes) {
            reachable.add(node);
            const neighbors = network.edges.get(node) || new Set<string>();
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
                if (from < to) {
                    edges.push([from, to]);
                }
            }
        }

        return {
            nodes: Array.from(network.nodes),
            edges: edges
        };
    }

    /**
     * Deserializes the network from storage
     */
    deserializeNetwork(serialized: SerializedNetwork): TrackNetwork {
        const network = this.createEmptyNetwork();

        // Add nodes
        for (const node of serialized.nodes) {
            network.nodes.add(node);
        }

        // Add edges
        for (const [from, to] of serialized.edges) {
            if (!network.edges.has(from)) {
                network.edges.set(from, new Set<string>());
            }
            if (!network.edges.has(to)) {
                network.edges.set(to, new Set<string>());
            }
            network.edges.get(from)!.add(to);
            network.edges.get(to)!.add(from);
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