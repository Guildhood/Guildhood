import { clamp, type DriveInput } from '@guildhood/shared';
import { h } from '../ui/dom.ts';

/**
 * On-screen touch controls: a steering slider for the left thumb and gas/brake pedals for the
 * right. Pointer Events give each finger its own pointerId, so steering and pedals work together.
 * Pointer capture keeps a pedal pressed if the thumb slides off it.
 */
export class TouchControls {
  readonly steerPad: HTMLElement;
  readonly pedals: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly gasEl: HTMLElement;
  private readonly brakeEl: HTMLElement;
  private steer = 0;
  private steerPointer: number | null = null;
  private readonly gasPointers = new Set<number>();
  private readonly brakePointers = new Set<number>();
  enabled = true;

  constructor() {
    this.knob = h('div', { class: 'steer-knob' });
    this.steerPad = h(
      'div',
      { class: 'steer-pad', 'data-testid': 'steer-pad', role: 'slider', 'aria-label': 'Steering', 'aria-valuemin': '-1', 'aria-valuemax': '1' },
      h('div', { class: 'arrow l' }),
      h('div', { class: 'arrow r' }),
      this.knob,
    );
    this.gasEl = h('div', { class: 'pedal gas', 'data-testid': 'gas', role: 'button', 'aria-label': 'Gas' }, 'GO');
    this.brakeEl = h('div', { class: 'pedal brake', 'data-testid': 'brake', role: 'button', 'aria-label': 'Brake and reverse' }, 'BRAKE');
    this.pedals = h('div', { class: 'pedals' }, this.brakeEl, this.gasEl);

    this.steerPad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.steerPointer = e.pointerId;
      this.steerPad.setPointerCapture(e.pointerId);
      this.updateSteer(e.clientX);
    });
    this.steerPad.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.steerPointer) this.updateSteer(e.clientX);
    });
    const endSteer = (e: PointerEvent) => {
      if (e.pointerId !== this.steerPointer) return;
      this.steerPointer = null;
      this.setSteer(0);
    };
    this.steerPad.addEventListener('pointerup', endSteer);
    this.steerPad.addEventListener('pointercancel', endSteer);
    this.steerPad.addEventListener('lostpointercapture', endSteer);

    this.bindPedal(this.gasEl, this.gasPointers);
    this.bindPedal(this.brakeEl, this.brakePointers);

    // iOS: suppress the long-press magnifier/callout and any synthetic scrolling on controls.
    for (const el of [this.steerPad, this.gasEl, this.brakeEl]) {
      el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  private bindPedal(el: HTMLElement, pointers: Set<number>): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      pointers.add(e.pointerId);
      el.classList.add('down');
    });
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) el.classList.remove('down');
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  private updateSteer(clientX: number): void {
    const r = this.steerPad.getBoundingClientRect();
    const half = Math.max(40, r.width / 2 - 40);
    let s = clamp((clientX - (r.left + r.width / 2)) / half, -1, 1);
    if (Math.abs(s) < 0.06) s = 0; // small dead zone so "straight" is easy to hold
    this.setSteer(s);
  }

  private setSteer(s: number): void {
    this.steer = s;
    const r = this.steerPad.getBoundingClientRect();
    const travel = Math.max(0, r.width / 2 - 60);
    this.knob.style.transform = `translateX(${s * travel}px)`;
    this.steerPad.setAttribute('aria-valuenow', s.toFixed(2));
  }

  /** Releases everything (app backgrounded, connection lost). */
  releaseAll(): void {
    this.steerPointer = null;
    this.setSteer(0);
    this.gasPointers.clear();
    this.brakePointers.clear();
    this.gasEl.classList.remove('down');
    this.brakeEl.classList.remove('down');
  }

  input(): DriveInput {
    if (!this.enabled) return { steer: 0, throttle: 0, brake: 0 };
    return {
      steer: this.steer,
      throttle: this.gasPointers.size > 0 ? 1 : 0,
      brake: this.brakePointers.size > 0 ? 1 : 0,
    };
  }
}
