import { clamp, quantize, wrapAngle } from './math.ts';
import { BODY_CIRCLE_OFFSET, BODY_CIRCLE_RADIUS, type VehicleSpec } from './vehicles.ts';
import { isOnRoad, type WorldMap } from './world.ts';

/** Full simulation state of one car. Everything needed to resume simulation exactly. */
export interface CarState {
  x: number;
  z: number;
  /** Radians; 0 faces +z, positive turns toward +x. */
  heading: number;
  vx: number;
  vz: number;
}

/** One tick of player intent. The only thing a client is allowed to send for driving. */
export interface DriveInput {
  /** -1 (full left) .. 1 (full right). */
  steer: number;
  /** 0..1 */
  throttle: number;
  /** 0..1 (brakes, then reverses when stopped). */
  brake: number;
}

export const NEUTRAL_INPUT: Readonly<DriveInput> = { steer: 0, throttle: 0, brake: 0 };

const POS_DECIMALS = 3;
const VEL_DECIMALS = 3;
const HEADING_DECIMALS = 5;
const RESTITUTION = 0.25;

/** Clamps untrusted input into valid ranges (non-finite values become neutral). */
export function sanitizeInput(i: DriveInput): DriveInput {
  const f = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? clamp(v, lo, hi) : 0);
  return { steer: f(i.steer, -1, 1), throttle: f(i.throttle, 0, 1), brake: f(i.brake, 0, 1) };
}

export function quantizeCar(s: CarState): CarState {
  return {
    x: quantize(s.x, POS_DECIMALS),
    z: quantize(s.z, POS_DECIMALS),
    heading: quantize(wrapAngle(s.heading), HEADING_DECIMALS),
    vx: quantize(s.vx, VEL_DECIMALS),
    vz: quantize(s.vz, VEL_DECIMALS),
  };
}

export function forwardSpeed(s: CarState): number {
  return s.vx * Math.sin(s.heading) + s.vz * Math.cos(s.heading);
}

/**
 * Advances one car by one fixed tick against the static world. Pure and deterministic for a given
 * JavaScript engine; the result is quantized so server state and snapshots are identical.
 */
export function stepCar(s: CarState, rawInput: DriveInput, spec: VehicleSpec, world: WorldMap, dt: number): CarState {
  const input = sanitizeInput(rawInput);
  const sinH = Math.sin(s.heading);
  const cosH = Math.cos(s.heading);
  // Forward (sinH, cosH); right-hand side when facing forward with +y up is (-cosH, sinH).
  let vf = s.vx * sinH + s.vz * cosH;
  let vl = -s.vx * cosH + s.vz * sinH;

  const onRoad = isOnRoad(world, s.x, s.z);
  const topSpeed = spec.maxSpeed * (onRoad ? 1 : spec.offroadSpeedFactor);

  // Longitudinal: engine, brakes, reverse.
  let a = 0;
  if (input.throttle > 0) {
    if (vf < -0.3) a += spec.brake * input.throttle; // gas while rolling back acts as a brake
    else {
      const r = vf / topSpeed; // quadratic taper: strong mid-range pull, zero at top speed
      a += spec.accel * input.throttle * Math.max(0, 1 - r * Math.abs(r));
    }
  }
  if (input.brake > 0) {
    if (vf > 0.3) a -= spec.brake * input.brake;
    else a -= spec.reverseAccel * input.brake * Math.max(0, 1 - -vf / spec.maxReverse);
  }
  vf += a * dt;

  // Resistance always opposes motion and never reverses it.
  const resist = (spec.rolling * (onRoad ? 1 : spec.offroadRolling) + spec.drag * vf * vf) * dt;
  if (Math.abs(vf) <= resist) vf = 0;
  else vf -= Math.sign(vf) * resist;
  // Entering grass at speed: bleed down toward the off-road cap.
  if (vf > topSpeed) vf -= (vf - topSpeed) * Math.min(1, 2 * dt);

  // Lateral grip.
  vl *= Math.max(0, 1 - spec.grip * dt);

  // Steering (bicycle model). Positive steer turns right, i.e. decreases heading.
  const steerAngle = (input.steer * spec.maxSteer) / (1 + Math.abs(vf) / spec.steerFalloff);
  const yawRate = (vf / spec.wheelbase) * Math.tan(steerAngle);
  const heading = wrapAngle(s.heading - yawRate * dt);

  const sinN = Math.sin(heading);
  const cosN = Math.cos(heading);
  const next: CarState = {
    x: s.x,
    z: s.z,
    heading,
    vx: sinN * vf - cosN * vl,
    vz: cosN * vf + sinN * vl,
  };
  next.x += next.vx * dt;
  next.z += next.vz * dt;

  resolveStatic(next, world);
  return quantizeCar(next);
}

interface Contact {
  nx: number;
  nz: number;
  depth: number;
}

function circleVsBox(cx: number, cz: number, r: number, bx: number, bz: number, hw: number, hd: number): Contact | null {
  const dx = cx - bx;
  const dz = cz - bz;
  if (Math.abs(dx) > hw + r || Math.abs(dz) > hd + r) return null;
  const px = clamp(dx, -hw, hw);
  const pz = clamp(dz, -hd, hd);
  const ox = dx - px;
  const oz = dz - pz;
  const d2 = ox * ox + oz * oz;
  if (d2 > 0) {
    if (d2 >= r * r) return null;
    const d = Math.sqrt(d2);
    return { nx: ox / d, nz: oz / d, depth: r - d };
  }
  // Center inside the box: push out along the shallowest axis.
  const penX = hw - Math.abs(dx) + r;
  const penZ = hd - Math.abs(dz) + r;
  return penX < penZ ? { nx: dx >= 0 ? 1 : -1, nz: 0, depth: penX } : { nx: 0, nz: dz >= 0 ? 1 : -1, depth: penZ };
}

