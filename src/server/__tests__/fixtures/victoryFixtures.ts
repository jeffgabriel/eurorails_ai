import { getMajorCityGroups } from '../../../shared/services/majorCityGroups';
import { TerrainType } from '../../../shared/types/GameTypes';
import type { TrackSegment } from '../../../shared/types/TrackTypes';
import type { MajorCityCoordinate } from '../../services/winConditionsService';

/** Actual map geometry; these edges test connectivity, not construction legality. */
export const victoryCities: MajorCityCoordinate[] = [
  'Berlin', 'Holland', 'London', 'Milano', 'Paris', 'Ruhr', 'Wien',
].map((name) => {
  const group = getMajorCityGroups().find(city => city.cityName === name);
  if (!group) throw new Error(`Missing major city fixture: ${name}`);
  return { name, ...group.center };
});

export function victorySegment(
  from: { row: number; col: number },
  to: { row: number; col: number },
): TrackSegment {
  return {
    from: { ...from, x: 0, y: 0, terrain: TerrainType.Clear },
    to: { ...to, x: 0, y: 0, terrain: TerrainType.Clear },
    cost: 1,
  };
}

export function victoryTrack(cities: MajorCityCoordinate[] = victoryCities): TrackSegment[] {
  return cities.slice(1).map((city, index) => victorySegment(cities[index], city));
}
