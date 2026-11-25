import type { SupabaseClient } from '@supabase/supabase-js';
import {
  TICK_DT,
  forwardSpeed,
  vehicleSpec,
  worldByKey,
  type CarState,
  type JoinSpec,
  type NetCar,
  type PlayerInfo,
  type ServerMessage,
} from '@guildhood/shared';
import { TouchControls } from '../game/controls.ts';
import { RemoteCars, ServerClock } from '../game/interpolation.ts';
import { GameConnection, type ConnFailure, type ConnStatus } from '../game/net.ts';
import { Predictor } from '../game/prediction.ts';
import { WorldView } from '../game/world-view.ts';
import { freshAccessToken, friendlyError } from '../supabase.ts';
import { clear, h } from './dom.ts';
import type { Screen } from './screen.ts';
import { toast } from './toast.ts';

export interface DriveContext {
  supabase: SupabaseClient;
  gameServerUrl: string;
  neighborhoodId: string;
  join: JoinSpec;
  exit(): void;
  driveAnyway(): void;
}

/** Read-only diagnostics, used by the automated iPad-emulation tests. */
export interface DriveDebug {
  status: ConnStatus;
  instanceId: string | null;
  selfId: string | null;
  resumed: boolean;
  welcomes: number;
  serverCar: NetCar | null;
  /** Every car in the latest snapshot, as this player received it. */
  lastCars: NetCar[];
  predicted: CarState | null;
  remoteIds: string[];
  players: PlayerInfo[];
  rttMs: number | null;
}

declare global {
  interface Window {
    __guildhoodDebug?: { drive: DriveDebug | null; dropConnection?: () => void; auth?: { state: string; userId: string | null } };
  }
}

export class DriveScreen implements Screen {
  readonly el: HTMLElement;
  private readonly canvas = h('canvas', { 'data-testid': 'game-canvas' });
  private readonly hud: HTMLElement;
  private readonly netDot = h('span', { class: 'net-dot' });
  private readonly netText = h('span', { 'data-testid': 'net-status', text: 'Connecting…' });
  private readonly titleName = h('span', { 'data-testid': 'hood-title', text: 'Joining…' });
  private readonly titleCount = h('small', { 'data-testid': 'player-count', text: '' });
  private readonly speedo = h('div', { class: 'hud-pill speedo', 'data-testid': 'speed', text: '0 km/h' });
  private readonly bannerSlot = h('div');
  private readonly controls = new TouchControls();
  private readonly conn: GameConnection;
  private readonly clock = new ServerClock();
  private readonly remote = new RemoteCars();
  private readonly players = new Map<string, PlayerInfo>();
  private view: WorldView | null = null;
  private predictor: Predictor | null = null;
  private selfId: string | null = null;
  private seq = 0;
  private acc = 0;
  private lastFrame = 0;
  private raf = 0;
  private disposed = false;
  private readonly debug: DriveDebug = {
    status: 'connecting',
    instanceId: null,
    selfId: null,
    resumed: false,
    welcomes: 0,
    serverCar: null,
    lastCars: [],
    predicted: null,
    remoteIds: [],
    players: [],
    rttMs: null,
  };
  private readonly onResize = () => this.view?.resize();
  private readonly onHidden = () => {
    if (document.visibilityState !== 'visible') this.controls.releaseAll();
  };

  constructor(private readonly ctx: DriveContext) {
    this.hud = h(
      'div',
      { class: 'hud' },
      h(
        'div',
        { class: 'hud-top' },
        h('button', { class: 'secondary', text: 'Leave', 'data-testid': 'leave', onClick: () => this.leave() }),
        h('div', { class: 'hud-pill', 'aria-live': 'polite' }, this.netDot, this.netText),
        h('div', { class: 'hud-pill title' }, this.titleName, this.titleCount),
        h('button', { text: 'Invite', 'data-testid': 'invite', onClick: () => void this.inviteSheet() }),
      ),
      this.bannerSlot,
      this.speedo,
      this.controls.steerPad,
      this.controls.pedals,
    );
    this.el = h('div', { class: 'drive', 'data-testid': 'drive-screen' }, this.canvas, this.hud);
    this.conn = new GameConnection(ctx.gameServerUrl, () => freshAccessToken(ctx.supabase), ctx.neighborhoodId, ctx.join, {
      onStatus: (s, info) => this.onStatus(s, info.attempt, info.failure),
      onWelcome: (m) => this.onWelcome(m),
      onSnapshot: (tick, ack, cars) => this.onSnapshot(tick, ack, cars),
      onPlayerJoined: (p) => this.onPlayerJoined(p),
      onPlayerLeft: (id, reason) => this.onPlayerLeft(id, reason),
      onRtt: (ms) => {
        this.debug.rttMs = ms;
        if (this.conn.status === 'live') {
          this.netText.textContent = `${Math.round(ms)} ms`;
          this.netDot.className = `net-dot${ms > 250 ? ' bad' : ''}`;
        }
      },
    });
  }

