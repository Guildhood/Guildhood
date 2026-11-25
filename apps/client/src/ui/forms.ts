import { passwordChecks } from '@guildhood/shared';
import { h } from './dom.ts';

let fieldCounter = 0;

export interface Field {
  wrap: HTMLElement;
  input: HTMLInputElement;
  setError(message: string | null): void;
}

/** A labelled input with its own error line (announced to assistive tech). */
export function field(opts: {
  label: string;
  type?: string;
  autocomplete?: string;
  inputmode?: string;
  value?: string;
  hint?: string;
  maxlength?: number;
  testId?: string;
}): Field {
  const id = `f${++fieldCounter}`;
  const error = h('div', { class: 'error', id: `${id}-error`, role: 'alert' });
  const input = h('input', {
    id,
    type: opts.type ?? 'text',
    autocomplete: opts.autocomplete ?? 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    inputmode: opts.inputmode,
    value: opts.value,
    maxlength: opts.maxlength ? String(opts.maxlength) : undefined,
    'aria-describedby': `${id}-error${opts.hint ? ` ${id}-hint` : ''}`,
    'data-testid': opts.testId,
  });
  const wrap = h(
    'div',
    { class: 'field' },
    h('label', { for: id, text: opts.label }),
    input,
    opts.hint ? h('div', { class: 'hint', id: `${id}-hint`, text: opts.hint }) : null,
    error,
  );
  return {
    wrap,
    input,
    setError(message) {
      error.textContent = message ?? '';
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
    },
  };
}

/** Password input with a show/hide button. */
export function passwordField(opts: { label: string; autocomplete: 'current-password' | 'new-password'; testId?: string }): Field {
  const f = field({ label: opts.label, type: 'password', autocomplete: opts.autocomplete, testId: opts.testId });
  const toggle = h('button', {
    type: 'button',
    class: 'secondary reveal',
    text: 'Show',
    'aria-label': `Show ${opts.label.toLowerCase()}`,
    'aria-pressed': 'false',
    'data-testid': opts.testId ? `${opts.testId}-toggle` : undefined,
  });
  toggle.addEventListener('click', () => {
    const show = f.input.type === 'password';
    f.input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${opts.label.toLowerCase()}`);
  });
  const row = h('div', { class: 'input-row' });
  f.input.replaceWith(row);
  row.append(f.input, toggle);
  return f;
}

/** Live checklist for the password policy. */
export function passwordChecklist(input: HTMLInputElement): HTMLElement {
  const items = {
    length: h('li', { text: 'At least 8 characters' }),
    letter: h('li', { text: 'At least one letter' }),
    digit: h('li', { text: 'At least one number' }),
  };
  const list = h('ul', { class: 'checklist', 'aria-label': 'Password requirements' }, items.length, items.letter, items.digit);
  const update = () => {
    const c = passwordChecks(input.value);
    for (const [k, li] of Object.entries(items)) li.classList.toggle('met', c[k as keyof typeof c]);
  };
  input.addEventListener('input', update);
  update();
  return list;
}

/**
 * Return/Go on the iPad keyboard moves to the next field, and submits from the last one.
 * Also sets enterkeyhint so the key is labelled accordingly.
 */
export function wireFormKeys(form: HTMLFormElement, inputs: HTMLInputElement[]): void {
  inputs.forEach((input, i) => {
    const last = i === inputs.length - 1;
    input.setAttribute('enterkeyhint', last ? 'go' : 'next');
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || last) return;
      e.preventDefault();
      inputs[i + 1]!.focus();
    });
  });
  form.noValidate = true;
}

/** Shows a busy state on a submit button and blocks repeat submissions. */
export function setBusy(button: HTMLButtonElement, busy: boolean, busyLabel = 'Please wait…'): void {
  if (busy) {
    button.dataset.label ??= button.textContent ?? '';
    button.textContent = busyLabel;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.textContent = button.dataset.label ?? button.textContent;
    delete button.dataset.label;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
