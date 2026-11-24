# iPad input and layout

Guildhood is designed for iPad touch first. Nothing requires a mouse, keyboard, or controller;
hardware keyboards work but are optional.

## Layout

- **Landscape only.** In portrait, a full-screen prompt asks the player to rotate (CSS
  orientation media query). The web manifest requests landscape for Home Screen installs.
- **Safe areas.** `viewport-fit=cover` with every screen padded by `env(safe-area-inset-*)`. The
  on-screen controls, HUD, toasts, connectivity banner, and settings footer sit inside the safe
  area.
- **Sizes.** Every tappable control is at least 44 pt (most are 48 pt); text inputs use ≥ 16 px
  (18 px) so iPadOS does not zoom the page on focus. Body text is 16–19 px.
- Pinch zoom, double-tap zoom, pull-to-refresh, text selection on controls, the long-press
  callout, and the magnifier are disabled where they would interfere.

## Forms (sign-in, registration, recovery, onboarding, settings)

| Requirement | Implementation |
|---|---|
| Touch input | All actions are buttons ≥ 44 pt; no hover-only affordances |
| Onscreen keyboard never covers the active field | `ui/keyboard.ts` measures the visual viewport and publishes the covered height as `--kb`; form screens scroll and pad by it, and the focused field (with its error and the next button) is scrolled into view |
| Focus advancement | `enterkeyhint="next"` on all but the last field; Return moves to the next field; `enterkeyhint="go"` submits from the last field (`wireFormKeys`) |
| Correct keyboards | `type=email` + `inputmode=email`; codes use `inputmode=numeric` + `autocomplete=one-time-code` (iOS offers codes from Mail); `autocomplete` username / current-password / new-password for iCloud Keychain |
| Show/hide password | A 76×48 button next to each password field (`aria-pressed`, label "Show password" / "Hide password") |
| Password requirements | Live checklist (8+ characters, a letter, a number) |
| Visible validation | Each field has its own error line linked with `aria-describedby`, `aria-invalid` styling, and a form-level error for server responses |
| Loading / disabled during submit | `setBusy`: the submit button shows "Signing in…" etc., is disabled, and has `aria-busy`; repeat taps are ignored |
| Retry after failure | Errors leave the form filled in; the player can tap again. Network failures say so explicitly |
| Accessible labels | Every input has a `<label>`; icon buttons have `aria-label`; avatars and visibility choices are `role=radio` groups |
| No hover / external devices required | Yes; tested with touch events only |

## Driving controls (Phase 1)

Two thumbs: a steering slider bottom-left and GO / BRAKE pedals bottom-right, each tracking its own
finger (Pointer Events with pointer capture). Controls release when the app goes to the background.

## What has been verified where

| Check | Emulated iPad (Chromium, iPad Pro 11 landscape, touch) | Physical iPad |
|---|---|---|
| All flows by touch | Automated (E2E) | Not yet performed |
| Labels, focus advancement, show/hide | Automated (E2E) | Not yet performed |
| Keyboard avoidance | Logic unit-tested; the real on-screen keyboard cannot be emulated | **Not yet performed: must be checked on a device** |
| Safe areas | Layout stays inside the viewport (E2E); real insets cannot be emulated | Not yet performed |
| iOS code autofill from Mail, Keychain | Not testable in emulation | Not yet performed |

See [testing-plan.md](testing-plan.md) for the manual checklist.
