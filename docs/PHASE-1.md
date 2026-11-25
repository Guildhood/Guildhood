# Phase 1 report: "Join and drive"

Branch `claude/bold-hamilton-yuof1l`, 2026-11-23.

Phase 1 goal: sign in, a profile, friends, one small persistent neighborhood, live session
instances, driving together under server authority, a starter car and wallet granted atomically
and idempotently, reconnect, and Realtime invites. Racing, earning, the shop, Guilds, and territory
are later phases. The world is not expanded until joining friends, driving together, racing,
earning money, and preserving ownership work reliably on iPad.

## Stack as built

| Layer | Choice | Notes |
|---|---|---|
| Client | TypeScript, Vite 8, Three.js r187; iPad Safari; GitHub Pages as the hosting target | Touch-only, landscape, safe areas. No mouse, keyboard, or controller needed. |
| Transport | JSON over WebSocket, a small custom protocol on `ws` | Changed from the Colyseus I first proposed. The netcode needs per-player input acknowledgements for reconciliation and exact control over holding seats during reconnects. A ~150-line protocol with strict validation was simpler to make correct and to test than adapting a framework. |
| Game server | One Node 22 process; Docker image; Fly.io config | Authoritative 30 Hz simulation shared with client prediction (`packages/shared`). |
| Backend | Supabase: Auth (email code), Postgres with row level security, Realtime | Local stack (Supabase CLI) for Phase 1. |

Details: [architecture.md](architecture.md).

## Feature status

"Working" means: implemented, and verified by automated tests against the real local Supabase
stack and the real game server, with the client in emulated iPads. **No feature has been verified
on physical iPads yet** (last column).

| Feature | Status | Evidence | Physical iPad |
|---|---|---|---|
| Email one-time-code sign-in, persistent session | Working | `tests/db/api.test.ts`, E2E sign-in + reload | Not yet tested |
| Profile: display name (validated), friend code | Working | `accounts.test.ts`, E2E rename persists | Not yet tested |
| Starter pack at signup: Sprout Hatch, 500 Marks, Copperleaf membership, atomic and idempotent | Working | Signup trigger; 12 concurrent replays grant once | Not yet tested |
| Marks wallet: append-only ledger, idempotency keys, no overdraft | Working (only the starter grant uses it in Phase 1) | `wallet.test.ts`: 20 concurrent replays apply once; concurrent debits never overdraw | n/a |
| Car ownership and paint color | Working | RLS write tests, composite-key ownership check, E2E repaint persists | Not yet tested |
| Friends: add by code, auto-accept crossing requests, accept/decline/cancel | Working | `social.test.ts`, two-iPad E2E | Not yet tested |
| Remove friend | Partial: database function and tests, no button in the app | `social.test.ts` | n/a |
| Realtime notifications (friend request, accepted, session invite) | Working | Delivered only to the recipient (`api.test.ts`); E2E toast without reload | Not yet tested |
| Friends' live status (online, which neighborhood, players) | Working | Realtime presence updates plus 15 s polling fallback; E2E | Not yet tested |
| Session invites | Working | `sessions.test.ts` (friends only, throttled), E2E invite then join | Not yet tested |
| Persistent neighborhood (Copperleaf Commons) separate from live instances | Working | Separate tables and lifecycle; registry tests | n/a |
| Live instances: create on demand, 8 seats, heartbeat, close when empty, reap crashed servers | Working (single server process) | `sessions.test.ts`, `server.test.ts` | n/a |
| Join: auto (prefers friends), join friend, join instance (friend required), capacity | Working | `server.test.ts`, E2E | Not yet tested |
| Server-authoritative driving (30 Hz), input validation, anti-speed-hack | Working | `server.test.ts` (client state ignored, input flood gives no speed), `instance.test.ts` | Not yet tested |
| Own-car prediction and reconciliation; smooth remote cars | Working | `prediction.test.ts`, `interpolation.test.ts`, E2E | Feel not yet tested |
| Car-to-car and car-to-world collisions | Working (server); not predicted on the client | `sim.test.ts`, momentum test | Not yet tested |
| Two-thumb touch controls, landscape lock prompt, safe-area layout | Working in emulation | E2E multi-touch, sizes ≥ 44 pt, rotate prompt | Not yet tested |
| Reconnect: 20 s seat hold, resume same car, silent-drop detection, token refresh, takeover by a second screen | Working | `server.test.ts`, E2E network drop and silent drop | Not yet tested |
| Fail closed when the database is down (no unverified joins; current players keep driving) | Working | `server.test.ts` outage test | n/a |
| Graceful server shutdown and restart | Working | `server.test.ts` | Not yet tested |
| Wi-Fi play from one computer (`npm run lan`, single port) | Working in emulation | Full E2E suite passes against a non-localhost address (insecure context, like Safari over Wi-Fi) | Not yet tested |
| Home Screen app (manifest, icons, full screen) | Partial | Manifest and meta tags present; over plain `http` there is no service worker or offline mode | Not yet tested |
| Game server container | Working | Built by CI on GitHub; production runtime verified locally | n/a |
| GitHub Pages deployment of the client | Partial: workflow ready, not deployed | Pages is not enabled and there is no cloud backend; a Pages build says it is not connected | n/a |
| Cloud deployment (Supabase Cloud, Fly.io) | Deferred | Config and steps prepared in [deployment.md](deployment.md), not run | n/a |
| Racing, race results | Deferred (Phase 2) | | |
| Earning Marks | Deferred (Phase 2) | | |
| Shop and purchases | Deferred (Phase 3) | | |
| Guilds | Deferred (Phase 4) | | |
| Territory | Deferred (Phase 5) | | |
| Audio | Deferred | | |

