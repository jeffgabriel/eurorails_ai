import { LoadState, LoadType } from '../../shared/types/LoadTypes';

export class LoadService {
  private static instance: LoadService;
  private loadStates: Map<string, LoadState> = new Map();
  private isLoaded: boolean = false;
  private droppedLoads: Map<string, LoadType[]> = new Map(); // city name -> array of load types

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

      // Initialize dropped loads map - group by city
      droppedLoads.forEach(drop => {
        const cityLoads = this.droppedLoads.get(drop.city_name) || [];
        cityLoads.push(drop.type);
        this.droppedLoads.set(drop.city_name, cityLoads);
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
    
    const loadDetails = new Map<LoadType, { loadType: LoadType; count: number }>();
    
    // First check configured loads (static city configuration)
    this.loadStates.forEach(state => {
      if (state && state.cities && state.cities.includes(city)) {
        console.log(`Found configured load ${state.loadType} in ${city} with ${state.availableCount} available`);
        if (state.availableCount > 0) {
          loadDetails.set(state.loadType as LoadType, {
            loadType: state.loadType as LoadType,
            count: state.availableCount
          });
        }
      }
    });

    // Then check dropped loads in this city
    const droppedLoadsInCity = this.droppedLoads.get(city) || [];
    if (droppedLoadsInCity.length > 0) {
      // Count occurrences of each load type
      const dropCounts = new Map<LoadType, number>();
      droppedLoadsInCity.forEach(loadType => {
        const currentCount = dropCounts.get(loadType) || 0;
        dropCounts.set(loadType, currentCount + 1);
      });

      // Add dropped loads to the result
      dropCounts.forEach((count, loadType) => {
        const existing = loadDetails.get(loadType);
        if (existing) {
          // If this load type is also configured for this city, add to available count
          existing.count += count;
        } else {
          // If this is just a dropped load, add it as new
          loadDetails.set(loadType, {
            loadType,
            count
          });
        }
      });
    }

    const result = Array.from(loadDetails.values());
    console.log(`Final load details for ${city}:`, result);
    return result;
  }

  public getAllLoadStates(): LoadState[] {
    return Array.from(this.loadStates.values());
  }

  public async pickupLoad(loadType: LoadType, city: string): Promise<boolean> {
    try {
      // First check if this is a dropped load
      const droppedLoadsInCity = this.droppedLoads.get(city) || [];
      const isDroppedLoad = droppedLoadsInCity.includes(loadType);

      if (isDroppedLoad) {
        // Handle picking up a dropped load
        const response = await fetch('/api/loads/pickup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ loadType, city, isDropped: true }),
        });

        if (!response.ok) return false;

        // Update local state for dropped loads
        const updatedDrops = droppedLoadsInCity.filter((type, index) => 
          index !== droppedLoadsInCity.indexOf(loadType));
        if (updatedDrops.length === 0) {
          this.droppedLoads.delete(city);
        } else {
          this.droppedLoads.set(city, updatedDrops);
        }
      } else {
        // Handle picking up a configured load
        const response = await fetch('/api/loads/pickup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ loadType, city, isDropped: false }),
        });

        if (!response.ok) return false;

        // Update the available count in load states
        const state = this.loadStates.get(loadType);
        if (state) {
          state.availableCount--;
          this.loadStates.set(loadType, state);
        }
      }

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loadType }),
      });

      if (!response.ok) return false;

      // Update the available count in load states
      const state = this.loadStates.get(loadType);
      if (state) {
        state.availableCount++;
        this.loadStates.set(loadType, state);
      }

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city, loadType }),
      });

      if (!response.ok) return false;

      // Update local state for dropped loads
      const cityLoads = this.droppedLoads.get(city) || [];
      cityLoads.push(loadType);
      this.droppedLoads.set(city, cityLoads);

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