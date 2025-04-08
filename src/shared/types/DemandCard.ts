export interface DemandCard {
  id: number;  // Unique identifier for the card
  destinationCity: string;
  resource: string;
  payment: number;  // Store as number for easier calculations
}

// Raw interface matching the JSON structure
export interface RawDemandCard {
  DestinationCity: string;
  Resource: string;
  Payment: string;  // Comes as string in JSON
} 