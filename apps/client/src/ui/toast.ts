import { h } from './dom.ts';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

/** Shows a short message in the top-right (inside the safe area). */
export function toast(message: string, opts: { action?: ToastAction; ms?: number; testId?: string } = {}): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h('div', { class: 'toast', role: 'status', 'data-testid': opts.testId ?? 'toast' }, h('div', { class: 'grow', text: message }));
  if (opts.action) {
    const action = opts.action;
    el.append(
      h('button', {
        text: action.label,
        onClick: () => {
          el.remove();
          action.onClick();
        },
      }),
    );
  }
  el.append(h('button', { class: 'ghost', text: '✕', 'aria-label': 'Dismiss', onClick: () => el.remove() }));
  host.prepend(el);
  while (host.children.length > 4) host.lastElementChild?.remove();
  setTimeout(() => el.remove(), opts.ms ?? (opts.action ? 20_000 : 4_000));
}
