import { LoadType } from "./LoadTypes";

// Interface for a single demand on a card
export interface Demand {
  city: string;
  resource: LoadType;
  payment: number;
}

export interface DemandCard {
  id: number;  // Unique identifier for the card
  demands: Demand[];  // Array of demands (typically 3)
}

// Raw interface matching the JSON structure
export interface RawDemandCard {
  id: number;
  demands: {
    resource: LoadType;
    city: string;
    payment: number;
  }[];
} 