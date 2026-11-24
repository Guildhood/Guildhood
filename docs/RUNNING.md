# Running Guildhood

Phase 1 runs entirely on one computer on your Wi-Fi. That computer hosts the database and accounts
(local Supabase in Docker), the authoritative game server, and the web client. The iPads only need
Safari and the address the computer prints.

## What you need

| On the host computer | Version |
|---|---|
| macOS, Windows, or Linux, on the **same Wi-Fi** as the iPads | |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/), running | any current |
| [Node.js](https://nodejs.org/) | 22.12 or newer (`node --version`) |
| Git | any |

| On each iPad | |
|---|---|
| iPadOS 16 or newer, Safari | WebGL 2 is required (iPadOS 15+); 16+ is what Phase 1 targets |

Guest Wi-Fi networks often block devices from reaching each other ("client isolation"). Use a
normal home network or a phone hotspot that both iPads and the computer join.

## Two-iPad test: exact steps

```bash
git clone https://github.com/harryxgreenhalgh-prog/Guildhood.git
cd Guildhood
git checkout claude/bold-hamilton-yuof1l   # until the Phase 1 pull request is merged
npm ci
npx supabase start                         # first run downloads images; takes a few minutes
npm run lan
```

`npm run lan` builds the client, starts the game server, and prints something like:

```
 Guildhood is running.
  On this computer: http://localhost:5173
  On your iPads:     http://192.168.1.23:5173
  Sign-in emails:   http://127.0.0.1:54324 (codes are also printed below)
```

1. On each iPad, open **Safari** and go to the "On your iPads" address. Hold the iPad in landscape.
2. Sign in with **any** email address (for example `ada@example.com` on one iPad and
   `bo@example.com` on the other). Nothing is emailed: the 6-digit code appears in the terminal as
   `✉  Sign-in code for ada@example.com: 123456` (and in the mail viewer at
   `http://127.0.0.1:54324` on the computer).
3. Optional, for full screen: Safari **Share → Add to Home Screen**, then open Guildhood from the
   new icon.
4. Follow [IPAD-TEST-PLAN.md](IPAD-TEST-PLAN.md) and record the results there.

If macOS asks whether **node** may accept incoming network connections, choose **Allow**. Only port
5173 needs to be reachable: the web server forwards account, database, Realtime, and game traffic
to services that stay private to the computer.

Stop with **Ctrl+C**. Stop the database with `npx supabase stop` (data is kept) or wipe all players
with `npx supabase db reset` (then run `npm run wait:supabase` before playing or testing).

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Local Supabase is not running` | Start Docker Desktop, then `npx supabase start`. |
| iPad can't open the address | Same Wi-Fi? Not a guest network? Firewall allowed **node**? Try the other printed address. |
| "Can't reach the game server" on the iPad | The terminal running `npm run lan` was stopped; start it again. |
| No sign-in code in the terminal | Open `http://127.0.0.1:54324` on the computer; check the email address you typed. |
| "Please wait a moment before asking for another code" | Codes can be requested about once per second per address. |
| Friend's status takes a few seconds | Realtime pushes updates; a 15-second refresh is the fallback. |

## Development

```bash
npx supabase start
npm run dev          # http://localhost:5173 on this computer, hot reload, same proxies as `lan`
```

Supabase Studio (database browser) is at `http://127.0.0.1:54323` while the stack runs.

## Automated tests

```bash
npx supabase start
npm run env:local        # writes .env.local with the local stack's URLs and keys
npm run wait:supabase    # waits until Auth, email delivery, and Realtime actually work
npm run typecheck
npm test                 # unit + database/access-policy/Realtime + game server integration
npx playwright install chromium   # once, if Playwright's Chromium is not installed
npm run test:e2e         # emulated iPads (touch, iPad viewport) against the real stack
```

The end-to-end suite builds the client and starts the game server itself. To run it against the
Wi-Fi setup instead (a non-localhost address, which is what the iPads use), start `npm run lan` in
one terminal and run `E2E_BASE_URL=http://<printed-ipad-address> npm run test:e2e` in another.

CI (`.github/workflows/ci.yml`) runs all of the above on every push, plus a container build of
the game server.

## Game server configuration

| Variable | Required | Meaning |
|---|---|---|
| `SUPABASE_URL` | yes | Supabase project URL, e.g. `https://abcd.supabase.co` |
| `SUPABASE_SECRET_KEY` | yes | Secret (service-role) key. Server only; never ship it to a client. |
| `PORT` / `HOST` | no | Listen address (default `2567` / `0.0.0.0`). |
| `ALLOWED_ORIGINS` | production | Comma-separated browser origins allowed to connect, e.g. `https://harryxgreenhalgh-prog.github.io` |
| `SUPABASE_JWT_ISSUER` | no | Defaults to `${SUPABASE_URL}/auth/v1`. |
| `SUPABASE_JWKS_URL` | no | Defaults to the project's JWKS endpoint (asymmetric signing keys). |
| `SUPABASE_JWT_SECRET` | no | Only for legacy projects that still sign tokens with HS256. |
| `SERVER_ID` | no | Stable id for this process in the live-instance registry. |
| `LOG_LEVEL` | no | `debug`, `info` (default), `warn`, `error`. |

## Cloud deployment (prepared, not done in Phase 1)

Phase 1 was verified only on the local stack. These steps are the intended production setup; they
have not been run, so treat them as a checklist for a later phase rather than tested instructions.

1. **Supabase Cloud**: create a project, then `npx supabase link --project-ref <ref>` and
   `npx supabase db push` to apply `supabase/migrations`. In Auth settings: set the site URL to the
   GitHub Pages address, configure custom SMTP (the built-in sender allows only a few emails per
   hour), and make sure the Magic Link and Confirm Signup templates show `{{ .Token }}` (copy
   `supabase/templates/sign_in_code.html`; `supabase/config.toml` templates apply to the local stack).
2. **Game server** on Fly.io (one machine; live sessions are in memory):
   `fly launch --no-deploy -c apps/server/fly.toml`, set secrets
   (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ALLOWED_ORIGINS`), then
   `fly deploy . -c apps/server/fly.toml --dockerfile apps/server/Dockerfile`.
3. **Client** on GitHub Pages: repository **Settings → Pages → Source: GitHub Actions**, and add the
   repository variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and
   `VITE_GAME_SERVER_URL` (e.g. `wss://<app>.fly.dev/game`). Pushes to `main` publish
   `https://harryxgreenhalgh-prog.github.io/Guildhood/`. Without those variables the page loads and
   says it is not connected to a game server.
