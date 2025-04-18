import { LoadState, LoadType } from '../../shared/types/LoadTypes';

export class LoadService {
  private static instance: LoadService;
  private loadStates: Map<string, LoadState> = new Map();
  private isLoaded: boolean = false;

  private constructor() {}

  public static getInstance(): LoadService {
    if (!LoadService.instance) {
      LoadService.instance = new LoadService();
    }
    return LoadService.instance;
  }

  public async loadInitialState(): Promise<void> {
    if (this.isLoaded) return;

    try {
      const response = await fetch('/api/loads/state');
      if (!response.ok) {
        throw new Error('Failed to load initial load state');
      }
      const states: LoadState[] = await response.json();
      
      // Initialize the load states map
      states.forEach(state => {
        this.loadStates.set(state.loadType, state);
      });
      
      this.isLoaded = true;
    } catch (error) {
      console.error('Failed to load initial load state:', error);
      throw error;
    }
  }

  public getCityLoadDetails(city: string): Array<{ loadType: LoadType; count: number }> {
    const loadDetails: Array<{ loadType: LoadType; count: number }> = [];
    
    this.loadStates.forEach(state => {
      if (state.cities.includes(city)) {
        loadDetails.push({
          loadType: state.loadType as LoadType,
          count: state.availableCount
        });
      }
    });

    return loadDetails;
  }

  public getAllLoadStates(): LoadState[] {
    return Array.from(this.loadStates.values());
  }
} 