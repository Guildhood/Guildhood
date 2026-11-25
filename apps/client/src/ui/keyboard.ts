/**
 * Keeps the active field visible above the iPad's on-screen keyboard. iPadOS Safari overlays the
 * keyboard on the page instead of resizing it; the visual viewport shrinks, so we publish the
 * covered height as --kb and form screens pad their scroll area by it.
 */
export function keyboardInset(innerHeight: number, viewportHeight: number, viewportOffsetTop: number): number {
  return Math.max(0, Math.round(innerHeight - viewportHeight - viewportOffsetTop));
}

export function installKeyboardAvoidance(): void {
  const vv = window.visualViewport;
  const update = () => {
    const inset = vv ? keyboardInset(window.innerHeight, vv.height, vv.offsetTop) : 0;
    document.documentElement.style.setProperty('--kb', `${inset}px`);
    if (inset > 0) revealFocused();
  };
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) setTimeout(revealFocused, 300);
  });
  update();
}

/** Scrolls the focused field, its error, and the form's main button into view. */
function revealFocused(): void {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !el.closest('.form-screen')) return;
  const field = el.closest('.field') ?? el;
  field.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