**Mocked:** nothing in the shipped app. In tests only: a database outage is simulated by a wrapper
that makes backend calls fail; iPads are emulated by Chromium; sign-in emails go to the local mail
catcher instead of real inboxes.

## Automated test results

Final run, clean database. Environment: Supabase CLI 3.3.0 local stack (Postgres 17, Auth, Data
API, Realtime, Mailpit), Node 22.23, Playwright 1.63 with Chromium.

| Suite | Command | Result |
|---|---|---|
| Typecheck (all packages) | `npm run typecheck` | pass |
| Shared simulation, map, protocol | `vitest --project shared` | 31 / 31 pass |
| Client logic, wording guard, asset manifest | `vitest --project client-unit` | 10 / 10 pass |
| Database: access policies, idempotency, concurrency, Realtime, catalog parity | `npm run test:db` | 39 / 39 pass |
| Game server: unit + integration with real clients and real Supabase | `npm run test:server` | 29 / 29 pass |
| Emulated iPads end to end (localhost) | `npm run test:e2e` | 9 / 9 pass |
| Emulated iPads end to end via a non-localhost address (Wi-Fi mode) | `E2E_BASE_URL=… npm run test:e2e` | 9 / 9 pass |

**118 automated tests**, plus the 9 end-to-end tests re-run in Wi-Fi mode. The access-policy tests
were mutation-checked: deliberately opening an update hole on wallets and a read hole on profiles
made them fail. The "Guild, not gang" guard was checked the same way.

**On GitHub Actions** (run #2, commit `cac5431`), typecheck, unit, database (39/39), and game
server (29/29) tests passed, and so did the container build. The end-to-end step never started
there: the preview web server bound to `localhost`, which resolves to IPv6 on GitHub's runners,
so Playwright couldn't reach it at `127.0.0.1`. The fix (bind to `127.0.0.1`) passes 9/9 locally
but has not yet run on GitHub.

### Bugs the tests found (all fixed)

1. A race between "set presence" and "close instance" could leave a player shown in a closed
   session. Fixed with row locking and statement ordering in the migration.
2. A disconnected player's car braked to a stop, then reversed forever (brake on a stopped car
   means reverse). Fixed with a server-only `park` input.
3. A client that stopped sending input (Safari backgrounded with the socket open) kept driving at
   full throttle. Now the car parks after 200 ms without input.
4. A one-off burst of inputs left a permanent latency backlog. The server now drains it by dropping
   old inputs, which gives no speed advantage.
5. A dead network left the socket stuck "closing" with no close event, freezing the player in a
   fake "live" state. The client now abandons silent sockets and reconnects.
6. Background refreshes wiped a half-typed friend code and closed open sheets. The home screen now
   only rebuilds read-only sections.