  mounted(): void {
    window.__guildhoodDebug = { ...window.__guildhoodDebug, drive: this.debug, dropConnection: () => this.conn.simulateDrop() };
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onHidden);
    this.conn.start();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /** Supabase refreshed the session: hand the new token to the game server. */
  tokenRefreshed(token: string): void {
    this.conn.sendAuth(token);
  }

  private leave(): void {
    this.conn.leave();
    this.ctx.exit();
  }

  private onStatus(status: ConnStatus, attempt: number, failure?: ConnFailure): void {
    this.debug.status = status;
    clear(this.bannerSlot);
    this.controls.enabled = status === 'live';
    if (status !== 'live') this.controls.releaseAll();
    if (status === 'live') {
      this.netDot.className = 'net-dot';
      return;
    }
    this.netDot.className = 'net-dot down';
    if (status === 'connecting' || status === 'reconnecting') {
      const label = status === 'connecting' ? 'Joining the neighborhood…' : `Reconnecting…${attempt > 1 ? ` (try ${attempt})` : ''}`;
      this.netText.textContent = status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
      this.bannerSlot.append(h('div', { class: 'banner', 'data-testid': 'reconnecting', role: 'status' }, h('div', { class: 'spinner' }), label));
    } else if (status === 'failed') {
      this.netText.textContent = 'Disconnected';
      this.showFailure(failure ?? { code: 'network', message: 'Disconnected.' });
    }
  }

