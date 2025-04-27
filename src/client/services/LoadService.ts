import { LoadState, LoadType } from '../../shared/types/LoadTypes';

export class LoadService {
  private static instance: LoadService;
  private loadStates: Map<string, LoadState> = new Map();
  private isLoaded: boolean = false;
  private droppedLoads: Map<string, LoadType> = new Map(); // city name -> load type

  private constructor() {}

  public static getInstance(): LoadService {
    if (!LoadService.instance) {
      LoadService.instance = new LoadService();
    }
    return LoadService.instance;
  }

  public async loadInitialState(): Promise<void> {
    if (this.isLoaded) {
      console.log('LoadService already initialized');
      return;
    }

    try {
      console.log('Fetching initial load state...');
      // Load both initial load state and dropped loads
      const [loadStateResponse, droppedLoadsResponse] = await Promise.all([
        fetch('/api/loads/state'),
        fetch('/api/loads/dropped')
      ]);

      if (!loadStateResponse.ok || !droppedLoadsResponse.ok) {
        throw new Error('Failed to load initial state');
      }

      const states: LoadState[] = await loadStateResponse.json();
      const droppedLoads: Array<{city_name: string, type: LoadType}> = await droppedLoadsResponse.json();
      
      console.log('Received load states:', states);
      console.log('Received dropped loads:', droppedLoads);
      
      // Initialize the load states map
      states.forEach(state => {
        this.loadStates.set(state.loadType, state);
      });

      // Initialize dropped loads map
      droppedLoads.forEach(drop => {
        this.droppedLoads.set(drop.city_name, drop.type as LoadType);
      });
      
      console.log('Initialized load states:', this.loadStates);
      console.log('Initialized dropped loads:', this.droppedLoads);
      
      this.isLoaded = true;
    } catch (error) {
      console.error('Failed to load initial load state:', error);
      throw error;
    }
  }

  public getCityLoadDetails(city: string): Array<{ loadType: LoadType; count: number }> {
    console.log(`Getting load details for city: ${city}`);
    
    if (!this.isLoaded) {
      console.error('LoadService not initialized. Call loadInitialState() first.');
      return [];
    }
    
    console.log('Current load states:', this.loadStates);
    const loadDetails: Array<{ loadType: LoadType; count: number }> = [];
    
    // First check natural city loads
    this.loadStates.forEach(state => {
      console.log(`Checking state for ${state.loadType}:`, state);
      if (state && state.cities && state.cities.includes(city)) {
        console.log(`Found load ${state.loadType} available in ${city}`);
        loadDetails.push({
          loadType: state.loadType as LoadType,
          count: state.availableCount
        });
      }
    });

    // Then check if there's a dropped load in this city
    const droppedLoad = this.droppedLoads.get(city);
    if (droppedLoad) {
      console.log(`Found dropped load in ${city}:`, droppedLoad);
      loadDetails.push({
        loadType: droppedLoad,
        count: 1
      });
    }

    console.log(`Load details for ${city}:`, loadDetails);
    return loadDetails;
  }

  public getAllLoadStates(): LoadState[] {
    return Array.from(this.loadStates.values());
  }

  public async pickupLoad(loadType: LoadType, city: string): Promise<boolean> {
    try {
      const response = await fetch('/api/loads/pickup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ loadType, city }),
      });

      if (!response.ok) {
        return false;
      }

      const updatedState: LoadState = await response.json();
      this.loadStates.set(loadType, updatedState);
      return true;
    } catch (error) {
      console.error('Failed to pick up load:', error);
      return false;
    }
  }

  public async returnLoad(loadType: LoadType): Promise<boolean> {
    try {
      const response = await fetch('/api/loads/return', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ loadType }),
      });

      if (!response.ok) {
        return false;
      }

      const updatedState: LoadState = await response.json();
      this.loadStates.set(loadType, updatedState);
      return true;
    } catch (error) {
      console.error('Failed to return load:', error);
      return false;
    }
  }

  public async setLoadInCity(city: string, loadType: LoadType): Promise<boolean> {
    try {
      const response = await fetch('/api/loads/setInCity', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ city, loadType }),
      });

      if (!response.ok) {
        return false;
      }

      // Update both the load state and dropped loads map
      const { loadState, droppedLoads } = await response.json();
      this.loadStates.set(loadType, loadState);
      
      // Update dropped loads map
      this.droppedLoads.clear();
      droppedLoads.forEach((drop: {city_name: string, type: LoadType}) => {
        this.droppedLoads.set(drop.city_name, drop.type);
      });

      return true;
    } catch (error) {
      console.error('Failed to set load in city:', error);
      return false;
    }
  }

  // Helper method to check if a city naturally produces a load type
  private cityProducesLoad(city: string, loadType: LoadType): boolean {
    const state = this.loadStates.get(loadType);
    return state ? state.cities.includes(city) : false;
  }
} 