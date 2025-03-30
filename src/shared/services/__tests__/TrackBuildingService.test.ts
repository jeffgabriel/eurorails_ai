import { TrackBuildingService } from '../TrackBuildingService';
import { TrackNetworkService } from '../TrackNetworkService';
import { Milepost, TerrainType } from '../../types/GameTypes';
import { TrackNetwork, TrackBuildOptions } from '../../types/PlayerTypes';
import { Result } from 'neverthrow';

describe('TrackBuildingService', () => {
    let buildingService: TrackBuildingService;
    let networkService: TrackNetworkService;
    let mileposts: Map<string, Milepost>;
    let city1: Milepost;
    let city2: Milepost;
    let clear1: Milepost;
    let clear2: Milepost;
    let mountain1: Milepost;
    let alpine1: Milepost;
    let mediumCity1: Milepost;
    let smallCity1: Milepost;

    beforeEach(() => {
        networkService = new TrackNetworkService();
        
        // Create test mileposts with more terrain types
        city1 = {
            id: 'city1',
            x: 0,
            y: 0,
            type: TerrainType.MajorCity
        };
        city2 = {
            id: 'city2',
            x: 10,
            y: 0,
            type: TerrainType.MajorCity
        };
        clear1 = {
            id: 'clear1',
            x: 5,
            y: 0,
            type: TerrainType.Clear
        };
        clear2 = {
            id: 'clear2',
            x: 7,
            y: 0,
            type: TerrainType.Clear
        };
        mountain1 = {
            id: 'mountain1',
            x: 5,
            y: 5,
            type: TerrainType.Mountain
        };
        alpine1 = {
            id: 'alpine1',
            x: 7,
            y: 5,
            type: TerrainType.Alpine
        };
        mediumCity1 = {
            id: 'mediumCity1',
            x: 3,
            y: 3,
            type: TerrainType.MediumCity
        };
        smallCity1 = {
            id: 'smallCity1',
            x: 8,
            y: 3,
            type: TerrainType.SmallCity
        };

        mileposts = new Map();
        mileposts.set('city1', city1);
        mileposts.set('city2', city2);
        mileposts.set('clear1', clear1);
        mileposts.set('clear2', clear2);
        mileposts.set('mountain1', mountain1);
        mileposts.set('alpine1', alpine1);
        mileposts.set('mediumCity1', mediumCity1);
        mileposts.set('smallCity1', smallCity1);

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

        it('should allow building from existing network', async () => {
            // First build from major city
            const result1 = await buildingService.addPlayerTrack(
                'player1',
                'game1',
                city1,
                clear1
            );
            expect(result1.isOk()).toBe(true);

            // Then build from the clear terrain point
            const result2 = await buildingService.addPlayerTrack(
                'player1',
                'game1',
                clear1,
                mountain1
            );
            expect(result2.isOk()).toBe(true);
        });

        it('should calculate correct costs for different terrain types', async () => {
            const options: TrackBuildOptions = { turnBudget: 20 };
            
            // Build through different terrain types
            const result = await buildingService.addPlayerTrack(
                'player1',
                'game1',
                city1,
                clear1,
                options
            );

            expect(result.isOk()).toBe(true);
            if (result.isOk()) {
                expect(result.value.buildCost).toBe(1); // Clear terrain costs 1M
            }

            // Test mountain terrain
            const mountainResult = await buildingService.addPlayerTrack(
                'player1',
                'game1',
                clear1,
                mountain1,
                options
            );

            expect(mountainResult.isOk()).toBe(true);
            if (mountainResult.isOk()) {
                expect(mountainResult.value.buildCost).toBe(2); // Mountain terrain costs 2M
            }
        });

        it('should enforce turn budget limit', async () => {
            // Try to build expensive track exceeding 20M limit
            const result = await buildingService.addPlayerTrack(
                'player1',
                'game1',
                city1,
                alpine1,
                { turnBudget: 2 } // Only 2M left in budget
            );

            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
                expect(result.error).toBe('EXCEEDS_TURN_BUDGET');
            }
        });

        it('should validate city connection limits', async () => {
            // Try to connect more than allowed players to a medium city
            const player1Result = await buildingService.addPlayerTrack('player1', 'game1', city1, mediumCity1);
            const player2Result = await buildingService.addPlayerTrack('player2', 'game1', city2, mediumCity1);
            const player3Result = await buildingService.addPlayerTrack('player3', 'game1', clear1, mediumCity1);
            const player4Result = await buildingService.addPlayerTrack('player4', 'game1', clear2, mediumCity1);

            expect(player1Result.isOk()).toBe(true);
            expect(player2Result.isOk()).toBe(true);
            expect(player3Result.isOk()).toBe(true);
            expect(player4Result.isErr()).toBe(true); // Should fail as medium cities allow max 3 connections
        });

        it('should handle ferry connections correctly', async () => {
            const ferryPort1: Milepost = {
                id: 'ferry1',
                x: 0,
                y: 10,
                type: TerrainType.FerryPort
            };
            const ferryPort2: Milepost = {
                id: 'ferry2',
                x: 10,
                y: 10,
                type: TerrainType.FerryPort
            };
            mileposts.set('ferry1', ferryPort1);
            mileposts.set('ferry2', ferryPort2);

            // Build to ferry port
            const result = await buildingService.addPlayerTrack(
                'player1',
                'game1',
                city1,
                ferryPort1
            );

            expect(result.isOk()).toBe(true);
            if (result.isOk()) {
                // Should automatically connect both ferry ports
                expect(result.value.nodes.has(ferryPort1)).toBe(true);
                expect(result.value.nodes.has(ferryPort2)).toBe(true);
                expect(result.value.edges.get(ferryPort1)?.has(ferryPort2)).toBe(true);
            }
        });
    });

    describe('isValidConnection', () => {
        it('should validate adjacent points', () => {
            const farPoint: Milepost = {
                id: 'far',
                x: 100,
                y: 100,
                type: TerrainType.Clear
            };
            const result = buildingService.isValidConnection(city1, farPoint);
            expect(result).toBe(false);
        });

        it('should prevent building on water', () => {
            const waterPoint: Milepost = {
                id: 'water1',
                x: 1,
                y: 1,
                type: TerrainType.Water
            };
            const result = buildingService.isValidConnection(city1, waterPoint);
            expect(result).toBe(false);
        });

        it('should validate track crossing costs', () => {
            // Test adjacent points that would have a river crossing
            const result = buildingService.isValidConnection(clear1, clear2);
            expect(result).toBe(true);
        });
    });
}); 