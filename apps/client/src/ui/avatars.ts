import { AVATARS } from '@guildhood/shared';

/**
 * Preset avatar badges, drawn as inline SVG (original artwork, no image files). Each id in the
 * shared AVATARS list (and public.avatar_catalog) has an emblem here; a unit test checks coverage.
 */
const SVG = 'http://www.w3.org/2000/svg';

type Shape = [tag: string, attrs: Record<string, string>];

const stroke = (d: string, width = '1.8'): Shape => ['path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }];
const fill = (d: string): Shape => ['path', { d, fill: 'currentColor' }];

export const EMBLEMS: Record<string, Shape[]> = {
  leaf_moss: [fill('M17.5 5.5c-6 0-11 3-11 9 0 2 1 3.5 2.5 4 4-1 8.5-6 8.5-13z'), stroke('M7 19c3-4 6-7 9-10', '1.4')],
  wheel_copper: [
    ['circle', { cx: '12', cy: '12', r: '7', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2' }],
    ['circle', { cx: '12', cy: '12', r: '2', fill: 'currentColor' }],
    stroke('M12 5v14M5 12h14M7 7l10 10M17 7 7 17', '1.2'),
  ],
  lantern_amber: [stroke('M9 6a3 3 0 0 1 6 0'), fill('M8 7h8l1 2v8l-1 2H8l-1-2V9z'), ['rect', { x: '10', y: '10', width: '4', height: '6', rx: '1', fill: 'var(--avatar-bg)' }]],
  key_brass: [['circle', { cx: '8', cy: '12', r: '3.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2' }], stroke('M11.5 12H19m-3 0v3m3-3v2', '2.2')],
  star_sky: [fill('M12 4l2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7 5.4-.6z')],
  bolt_sun: [fill('M13.5 3 6 13.5h5L9.5 21 18 10h-5.2z')],
  moon_plum: [fill('M15.5 4.5A8 8 0 1 0 19.5 15 6.5 6.5 0 0 1 15.5 4.5z')],
  house_brick: [fill('M12 4.5 4 11h2.2v8h4.3v-5h3v5h4.3v-8H20z')],
  flag_cherry: [stroke('M7 4v16', '2'), fill('M8 5h10l-2.5 3.5L18 12H8z')],
  gear_slate: [
    fill('M10.6 3h2.8l.5 2.3 1.6.7 2-1.3 2 2-1.3 2 .7 1.6 2.3.5v2.8l-2.3.5-.7 1.6 1.3 2-2 2-2-1.3-1.6.7-.5 2.3h-2.8l-.5-2.3-1.6-.7-2 1.3-2-2 1.3-2-.7-1.6L3 13.4v-2.8l2.3-.5.7-1.6-1.3-2 2-2 2 1.3 1.6-.7z'),
    ['circle', { cx: '12', cy: '12', r: '3', fill: 'var(--avatar-bg)' }],
  ],
  wave_mint: [stroke('M4 10c2-2 4-2 6 0s4 2 6 0 3-2 4-1M4 15c2-2 4-2 6 0s4 2 6 0 3-2 4-1', '2')],
  crown_chalk: [fill('M4 8l4 3.5L12 5l4 6.5L20 8l-1.6 9H5.6z'), ['rect', { x: '5.6', y: '17.6', width: '12.8', height: '2', rx: '1', fill: 'currentColor' }]],
};

export function renderAvatar(id: string | null | undefined, size = 48, label?: string): SVGSVGElement {
  const def = AVATARS.find((a) => a.id === id);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'avatar');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const bg = def?.bg ?? '#b7b0a2';
  svg.style.color = def?.fg ?? '#ffffff';
  svg.style.setProperty('--avatar-bg', bg);
  const circle = document.createElementNS(SVG, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '12');
  circle.setAttribute('fill', bg);
  svg.append(circle);
  for (const [tag, attrs] of def ? (EMBLEMS[def.id] ?? []) : []) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}
