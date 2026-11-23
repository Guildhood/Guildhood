import { TICK_DT, stepCar, wrapAngle, type CarState, type DriveInput, type VehicleSpec, type WorldMap } from '@guildhood/shared';

/**
 * Client-side prediction for the player's own car. Inputs are applied locally right away so the
 * car responds instantly; every snapshot resets to the server's authoritative state and replays
 * the inputs the server has not processed yet. Visual error is smoothed out over a few frames.
 */
export class Predictor {
  state: CarState | null = null;
  private pending: { seq: number; input: DriveInput }[] = [];
  private offX = 0;
  private offZ = 0;
  private offH = 0;
  /** Distance of the last correction (diagnostics/tests). */
  lastCorrection = 0;

  constructor(
    private readonly spec: VehicleSpec,
    private readonly world: WorldMap,
  ) {}

  reset(server: CarState): void {
    this.state = { ...server };
    this.pending = [];
    this.offX = this.offZ = this.offH = 0;
  }

  step(seq: number, input: DriveInput): void {
    if (!this.state) return;
    this.pending.push({ seq, input });
    if (this.pending.length > 120) this.pending.shift();
    this.state = stepCar(this.state, input, this.spec, this.world, TICK_DT);
  }

  reconcile(server: CarState, ack: number): void {
    if (!this.state) {
      this.reset(server);
      return;
    }
    this.pending = this.pending.filter((p) => p.seq > ack);
    let s: CarState = { ...server };
    for (const p of this.pending) s = stepCar(s, p.input, this.spec, this.world, TICK_DT);
    const dx = this.state.x - s.x;
    const dz = this.state.z - s.z;
    this.lastCorrection = Math.hypot(dx, dz);
    if (this.lastCorrection > 6) {
      this.offX = this.offZ = this.offH = 0; // too far: snap
    } else {
      this.offX += dx;
      this.offZ += dz;
      this.offH = wrapAngle(this.offH + wrapAngle(this.state.heading - s.heading));
    }
    this.state = s;
  }

  /** Pose to draw this frame: authoritative-consistent state plus a decaying visual offset. */
  visual(dt: number): CarState | null {
    if (!this.state) return null;
    const k = Math.exp(-dt * 10);
    this.offX *= k;
    this.offZ *= k;
    this.offH *= k;
    return { ...this.state, x: this.state.x + this.offX, z: this.state.z + this.offZ, heading: this.state.heading + this.offH };
  }
}
