import { WinConditionsService } from '../winConditionsService';
import type { MajorCityCoordinate } from '../winConditionsService';
import type { TrackSegment } from '../../../shared/types/GameTypes';

/** Compatibility delegates for existing AI consumers. */
export function getConnectedMajorCityCount(segments: TrackSegment[]): number {
  return WinConditionsService.getConnectedMajorCities(segments).length;
}

export function getConnectedMajorCities(segments: TrackSegment[]): MajorCityCoordinate[] {
  return WinConditionsService.getConnectedMajorCities(segments);
}
