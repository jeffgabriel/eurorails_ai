import { TrackNetworkService } from '../TrackNetworkService';
import { Milepost, TerrainType } from '../../types/GameTypes';
import { TrackNetwork } from '../../types/PlayerTypes';

describe('TrackNetworkService', () => {
    let service: TrackNetworkService;
    let network: TrackNetwork;
    let mileposts: Map<string, Milepost>;

    beforeEach(() => {
        service = new TrackNetworkService();
        network = service.createEmptyNetwork();
        
        // Create test mileposts
        mileposts = new Map();
        mileposts.set('city1', {
            id: 'city1',
            x: 0,
            y: 0,
            type: 5  // TerrainType.MajorCity
        });
        mileposts.set('city2', {
            id: 'city2',
            x: 10,
            y: 0,
            type: 5  // TerrainType.MajorCity
        });
        mileposts.set('clear1', {
            id: 'clear1',
            x: 5,
            y: 0,
            type: 1  // TerrainType.Clear
        });
        mileposts.set('mountain1', {
            id: 'mountain1',
            x: 5,
            y: 5,
            type: 2  // TerrainType.Mountain
        });
    });

    describe('createEmptyNetwork', () => {
        it('should create an empty network', () => {
            const network = service.createEmptyNetwork();
            expect(network.nodes.size).toBe(0);
            expect(network.edges.size).toBe(0);
        });
    });

    describe('addTrackSegment', () => {
        it('should add a track segment between two points', () => {
            const updated = service.addTrackSegment(network, 'city1', 'clear1');
            expect(updated.nodes.has('city1')).toBe(true);
            expect(updated.nodes.has('clear1')).toBe(true);
            expect(updated.edges.get('city1')?.has('clear1')).toBe(true);
            expect(updated.edges.get('clear1')?.has('city1')).toBe(true);
        });

        it('should maintain existing connections when adding new segments', () => {
            let updated = service.addTrackSegment(network, 'city1', 'clear1');
            updated = service.addTrackSegment(updated, 'clear1', 'city2');
            
            expect(updated.edges.get('city1')?.has('clear1')).toBe(true);
            expect(updated.edges.get('clear1')?.has('city2')).toBe(true);
        });
    });

    describe('isConnected', () => {
        it('should return true for directly connected points', () => {
            const updated = service.addTrackSegment(network, 'city1', 'clear1');
            expect(service.isConnected(updated, 'city1', 'clear1')).toBe(true);
        });

        it('should return true for indirectly connected points', () => {
            let updated = service.addTrackSegment(network, 'city1', 'clear1');
            updated = service.addTrackSegment(updated, 'clear1', 'city2');
            expect(service.isConnected(updated, 'city1', 'city2')).toBe(true);
        });

        it('should return false for unconnected points', () => {
            const updated = service.addTrackSegment(network, 'city1', 'clear1');
            expect(service.isConnected(updated, 'city1', 'city2')).toBe(false);
        });
    });

    describe('findPath', () => {
        it('should find direct path between connected points', () => {
            const updated = service.addTrackSegment(network, 'city1', 'clear1');
            const path = service.findPath(updated, 'city1', 'clear1', mileposts);
            expect(path).toEqual(['city1', 'clear1']);
        });

        it('should find indirect path through multiple segments', () => {
            let updated = service.addTrackSegment(network, 'city1', 'clear1');
            updated = service.addTrackSegment(updated, 'clear1', 'city2');
            const path = service.findPath(updated, 'city1', 'city2', mileposts);
            expect(path).toEqual(['city1', 'clear1', 'city2']);
        });

        it('should return null for unconnected points', () => {
            const updated = service.addTrackSegment(network, 'city1', 'clear1');
            const path = service.findPath(updated, 'city1', 'city2', mileposts);
            expect(path).toBeNull();
        });
    });

    describe('canAddSegment', () => {
        it('should allow starting from a major city in empty network', () => {
            expect(service.canAddSegment(network, 'city1', 'clear1', mileposts)).toBe(true);
        });

        it('should not allow starting between non-city points in empty network', () => {
            expect(service.canAddSegment(network, 'clear1', 'mountain1', mileposts)).toBe(false);
        });

        it('should allow adding to existing network', () => {
            const updated = service.addTrackSegment(network, 'city1', 'clear1');
            expect(service.canAddSegment(updated, 'clear1', 'mountain1', mileposts)).toBe(true);
        });
    });

    describe('serializeNetwork and deserializeNetwork', () => {
        it('should correctly serialize and deserialize a network', () => {
            let original = service.addTrackSegment(network, 'city1', 'clear1');
            original = service.addTrackSegment(original, 'clear1', 'city2');
            
            const serialized = service.serializeNetwork(original);
            const deserialized = service.deserializeNetwork(serialized);
            
            // Check nodes
            expect(deserialized.nodes.size).toBe(original.nodes.size);
            for (const node of original.nodes) {
                expect(deserialized.nodes.has(node)).toBe(true);
            }
            
            // Check edges
            expect(deserialized.edges.size).toBe(original.edges.size);
            for (const [from, toSet] of original.edges) {
                const deserializedToSet = deserialized.edges.get(from);
                expect(deserializedToSet).toBeDefined();
                for (const to of toSet) {
                    expect(deserializedToSet?.has(to)).toBe(true);
                }
            }
        });
    });
}); 