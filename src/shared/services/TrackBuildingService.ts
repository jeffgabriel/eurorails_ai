import { TrackNetwork } from "../types/PlayerTypes";
import { Result, Ok, Err } from "neverthrow";
import { TrackNetworkService } from "./TrackNetworkService";
import { Milepost } from "../types/GameTypes";

export enum TrackBuildError {
    INVALID_CONNECTION = 'INVALID_CONNECTION',
    EXCEEDS_TURN_BUDGET = 'EXCEEDS_TURN_BUDGET'
}

export class TrackBuildingService {
    private networkService: TrackNetworkService;
    private mileposts: Map<string, Milepost>;
    private readonly TURN_BUDGET = 20; // 20 million per turn

    constructor(networkService: TrackNetworkService, mileposts: Map<string, Milepost>) {
        this.networkService = networkService;
        this.mileposts = mileposts;
    }

    private canAddSegment(network: TrackNetwork, from: Milepost, to: Milepost): boolean {
        return this.networkService.canAddSegment(network, from, to);
    }

    private isWithinTurnBudget(cost: number): boolean {
        return cost <= this.TURN_BUDGET;
    }

    private calculateNewSegmentCost(from: Milepost, to: Milepost, network: TrackNetwork): number {
        // TODO: Implement cost calculation based on terrain and city types
        return 0; // Placeholder
    }

    private async getPlayerNetwork(playerId: string, gameId: string): Promise<TrackNetwork> {
        // TODO: Implement fetching from database
        return this.networkService.createEmptyNetwork();
    }

    private async savePlayerNetwork(playerId: string, gameId: string, network: TrackNetwork): Promise<void> {
        // TODO: Implement saving to database
    }

    // Main operation for adding track
    async addPlayerTrack(
        playerId: string, 
        gameId: string, 
        from: Milepost, 
        to: Milepost
    ): Promise<Result<TrackNetwork, TrackBuildError>> {
        // 1. Get current network state
        const currentNetwork = await this.getPlayerNetwork(playerId, gameId);
        
        // 2. Validate the new segment
        if (!this.canAddSegment(currentNetwork, from, to)) {
            return new Err(TrackBuildError.INVALID_CONNECTION);
        }
        
        // 3. Calculate cost
        const cost = this.calculateNewSegmentCost(from, to, currentNetwork);
        if (!this.isWithinTurnBudget(cost)) {
            return new Err(TrackBuildError.EXCEEDS_TURN_BUDGET);
        }
        
        // 4. Add segment to network
        const updatedNetwork = this.networkService.addTrackSegment(
            currentNetwork, 
            from, 
            to
        );
        
        // 5. Save updated state
        await this.savePlayerNetwork(playerId, gameId, updatedNetwork);
        
        return new Ok(updatedNetwork);
    }
}