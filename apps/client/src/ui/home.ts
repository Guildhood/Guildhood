import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { CAR_PALETTE, type JoinSpec } from '@guildhood/shared';
import { STARTER_NEIGHBORHOOD_ID } from '../config.ts';
import { friendlyError } from '../supabase.ts';
import { clear, formatFriendCode, formatMarks, h } from './dom.ts';
import type { Screen } from './screen.ts';
import { toast } from './toast.ts';

export interface HomeContext {
  supabase: SupabaseClient;
  userId: string;
  drive(join: JoinSpec): void;
  signOut(): void;
}

interface Friend {
  user_id: string;
  display_name: string;
  online: boolean;
  instance_id: string | null;
  neighborhood_name: string | null;
  player_count: number | null;
  capacity: number | null;
}
interface PendingRequest {
  request_id: string;
  user_id: string;
  display_name: string;
}
interface Social {
  friends: Friend[];
  incoming: PendingRequest[];
  outgoing: PendingRequest[];
}
interface HomeData {
  displayName: string;
  friendCode: string;
  balance: number;
  activeVehicleId: string | null;
  cars: { id: string; model_id: string; color_index: number; name: string }[];
  neighborhoodName: string;
  social: Social;
}

const SVG = 'http://www.w3.org/2000/svg';

