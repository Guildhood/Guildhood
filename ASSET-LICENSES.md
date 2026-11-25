# Asset and license manifest

Guildhood uses only original assets and names. The machine-readable manifest is
[`asset-manifest.json`](asset-manifest.json); `apps/client/test/assets.test.ts` fails the build if any
file under `apps/client/public`, `apps/client/assets-src`, or `supabase/templates` is not listed
there, or if a listed third-party package's installed version or license differs.

## Files

| File | Origin | License |
|---|---|---|
| `apps/client/assets-src/icon.svg` | Original, drawn for Guildhood | Project-owned; no third-party material |
| `apps/client/public/icons/apple-touch-icon.png` (180 px) | Rendered from `icon.svg` by `scripts/make-icons.mjs` | Project-owned |
| `apps/client/public/icons/icon-192.png` | Rendered from `icon.svg` | Project-owned |
| `apps/client/public/icons/icon-512.png` | Rendered from `icon.svg` | Project-owned |
| `apps/client/public/manifest.webmanifest` | Original | Project-owned |
| `supabase/templates/verify_email.html`, `reset_password.html`, `password_changed.html` | Original email text | Project-owned |
| `apps/client/public/privacy.html`, `terms.html`, `legal.css` | Original draft legal text and styles | Project-owned |
| `docs/images/*.png` | Screenshots of Guildhood taken in emulated iPads | Project-owned (documentation only, not shipped) |

## Generated at runtime (no files)

All 3D content is built procedurally from original code: the neighborhood (roads, houses, roofs,
windows, trees, fountain, fence) in `apps/client/src/game/world-view.ts` from the layout data in
`packages/shared/src/world.ts`; the car in `apps/client/src/game/car-mesh.ts`; the garage car drawing
in `apps/client/src/ui/home.ts`; the 12 preset avatar badges in `apps/client/src/ui/avatars.ts`; the
brand mark and controls in CSS.

- **Fonts:** none bundled; the device system font is used.
- **Audio:** none in Phase 1.

## Names

Guildhood (title), Copperleaf Commons (neighborhood), Sprout Hatch (car), and Marks (currency) were
invented for this project. No trademark search has been done.

## Third-party software

| Package | Version | License | Used for |
|---|---|---|---|
| three | 0.187.0 | MIT | 3D rendering (shipped in the client) |
| @supabase/supabase-js | 2.119.2 | MIT | Auth, Data API, Realtime (client and server) |
| ws | 8.23.0 | MIT | WebSocket server |
| jose | 6.2.18 | MIT | Access-token verification |
| vite | 8.3.8 | MIT | Client build and dev server (development) |
| vitest | 5.1.1 | MIT | Tests (development) |
| @playwright/test | 1.63.0 | Apache-2.0 | iPad-emulation tests, icon rendering (development) |
| supabase (CLI) | 3.3.0 | MIT | Local Supabase stack (development) |
| typescript | 7.0.2 | Apache-2.0 | Type checking (development) |
| esbuild | 0.28.2 | MIT | Server bundling (development) |
| tsx | 4.23.15 | MIT | Running TypeScript in development |
| pg | 8.23.1 | MIT | Database tests (development) |

When adding an asset: put the file in place, add an entry to `asset-manifest.json` (origin, author,
license, and source URL if it is not original), and update this table.
