/**
 * WheelBlocker — Static registry for UI regions that should block
 * camera zoom when the pointer is over them.
 *
 * UI panels (e.g. LoadsReferencePanel) register a bounds check,
 * and CameraController queries isWheelBlocked() before zooming.
 */

type PointerLike = { x: number; y: number };
type BoundsCheck = (pointer: PointerLike) => boolean;

const blockers = new Map<string, BoundsCheck>();

export function registerWheelBlocker(id: string, check: BoundsCheck): void {
  blockers.set(id, check);
}

export function unregisterWheelBlocker(id: string): void {
  blockers.delete(id);
}

export function isWheelBlocked(pointer: PointerLike): boolean {
  for (const check of blockers.values()) {
    if (check(pointer)) return true;
  }
  return false;
}
