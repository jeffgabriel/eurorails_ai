/**
 * Mock for LoadService.
 * Provides configurable load availability per city.
 */

const cityLoads = new Map<string, string[]>();
const sourceCitiesMap = new Map<string, string[]>();

const mockInstance = {
  getAvailableLoadsForCity: jest.fn((city: string) => cityLoads.get(city) ?? []),
  getSourceCitiesForLoad: jest.fn((loadType: string) => sourceCitiesMap.get(loadType) ?? []),
  isLoadAvailableAtCity: jest.fn((loadType: string, city: string) => {
    const loads = cityLoads.get(city) ?? [];
    return loads.includes(loadType);
  }),
  pickupDroppedLoad: jest.fn().mockResolvedValue(undefined),
  returnLoad: jest.fn().mockResolvedValue(undefined),
  setLoadInCity: jest.fn().mockResolvedValue(undefined),
};

export const mockLoadService = {
  getInstance: jest.fn(() => mockInstance),
};

export const mockLoadServiceInstance = mockInstance;

/**
 * Set available loads for a city.
 */
export function setMockCityLoads(city: string, loads: string[]): void {
  cityLoads.set(city, loads);
}

/**
 * Set source cities for a load type (where a load can be picked up).
 */
export function setMockSourceCities(loadType: string, cities: string[]): void {
  sourceCitiesMap.set(loadType, cities);
}

export function resetLoadServiceMock(): void {
  cityLoads.clear();
  sourceCitiesMap.clear();
  mockInstance.getAvailableLoadsForCity.mockReset().mockImplementation((city: string) => cityLoads.get(city) ?? []);
  mockInstance.getSourceCitiesForLoad.mockReset().mockImplementation((loadType: string) => sourceCitiesMap.get(loadType) ?? []);
  mockInstance.isLoadAvailableAtCity.mockReset().mockImplementation((loadType: string, city: string) => {
    const loads = cityLoads.get(city) ?? [];
    return loads.includes(loadType);
  });
  mockInstance.pickupDroppedLoad.mockReset().mockResolvedValue(undefined);
  mockInstance.returnLoad.mockReset().mockResolvedValue(undefined);
  mockInstance.setLoadInCity.mockReset().mockResolvedValue(undefined);
  mockLoadService.getInstance.mockReset().mockReturnValue(mockInstance);
}