/** Small side-view drawing of the player's car in its paint color (original art). */
export function carArt(hex: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 120 64');
  svg.setAttribute('class', 'car-art');
  svg.setAttribute('aria-hidden', 'true');
  const color = `#${hex.toString(16).padStart(6, '0')}`;
  const parts: [string, Record<string, string>][] = [
    ['path', { d: 'M10 40 Q12 28 30 26 L44 12 Q48 9 56 9 L82 9 Q90 9 94 14 L104 26 Q114 28 114 40 L114 46 L10 46 Z', fill: color }],
    ['path', { d: 'M48 14 L58 13 L58 26 L38 26 Z M64 13 L82 13 Q88 13 90 17 L96 26 L64 26 Z', fill: '#24323b' }],
    ['circle', { cx: '34', cy: '46', r: '10', fill: '#2b2b2b' }],
    ['circle', { cx: '90', cy: '46', r: '10', fill: '#2b2b2b' }],
    ['circle', { cx: '34', cy: '46', r: '4', fill: '#bdbdbd' }],
    ['circle', { cx: '90', cy: '46', r: '4', fill: '#bdbdbd' }],
    ['rect', { x: '106', y: '32', width: '7', height: '4', rx: '1', fill: '#fff3c4' }],
  ];
  for (const [tag, attrs] of parts) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

export class HomeScreen implements Screen {
  readonly el: HTMLElement;
  private data: HomeData | null = null;
  private channel: RealtimeChannel | null = null;
  private poll: number | null = null;
  private refreshTimer: number | null = null;
  private disposed = false;
  // Persistent parts: background refreshes (Realtime, polling) must never wipe what the player is
  // typing or close an open sheet, so only the read-only sections are rebuilt.
  private topbar: HTMLElement = h('div');
  private leftCol: HTMLElement = h('div', { class: 'col' });
  private readonly friendsList = h('div', { class: 'list scroll' });
  private readonly friendsPanel: HTMLElement;
  private readonly overlay = h('div');
  private structured = false;

  constructor(private readonly ctx: HomeContext) {
    this.el = h('div', { class: 'home', 'data-testid': 'home' }, h('div', { class: 'muted', text: 'Loading…' }));
    this.friendsPanel = this.buildFriendsPanel();
  }

  /** Returning to the app (iPad wakes, app switcher) refreshes friends' status right away. */
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') void this.refreshSocial();
  };

  mounted(): void {
    void this.load();
    this.subscribe();
    this.poll = window.setInterval(() => void this.refreshSocial(), 15_000);
    document.addEventListener('visibilitychange', this.onVisible);
    void this.showRecentInvites();
  }

  unmount(): void {
    this.disposed = true;
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.poll !== null) window.clearInterval(this.poll);
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.channel) void this.ctx.supabase.removeChannel(this.channel);
  }

  private async load(): Promise<void> {
    const sb = this.ctx.supabase;
    const uid = this.ctx.userId;
    const [profile, wallet, cars, social, hood] = await Promise.all([
      sb.from('profiles').select('display_name, friend_code, active_vehicle_id').eq('id', uid).single(),
      sb.from('wallets').select('balance').eq('user_id', uid).single(),
      sb.from('player_vehicles').select('id, model_id, color_index, vehicle_models(name)').eq('owner_id', uid).order('acquired_at'),
      sb.rpc('get_social_overview'),
      sb.from('neighborhoods').select('name').eq('id', STARTER_NEIGHBORHOOD_ID).single(),
    ]);
    if (this.disposed) return;
    const failed = [profile, wallet, cars, social, hood].find((r) => r.error);
    if (failed?.error || !profile.data || !wallet.data) {
      this.renderError(friendlyError(failed?.error?.message));
      return;
    }
    this.data = {
      displayName: profile.data.display_name,
      friendCode: profile.data.friend_code,
      balance: Number(wallet.data.balance),
      activeVehicleId: profile.data.active_vehicle_id,
      cars: (cars.data ?? []).map((c) => ({
        id: c.id,
        model_id: c.model_id,
        color_index: c.color_index,
        name: (c.vehicle_models as unknown as { name: string } | null)?.name ?? c.model_id,
      })),
      neighborhoodName: hood.data?.name ?? 'Your neighborhood',
      social: social.data as Social,
    };
    this.render();
  }

  private async refreshSocial(): Promise<void> {
    const { data, error } = await this.ctx.supabase.rpc('get_social_overview');
    if (this.disposed || error || !this.data) return;
    this.data.social = data as Social;
    this.render();
  }

  private refreshSoon(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refreshSocial(), 250);
  }

  /** Realtime: our notifications (RLS: only ours) and friends' presence changes (RLS: friends only). */
  private subscribe(): void {
    const uid = this.ctx.userId;
    this.channel = this.ctx.supabase
      .channel(`home-${uid}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` }, (payload) =>
        this.onNotification(payload.new as { id: string; kind: string; payload: Record<string, string> }),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'session_presence' }, () => this.refreshSoon())
      .subscribe();
  }

  private onNotification(n: { id: string; kind: string; payload: Record<string, string> }): void {
    if (n.kind === 'friend_request') {
      toast(`${n.payload.from_name ?? 'Someone'} sent you a friend request`, { testId: 'friend-request-toast' });
    } else if (n.kind === 'friend_request_accepted') {
      toast(`${n.payload.friend_name ?? 'Your friend'} accepted your friend request`);
    } else if (n.kind === 'session_invite') {
      this.inviteToast(n.payload);
    }
    void this.ctx.supabase.rpc('mark_notifications_read', { p_ids: [n.id] });
    this.refreshSoon();
  }

  private inviteToast(p: Record<string, string>): void {
    const from = p.from_user;
    if (!from) return;
    toast(`${p.from_name ?? 'A friend'} invited you to ${p.neighborhood_name ?? 'drive'}`, {
      testId: 'invite-toast',
      action: { label: 'Join', onClick: () => this.ctx.drive({ mode: 'friend', friendId: from }) },
    });
  }

  /** Invites that arrived while the app was closed (last two minutes) are still offered. */
  private async showRecentInvites(): Promise<void> {
    const since = new Date(Date.now() - 2 * 60_000).toISOString();
    const { data } = await this.ctx.supabase
      .from('notifications')
      .select('id, kind, payload')
      .eq('kind', 'session_invite')
      .is('read_at', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(3);
    if (this.disposed || !data?.length) return;
    for (const n of data) this.inviteToast(n.payload as Record<string, string>);
    void this.ctx.supabase.rpc('mark_notifications_read', { p_ids: data.map((n) => n.id) });
  }

  private renderError(message: string): void {
    this.structured = false;
    clear(this.el);
    this.el.append(
      h(
        'div',
        { class: 'center-screen' },
        h('div', { class: 'card' }, h('h2', { text: 'Couldn’t load your neighborhood' }), h('p', { class: 'muted', text: message }), h('button', { text: 'Try again', onClick: () => void this.load() })),
      ),
    );
  }

  private render(): void {
    const d = this.data;
    if (!d) return;
    const friendsDriving = d.social.friends.filter((f) => f.online).length;
    const activeCar = d.cars.find((c) => c.id === d.activeVehicleId) ?? d.cars[0];

    const topbar = h(
      'div',
      { class: 'topbar' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark', 'aria-hidden': 'true' }), 'Guildhood'),
      h('button', { class: 'chip', 'data-testid': 'display-name', text: d.displayName, 'aria-label': 'Change your name', onClick: () => this.renameSheet() }),
      h('div', { class: 'chip marks', 'data-testid': 'balance', text: formatMarks(d.balance) }),
      h(
        'div',
        { class: 'chip' },
        'Friend code ',
        h('strong', { 'data-testid': 'friend-code', text: formatFriendCode(d.friendCode) }),
        h('button', { class: 'secondary', text: 'Copy', onClick: () => void this.copyCode(d.friendCode) }),
      ),
      h('button', { class: 'secondary', text: 'Sign out', onClick: () => this.ctx.signOut() }),
    );

    const hood = h(
      'div',
      { class: 'panel hood' },
      h('h2', { 'data-testid': 'neighborhood-name', text: d.neighborhoodName }),
      h('div', {
        class: 'muted',
        text: friendsDriving > 0 ? `Your neighborhood · ${friendsDriving} friend${friendsDriving === 1 ? '' : 's'} driving now` : 'Your neighborhood',
      }),
      h('button', {
        class: 'drive-btn',
        'data-testid': 'drive',
        text: activeCar ? 'Drive' : 'No car',
        disabled: !activeCar,
        onClick: () => this.ctx.drive({ mode: 'auto' }),
      }),
    );

    const garage = h('div', { class: 'panel', 'data-testid': 'garage' }, h('h2', { text: 'Garage' }));
    if (activeCar) {
      garage.append(
        h(
          'div',
          { class: 'car-card' },
          carArt(CAR_PALETTE[activeCar.color_index]?.hex ?? CAR_PALETTE[0]!.hex),
          h('div', {}, h('div', { class: 'name', 'data-testid': 'car-name', style: { fontWeight: '700', fontSize: '18px' }, text: activeCar.name }), h('div', { class: 'muted', text: 'Owned · in use' })),
        ),
        h(
          'div',
          { class: 'swatches', role: 'radiogroup', 'aria-label': 'Paint color' },
          ...CAR_PALETTE.map((c, i) =>
            h('button', {
              class: `swatch${i === activeCar.color_index ? ' selected' : ''}`,
              style: { background: `#${c.hex.toString(16).padStart(6, '0')}` },
              role: 'radio',
              'aria-checked': String(i === activeCar.color_index),
              'aria-label': c.name,
              'data-testid': `swatch-${i}`,
              onClick: () => void this.recolor(activeCar.id, i),
            }),
          ),
        ),
      );
    } else {
      garage.append(h('p', { class: 'muted', text: 'You don’t own a car yet.' }));
    }

    const left = h('div', { class: 'col' }, hood, garage);
    if (!this.structured) {
      this.el.replaceChildren(topbar, h('div', { class: 'home-grid' }, left, h('div', { class: 'col' }, this.friendsPanel)), this.overlay);
      this.structured = true;
    } else {
      this.topbar.replaceWith(topbar);
      this.leftCol.replaceWith(left);
    }
    this.topbar = topbar;
    this.leftCol = left;
    this.renderFriends(d.social);
  }

  /** Built once: the friend-code field keeps its text and focus across refreshes. */
  private buildFriendsPanel(): HTMLElement {
    const codeInput = h('input', {
      type: 'text',
      autocapitalize: 'characters',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '9',
      placeholder: 'Friend code',
      'aria-label': 'Friend code',
      'data-testid': 'add-friend-code',
      class: 'grow',
    });
    const error = h('div', { class: 'error', role: 'alert' });
    const add = h('button', {
      text: 'Add',
      'data-testid': 'add-friend',
      onClick: async () => {
        add.disabled = true;
        const { data, error: err } = await this.ctx.supabase.rpc('send_friend_request', { p_friend_code: codeInput.value });
        add.disabled = false;
        if (err) {
          error.textContent = friendlyError(err.message);
          return;
        }
        error.textContent = '';
        codeInput.value = '';
        const status = (data as { status: string }).status;
        toast(
          status === 'accepted'
            ? 'You’re now friends!'
            : status === 'already_friends'
              ? 'You’re already friends.'
              : status === 'already_pending'
                ? 'Request already sent.'
                : 'Friend request sent.',
        );
        void this.refreshSocial();
      },
    });

    return h('div', { class: 'panel grow' }, h('h2', { text: 'Friends' }), h('div', { class: 'row' }, codeInput, add), error, this.friendsList);
  }

  private renderFriends(s: Social): void {
    const list = this.friendsList;
    clear(list);
    for (const r of s.incoming) {
      list.append(
        h(
          'div',
          { class: 'list-item', 'data-testid': 'incoming-request' },
          h('div', { class: 'grow' }, h('div', { class: 'name', text: r.display_name }), h('div', { class: 'muted', text: 'Wants to be friends' })),
          h('button', { text: 'Accept', 'data-testid': 'accept-request', onClick: () => void this.respond(r.request_id, true) }),
          h('button', { class: 'secondary', text: 'Decline', onClick: () => void this.respond(r.request_id, false) }),
        ),
      );
    }
    for (const f of s.friends) {
      const where = f.online ? `Driving in ${f.neighborhood_name ?? 'a neighborhood'} (${f.player_count}/${f.capacity})` : 'Not driving';
      list.append(
        h(
          'div',
          { class: 'list-item', 'data-testid': 'friend', dataset: { userId: f.user_id, online: String(f.online) } },
          h('div', { class: `dot${f.online ? ' on' : ''}`, 'aria-hidden': 'true' }),
          h('div', { class: 'grow' }, h('div', { class: 'name', text: f.display_name }), h('div', { class: 'muted', text: where })),
          f.online
            ? h('button', {
                text: 'Join',
                'data-testid': 'join-friend',
                onClick: () => this.ctx.drive({ mode: 'friend', friendId: f.user_id }),
              })
            : null,
        ),
      );
    }
    for (const r of s.outgoing) {
      list.append(
        h(
          'div',
          { class: 'list-item', 'data-testid': 'outgoing-request' },
          h('div', { class: 'grow' }, h('div', { class: 'name', text: r.display_name }), h('div', { class: 'muted', text: 'Request sent' })),
          h('button', {
            class: 'secondary',
            text: 'Cancel',
            onClick: async () => {
              await this.ctx.supabase.rpc('cancel_friend_request', { p_request_id: r.request_id });
              void this.refreshSocial();
            },
          }),
        ),
      );
    }
    if (!list.children.length) {
      list.append(h('p', { class: 'muted', text: 'No friends yet. Share your friend code, or add a friend’s code above.' }));
    }
  }

  private async respond(requestId: string, accept: boolean): Promise<void> {
    const { error } = await this.ctx.supabase.rpc('respond_friend_request', { p_request_id: requestId, p_accept: accept });
    if (error) toast(friendlyError(error.message));
    void this.refreshSocial();
  }

  private async recolor(vehicleId: string, colorIndex: number): Promise<void> {
    const { error } = await this.ctx.supabase.from('player_vehicles').update({ color_index: colorIndex }).eq('id', vehicleId);
    if (error) {
      toast(friendlyError(error.message));
      return;
    }
    const car = this.data?.cars.find((c) => c.id === vehicleId);
    if (car) car.color_index = colorIndex;
    this.render();
  }

  private async copyCode(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(formatFriendCode(code));
      toast('Friend code copied');
    } catch {
      toast(`Your friend code is ${formatFriendCode(code)}`);
    }
  }

  private renameSheet(): void {
    if (!this.data) return;
    const input = h('input', { type: 'text', maxlength: '20', value: this.data.displayName, 'aria-label': 'Display name', 'data-testid': 'rename-input' });
    const error = h('div', { class: 'error', role: 'alert' });
    const close = () => backdrop.remove();
    const backdrop = h(
      'div',
      { class: 'sheet-backdrop', onClick: (e: Event) => e.target === backdrop && close() },
      h(
        'form',
        {
          class: 'sheet',
          onSubmit: async (e: Event) => {
            e.preventDefault();
            const name = input.value.trim().replace(/\s+/g, ' ');
            const { error: err } = await this.ctx.supabase.from('profiles').update({ display_name: name }).eq('id', this.ctx.userId);
            if (err) {
              error.textContent = friendlyError(err.message);
              return;
            }
            if (this.data) this.data.displayName = name;
            close();
            this.render();
          },
        },
        h('h2', { text: 'Your driver name' }),
        h('p', { class: 'muted', style: { margin: '0' }, text: 'Friends and other drivers see this above your car.' }),
        input,
        error,
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary grow', text: 'Cancel', onClick: close }), h('button', { type: 'submit', class: 'grow', text: 'Save', 'data-testid': 'rename-save' })),
      ),
    );
    this.overlay.append(backdrop);
    setTimeout(() => input.focus(), 50);
  }
}
