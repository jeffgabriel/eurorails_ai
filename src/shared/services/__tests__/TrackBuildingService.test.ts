import { TrackBuildingService } from '../TrackBuildingService';
import { TrackNetworkService } from '../TrackNetworkService';
import { Milepost } from '../../types/GameTypes';
import { TrackNetwork } from '../../types/PlayerTypes';
import { Result } from 'neverthrow';

describe('TrackBuildingService', () => {
    let buildingService: TrackBuildingService;
    let networkService: TrackNetworkService;
    let mileposts: Map<string, Milepost>;
    let city1: Milepost;
    let city2: Milepost;
    let clear1: Milepost;
    let clear2: Milepost;

    beforeEach(() => {
        networkService = new TrackNetworkService();
        
        // Create test mileposts
        city1 = {
            id: 'city1',
            x: 0,
            y: 0,
            type: 5  // TerrainType.MajorCity
        };
        city2 = {
            id: 'city2',
            x: 10,
            y: 0,
            type: 5  // TerrainType.MajorCity
        };
        clear1 = {
            id: 'clear1',
            x: 5,
            y: 0,
            type: 1  // TerrainType.Clear
        };
        clear2 = {
            id: 'clear2',
            x: 7,
            y: 0,
            type: 1  // TerrainType.Clear
        };

        mileposts = new Map();
        mileposts.set('city1', city1);
        mileposts.set('city2', city2);
        mileposts.set('clear1', clear1);
        mileposts.set('clear2', clear2);

        buildingService = new TrackBuildingService(networkService, mileposts);
    });

    describe('addPlayerTrack', () => {
        it('should allow building from a major city', async () => {
            const result = await buildingService.addPlayerTrack(
                'player1',
                'game1',
                city1,
                clear1
            );

            expect(result.isOk()).toBe(true);
            if (result.isOk()) {
                const network = result.value;
                expect(network.nodes.has(city1)).toBe(true);
                expect(network.nodes.has(clear1)).toBe(true);
                expect(network.edges.get(city1)?.has(clear1)).toBe(true);
            }
        });

        it('should not allow building between non-connected points', async () => {
            // First try to build between two non-major cities
            const result = await buildingService.addPlayerTrack(
                'player1',
                'game1',
                clear1,
                clear2
            );

            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                expect(result.error).toBe('INVALID_CONNECTION');
            }
        });

        // TODO: Add tests for:
        // - Building within turn budget
        // - Exceeding turn budget
        // - Building connected to existing network
        // - Database operations once implemented
    });
}); 