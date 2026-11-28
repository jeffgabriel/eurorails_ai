import { loadGridPoints, gridToPixel } from '../services/MapTopology';
import {
  resolveTrainPlacement,
  TrainPlacementError,
  TrainPlacementErrorCode,
} from '../services/trainPlacement';
import { TerrainType } from '../../shared/types/GameTypes';

type Coord = { row: number; col: number };

function firstMilepostWithTerrain(terrain: TerrainType): Coord {
  for (const point of loadGridPoints().values()) {
    if (point.terrain === terrain) return { row: point.row, col: point.col };
  }
  throw new Error(`No milepost with terrain ${terrain}`);
}

function expectRefusal(target: unknown, code: TrainPlacementErrorCode, httpStatus: number): void {
  let thrown: unknown;
  try {
    resolveTrainPlacement(target);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TrainPlacementError);
  expect((thrown as TrainPlacementError).code).toBe(code);
  expect((thrown as TrainPlacementError).httpStatus).toBe(httpStatus);
}

describe('resolveTrainPlacement', () => {
  // Berlin: center (24,52), outer milepost (24,51).
  it.each([
    ['a major city center', { row: 24, col: 52 }],
    ['a major city outer milepost', { row: 24, col: 51 }],
    ['a medium city', firstMilepostWithTerrain(TerrainType.MediumCity)],
    ['a small city', firstMilepostWithTerrain(TerrainType.SmallCity)],
  ])('accepts %s and takes the pixel position from the map', (_name: string, target: Coord) => {
    const pixel = gridToPixel(target.row, target.col);
    expect(resolveTrainPlacement({ ...target, x: -1, y: -1 })).toEqual({
      row: target.row,
      col: target.col,
      x: pixel.x,
      y: pixel.y,
    });
  });

  it.each([
    ['clear terrain', firstMilepostWithTerrain(TerrainType.Clear)],
    ['a mountain', firstMilepostWithTerrain(TerrainType.Mountain)],
    ['a ferry port', firstMilepostWithTerrain(TerrainType.FerryPort)],
    ['a milepost off the map', { row: 9999, col: 9999 }],
  ])('refuses %s as NotACity', (_name: string, target: Coord) => {
    expectRefusal(target, TrainPlacementErrorCode.NotACity, 400);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a missing col', { row: 24 }],
    ['a non-integer row', { row: 24.5, col: 52 }],
    ['strings', { row: '24', col: '52' }],
  ])('refuses %s as InvalidTarget', (_name: string, target: unknown) => {
    expectRefusal(target, TrainPlacementErrorCode.InvalidTarget, 400);
  });

  it('reports AlreadyPlaced as a conflict', () => {
    const error = new TrainPlacementError(TrainPlacementErrorCode.AlreadyPlaced, 'already');
    expect(error.httpStatus).toBe(409);
    expect(error.toResponseBody()).toEqual({ error: 'Conflict', code: 'AlreadyPlaced', details: 'already' });
  });
});
