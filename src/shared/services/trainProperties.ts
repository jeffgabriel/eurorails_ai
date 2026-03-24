import { TrainType, TRAIN_PROPERTIES } from '../types/GameTypes';

/**
 * Returns the maximum mileposts per turn for the given train type.
 * Falls back to 9 (Freight speed) if the train type is unknown.
 */
export function getTrainSpeed(trainType: TrainType): number {
  return TRAIN_PROPERTIES[trainType]?.speed ?? 9;
}

/**
 * Returns the maximum load capacity for the given train type.
 * Falls back to 2 (Freight capacity) if the train type is unknown.
 */
export function getTrainCapacity(trainType: TrainType): number {
  return TRAIN_PROPERTIES[trainType]?.capacity ?? 2;
}