  private showFailure(f: ConnFailure): void {
    const messages: Partial<Record<ConnFailure['code'], string>> = {
      instance_full: 'That session is full. You can drive in another copy of the neighborhood.',
      instance_not_found: 'That session has ended.',
      friend_not_online: 'Your friend isn’t driving right now.',
      not_allowed: 'You can only join sessions that a friend is in.',
      no_vehicle: 'You need a car to drive. Check your garage.',
      replaced: 'You started driving on another screen.',
      auth_failed: 'Your sign-in has expired. Please sign in again.',
      backend_unavailable: 'Guildhood’s servers are having trouble. Try again in a moment.',
      network: 'Can’t reach the game server. Check your Wi-Fi.',
      account_restricted: 'This account is restricted and can’t play right now.',
      profile_incomplete: 'Finish setting up your profile before driving.',
    };
    const canDriveAnyway = ['instance_full', 'instance_not_found', 'friend_not_online', 'not_allowed'].includes(f.code);
    const sheet = h(
      'div',
      { class: 'sheet-backdrop', 'data-testid': 'drive-failed' },
      h(
        'div',
        { class: 'sheet' },
        h('h2', { text: 'Can’t keep driving' }),
        h('p', { class: 'muted', 'data-testid': 'failure-reason', dataset: { code: f.code }, text: messages[f.code] ?? f.message }),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'secondary grow', text: 'Back to home', onClick: () => this.leave() }),
          canDriveAnyway
            ? h('button', { class: 'grow', text: 'Drive anyway', onClick: () => this.ctx.driveAnyway() })
            : h('button', { class: 'grow', text: 'Try again', onClick: () => this.ctx.driveAnyway() }),
        ),
      ),
    );
    this.bannerSlot.append(sheet);
  }

  private onWelcome(m: Extract<ServerMessage, { t: 'welcome' }>): void {
    const world = worldByKey(m.mapKey);
    if (!world) {
      this.showFailure({ code: 'network', message: 'This version of the app doesn’t have that neighborhood map. Reload to update.' });
      return;
    }
    if (!this.view || this.view.world.key !== world.key) {
      this.view?.dispose();
      this.view = new WorldView(this.canvas, world);
    }
    this.selfId = m.selfId;
    this.players.clear();
    for (const p of m.players) this.players.set(p.id, p);
    // Rebuild car meshes from the authoritative roster.
    for (const id of this.view.carIds()) if (!this.players.has(id)) this.view.removeCar(id);
    for (const p of m.players) this.view.upsertCar(p.id, p.model, p.color, p.id === m.selfId ? null : p.name);

    const self = m.players.find((p) => p.id === m.selfId)!;
    const spec = vehicleSpec(self.model)!;
    this.predictor = new Predictor(spec, world);
    const mine = m.cars.find((c) => c.id === m.selfId);
    if (mine) this.predictor.reset(netToCar(mine));
    this.remote.clear();
    this.clock.reset();
    this.clock.observe(m.tick, performance.now());
    this.remote.push(m.tick, m.cars, m.selfId);
    this.acc = 0;

    this.titleName.textContent = m.neighborhoodName;
    this.updateCount();
    if (m.resumed && this.debug.welcomes > 0) toast('Reconnected');
    Object.assign(this.debug, {
      instanceId: m.instanceId,
      selfId: m.selfId,
      resumed: m.resumed,
      welcomes: this.debug.welcomes + 1,
      players: m.players,
    });
  }

  private onSnapshot(tick: number, ack: number, cars: NetCar[]): void {
    if (!this.selfId) return;
    this.clock.observe(tick, performance.now());
    const mine = cars.find((c) => c.id === this.selfId);
    if (mine && this.predictor) {
      this.predictor.reconcile(netToCar(mine), ack);
      this.debug.serverCar = mine;
    }
    this.remote.push(tick, cars, this.selfId);
    this.debug.remoteIds = this.remote.ids();
    this.debug.lastCars = cars;
  }

  private onPlayerJoined(p: PlayerInfo): void {
    const isNew = !this.players.has(p.id);
    this.players.set(p.id, p);
    this.view?.upsertCar(p.id, p.model, p.color, p.id === this.selfId ? null : p.name);
    if (isNew && p.id !== this.selfId) toast(`${p.name} joined`, { testId: 'joined-toast' });
    this.debug.players = [...this.players.values()];
    this.updateCount();
  }

  private onPlayerLeft(id: string, reason: string): void {
    const p = this.players.get(id);
    this.players.delete(id);
    this.view?.removeCar(id);
    if (p && id !== this.selfId) toast(reason === 'timeout' ? `${p.name} lost connection` : `${p.name} left`);
    this.debug.players = [...this.players.values()];
    this.updateCount();
  }

  private updateCount(): void {
    const n = this.players.size;
    this.titleCount.textContent = `${n} driver${n === 1 ? '' : 's'} here`;
  }

  private frame(now: number): void {
    if (this.disposed) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const view = this.view;
    const predictor = this.predictor;
    if (!view || !predictor || !this.selfId) return;

    // Fixed-rate input sampling and prediction, matching the server tick.
    if (this.conn.status === 'live') {
      this.acc += dt;
      while (this.acc >= TICK_DT) {
        const input = this.controls.input();
        this.seq++;
        this.conn.sendInput(this.seq, input);
        predictor.step(this.seq, input);
        this.acc -= TICK_DT;
      }
    } else {
      this.acc = 0;
    }

    const me = predictor.visual(dt);
    if (me) {
      const steer = this.controls.input().steer;
      view.car(this.selfId)?.setPose(me.x, me.z, me.heading, steer);
      const v = forwardSpeed(me);
      view.follow(me, v, dt);
      this.speedo.textContent = `${Math.round(Math.abs(v) * 3.6)} km/h`;
      this.debug.predicted = me;
    }
    const renderTick = this.clock.renderTick(now);
    if (renderTick !== null) {
      for (const [id, pose] of this.remote.sample(renderTick)) {
        const mesh = view.car(id);
        if (!mesh) continue;
        mesh.setPose(pose.x, pose.z, pose.h, pose.s);
        mesh.setConnected(pose.connected);
      }
    }
    view.render();
    if (view.contextLost) this.showFailure({ code: 'network', message: 'iPadOS reset the graphics. Go back home and drive again.' });
  }

  private async inviteSheet(): Promise<void> {
    const { data, error } = await this.ctx.supabase.rpc('get_social_overview');
    const friends = (data as { friends: { user_id: string; display_name: string; online: boolean; instance_id: string | null }[] } | null)?.friends ?? [];
    const list = h('div', { class: 'list scroll', style: { maxHeight: '50vh' } });
    if (error) list.append(h('p', { class: 'error', text: friendlyError(error.message) }));
    else if (!friends.length) list.append(h('p', { class: 'muted', text: 'Add friends on the home screen to invite them.' }));
    for (const f of friends) {
      const here = f.instance_id !== null && f.instance_id === this.debug.instanceId;
      const btn = h('button', {
        text: here ? 'Here' : 'Invite',
        disabled: here,
        'data-testid': 'invite-friend',
        onClick: async () => {
          btn.disabled = true;
          const res = await this.ctx.supabase.rpc('invite_friend_to_session', { p_friend_id: f.user_id });
          if (res.error) {
            toast(friendlyError(res.error.message));
            btn.disabled = false;
            return;
          }
          btn.textContent = (res.data as { status: string }).status === 'throttled' ? 'Sent' : 'Invited';
        },
      });
      list.append(h('div', { class: 'list-item' }, h('div', { class: `dot${f.online ? ' on' : ''}` }), h('div', { class: 'grow name', text: f.display_name }), btn));
    }
    const backdrop = h(
      'div',
      { class: 'sheet-backdrop', onClick: (e: Event) => e.target === backdrop && backdrop.remove() },
      h('div', { class: 'sheet' }, h('h2', { text: 'Invite friends' }), list, h('button', { class: 'secondary', text: 'Done', onClick: () => backdrop.remove() })),
    );
    this.hud.append(backdrop);
  }

  unmount(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.conn.dispose();
    this.view?.dispose();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onHidden);
    if (window.__guildhoodDebug?.drive === this.debug) window.__guildhoodDebug = { ...window.__guildhoodDebug, drive: null };
  }
}

function netToCar(c: NetCar): CarState {
  return { x: c.x, z: c.z, heading: c.h, vx: c.vx, vz: c.vz };
}
