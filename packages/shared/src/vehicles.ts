/**
 * Handling specs for every vehicle model. The game server runs these; the client uses them only to
 * predict its own car. Model ids must match public.vehicle_models in the database (tested).
 */
export interface VehicleSpec {
  id: string;
  name: string;
  /** Top forward speed on road, m/s. */
  maxSpeed: number;
  /** Engine acceleration at standstill, m/s^2 (tapers to zero at maxSpeed). */
  accel: number;
  /** Braking deceleration, m/s^2. */
  brake: number;
  reverseAccel: number;
  maxReverse: number;
  /** Constant rolling resistance, m/s^2, and quadratic drag coefficient, 1/m. */
  rolling: number;
  drag: number;
  /** Max front-wheel angle at standstill (rad) and the speed scale over which it shrinks. */
  maxSteer: number;
  steerFalloff: number;
  wheelbase: number;
  /** How quickly sideways slip is removed, 1/s. Higher = grippier. */
  grip: number;
  offroadSpeedFactor: number;
  offroadRolling: number;
  /** Visual size (meters); collisions use two circles along the body. */
  length: number;
  width: number;
  height: number;
}

export const VEHICLE_SPECS: Readonly<Record<string, VehicleSpec>> = {
  sprout_hatch: {
    id: 'sprout_hatch',
    name: 'Sprout Hatch',
    maxSpeed: 24,
    accel: 10,
    brake: 20,
    reverseAccel: 6,
    maxReverse: 8,
    rolling: 0.9,
    drag: 0.0015,
    maxSteer: 0.62,
    steerFalloff: 14,
    wheelbase: 2.4,
    grip: 7,
    offroadSpeedFactor: 0.55,
    offroadRolling: 4,
    length: 3.8,
    width: 1.8,
    height: 1.5,
  },
};

export function vehicleSpec(modelId: string): VehicleSpec | undefined {
  return VEHICLE_SPECS[modelId];
}

/** Paint colors players can choose (index stored as player_vehicles.color_index, 0-7). */
export const CAR_PALETTE: readonly { name: string; hex: number }[] = [
  { name: 'Copper', hex: 0xd9773a },
  { name: 'Sky', hex: 0x3f8fe0 },
  { name: 'Mint', hex: 0x3fbf8f },
  { name: 'Sunflower', hex: 0xf2c230 },
  { name: 'Plum', hex: 0x8e5bd6 },
  { name: 'Cherry', hex: 0xd94452 },
  { name: 'Chalk', hex: 0xe9e4da },
  { name: 'Slate', hex: 0x4a5563 },
];

/** Collision body: two circles along the car's length. */
export const BODY_CIRCLE_OFFSET = 0.95;
export const BODY_CIRCLE_RADIUS = 0.95;
