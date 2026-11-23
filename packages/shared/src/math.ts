export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  const TWO_PI = Math.PI * 2;
  let r = a % TWO_PI;
  if (r <= -Math.PI) r += TWO_PI;
  else if (r > Math.PI) r -= TWO_PI;
  return r;
}

/** Interpolates angles along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return wrapAngle(a + wrapAngle(b - a) * t);
}

/** Rounds to a fixed number of decimals so server state and snapshots are bit-identical. */
export function quantize(v: number, decimals: number): number {
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r; // normalize -0
}