7. A CSS class collision made the Drive button cover the whole home screen.

## iPad test results

| Environment | Result |
|---|---|
| Emulated iPad Pro 11 in landscape (Chromium, touch events, 1194×834), `localhost` | 9 / 9 pass: sign-in, persistence, typed input survives refreshes, two-finger driving, network drop, silent Wi-Fi drop, layout and rotate prompt, two iPads friending over Realtime and driving together, invite then join |
| Same suite through a non-localhost address, the way iPads on Wi-Fi reach the computer (`isSecureContext` false: no Web Locks, no WebCrypto) | 9 / 9 pass |
| **Physical iPads, two devices** | **Not run.** I have no access to iPads. Script and results table: [IPAD-TEST-PLAN.md](IPAD-TEST-PLAN.md). |

What emulation cannot tell us: Safari/WebKit rendering speed and frame rate on your iPads, WebKit's
touch and gesture handling (zoom, magnifier, callouts), real safe-area insets, Wi-Fi conditions,
iPadOS backgrounding behavior, and Add to Home Screen.

## Known limitations

- **Not yet run on physical iPads or Safari.** WebKit was not available in the build environment.
- **Local only.** Nothing is deployed. The GitHub Pages workflow builds a page that reports it is
  not connected until Pages is enabled and cloud services exist. Over Wi-Fi the game uses plain
  `http`/`ws`, without TLS.
- **One game-server process.** Live sessions live in memory: a restart ends them (players reconnect
  into new sessions; persistent data is unaffected). There is no multi-server routing yet, and the
  "one seat per player" rule is enforced per process.
- **Email in production** needs custom SMTP (Supabase's built-in sender is limited to a few emails
  per hour), and the sign-in email template must be set in the project dashboard.
- **Netcode:** JSON snapshots (fine for 8 players, not bandwidth-optimal). Car-to-car contacts are
  corrected, not predicted, so a bump can show a small correction. Safari and Node can differ in the
  last digits of math functions; this is corrected continuously.
- **Abuse controls are basic:** server authority stops teleporting and speed hacks, but there is no
  bot detection. Friend-code guessing is limited only by the size of the code space and a cap of 50
  pending requests. Display names are format-checked, not profanity-filtered.
- **Realtime outages:** friend status falls back to 15 s polling. Invites sent during an outage
  appear only if the home screen is opened within two minutes.
- After `npx supabase db reset`, Realtime needs a few seconds to a minute to come back
  (`npm run wait:supabase` waits for it).
- No audio, no tilt steering, no VoiceOver pass yet; online status uses a colored dot plus text.
- Account deletion cascades in the database, but there is no button for it. Same for removing a
  friend.
- Sign-in is email only; Sign in with Apple needs a native wrapper (later).
- Names (Guildhood, Copperleaf Commons, Sprout Hatch, Marks) are original but not
  trademark-searched.

## Next dependency-driven task

1. **You: run the two-iPad test** ([IPAD-TEST-PLAN.md](IPAD-TEST-PLAN.md)) and send me the results.
   Driving, joining, and reconnecting on real Safari are the foundation everything else builds on,
   so any iPad-specific problem gets fixed before new features.
2. **Engineering, first task of Phase 2: a server-run checkpoint race in Copperleaf Commons with
   atomic, idempotent settlement.** Earning money depends on trusted race results, and race results
   depend on the server-authoritative driving and live instances built in Phase 1.
   - Migration: neighborhood-scoped `races` (checkpoints referencing the shared map), `race_runs`
     (per live instance), `race_results` (unique per run and player), and a service-role-only
     `server_settle_race(run_id, results)` that records results and pays Marks through
     `apply_wallet_delta` (key `race:<run>:<player>`, scoped to the neighborhood) in one transaction,
     so replays and retries never double-pay.
   - Game server: race lifecycle inside a live instance (opt-in, countdown, server-validated
     checkpoints, finish order, timeouts, and what a disconnect means for a racer).
   - Client: start-line prompt, countdown, checkpoint arrow, results screen.
   - Tests: settlement idempotency under concurrency, no reward for skipped checkpoints, reconnect
     during a race, and a two-iPad race.