function circleVsCircle(ax: number, az: number, ar: number, bx: number, bz: number, br: number): Contact | null {
  const dx = ax - bx;
  const dz = az - bz;
  const rr = ar + br;
  const d2 = dx * dx + dz * dz;
  if (d2 >= rr * rr) return null;
  const d = Math.sqrt(d2);
  if (d === 0) return { nx: 1, nz: 0, depth: rr };
  return { nx: dx / d, nz: dz / d, depth: rr - d };
}

function applyContact(s: CarState, c: Contact): void {
  s.x += c.nx * c.depth;
  s.z += c.nz * c.depth;
  const vn = s.vx * c.nx + s.vz * c.nz;
  if (vn < 0) {
    s.vx -= c.nx * vn * (1 + RESTITUTION);
    s.vz -= c.nz * vn * (1 + RESTITUTION);
  }
}

export function bodyCircles(s: CarState): [number, number, number, number] {
  const fx = Math.sin(s.heading) * BODY_CIRCLE_OFFSET;
  const fz = Math.cos(s.heading) * BODY_CIRCLE_OFFSET;
  return [s.x + fx, s.z + fz, s.x - fx, s.z - fz];
}

/** Pushes a car out of buildings, trees, props, and the boundary fence. Mutates `s`. */
export function resolveStatic(s: CarState, world: WorldMap): void {
  const r = BODY_CIRCLE_RADIUS;
  for (let pass = 0; pass < 2; pass++) {
    const [ax, az, bx, bz] = bodyCircles(s);
    for (const [cx, cz] of [
      [ax, az],
      [bx, bz],
    ] as const) {
      for (const b of world.buildings) {
        const c = circleVsBox(cx, cz, r, b.x, b.z, b.w / 2, b.d / 2);
        if (c) applyContact(s, c);
      }
      for (const t of world.trees) {
        const c = circleVsCircle(cx, cz, r, t.x, t.z, t.r);
        if (c) applyContact(s, c);
      }
      for (const p of world.props) {
        const c = circleVsCircle(cx, cz, r, p.x, p.z, p.r);
        if (c) applyContact(s, c);
      }
    }
    // Fence: keep both circles inside the square.
    const lim = world.halfSize - r;
    const [fax, faz, fbx, fbz] = bodyCircles(s);
    for (const [cx, cz] of [
      [fax, faz],
      [fbx, fbz],
    ] as const) {
      if (cx > lim) applyContact(s, { nx: -1, nz: 0, depth: cx - lim });
      if (cx < -lim) applyContact(s, { nx: 1, nz: 0, depth: -lim - cx });
      if (cz > lim) applyContact(s, { nx: 0, nz: -1, depth: cz - lim });
      if (cz < -lim) applyContact(s, { nx: 0, nz: 1, depth: -lim - cz });
    }
  }
}

/**
 * Separates two cars that overlap and exchanges momentum along the contact normal (equal mass).
 * Server-only: client prediction does not simulate other cars; corrections arrive in snapshots.
 * Returns true if they were touching.
 */
export function resolveCarPair(a: CarState, b: CarState): boolean {
  const r = BODY_CIRCLE_RADIUS;
  const ca = bodyCircles(a);
  const cb = bodyCircles(b);
  let touched = false;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const c = circleVsCircle(ca[i * 2]!, ca[i * 2 + 1]!, r, cb[j * 2]!, cb[j * 2 + 1]!, r);
      if (!c) continue;
      touched = true;
      const half = c.depth / 2;
      a.x += c.nx * half;
      a.z += c.nz * half;
      b.x -= c.nx * half;
      b.z -= c.nz * half;
      // Relative velocity along the normal (a relative to b).
      const rel = (a.vx - b.vx) * c.nx + (a.vz - b.vz) * c.nz;
      if (rel < 0) {
        const impulse = (-(1 + RESTITUTION) * rel) / 2;
        a.vx += c.nx * impulse;
        a.vz += c.nz * impulse;
        b.vx -= c.nx * impulse;
        b.vz -= c.nz * impulse;
      }
    }
  }
  return touched;
}

/** Index of a spawn point not within `clearance` meters of any occupied position (or the least crowded). */
export function chooseSpawn(world: WorldMap, occupied: { x: number; z: number }[], clearance = 8, offset = 0): number {
  let best = 0;
  let bestDist = -1;
  const count = world.spawns.length;
  for (let k = 0; k < count; k++) {
    const i = (k + offset) % count;
    const sp = world.spawns[i]!;
    let nearest = Infinity;
    for (const o of occupied) nearest = Math.min(nearest, Math.hypot(o.x - sp.x, o.z - sp.z));
    if (nearest >= clearance) return i;
    if (nearest > bestDist) {
      bestDist = nearest;
      best = i;
    }
  }
  return best;
}

export function spawnState(world: WorldMap, index: number): CarState {
  const sp = world.spawns[index % world.spawns.length]!;
  return quantizeCar({ x: sp.x, z: sp.z, heading: sp.heading, vx: 0, vz: 0 });
}
