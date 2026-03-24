import { TrainType } from '../../types/GameTypes';
import { getTrainSpeed, getTrainCapacity } from '../../services/trainProperties';

describe('trainProperties', () => {
  describe('getTrainSpeed', () => {
    it('returns 9 for Freight', () => {
      expect(getTrainSpeed(TrainType.Freight)).toBe(9);
    });

    it('returns 12 for FastFreight', () => {
      expect(getTrainSpeed(TrainType.FastFreight)).toBe(12);
    });

    it('returns 9 for HeavyFreight', () => {
      expect(getTrainSpeed(TrainType.HeavyFreight)).toBe(9);
    });

    it('returns 12 for Superfreight', () => {
      expect(getTrainSpeed(TrainType.Superfreight)).toBe(12);
    });

    it('falls back to 9 for unknown train type', () => {
      expect(getTrainSpeed('unknown' as TrainType)).toBe(9);
    });
  });

  describe('getTrainCapacity', () => {
    it('returns 2 for Freight', () => {
      expect(getTrainCapacity(TrainType.Freight)).toBe(2);
    });

    it('returns 2 for FastFreight', () => {
      expect(getTrainCapacity(TrainType.FastFreight)).toBe(2);
    });

    it('returns 3 for HeavyFreight', () => {
      expect(getTrainCapacity(TrainType.HeavyFreight)).toBe(3);
    });

    it('returns 3 for Superfreight', () => {
      expect(getTrainCapacity(TrainType.Superfreight)).toBe(3);
    });

    it('falls back to 2 for unknown train type', () => {
      expect(getTrainCapacity('unknown' as TrainType)).toBe(2);
    });
  });
});
