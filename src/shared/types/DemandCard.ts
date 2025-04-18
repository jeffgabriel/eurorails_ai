import { LoadType } from "./LoadTypes";

export interface DemandCard {
  id: number;  // Unique identifier for the card
  destinationCity: string;
  resource: LoadType;
  payment: number;  // Store as number for easier calculations
}

// Raw interface matching the JSON structure
export interface RawDemandCard {
  DestinationCity: string;
  Resource: LoadType;
  Payment: string;  // Comes as string in JSON
} 