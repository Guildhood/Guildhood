# Guildhood

An original multiplayer neighborhood car-and-Guild game for iPad, played in Safari. Players sign
in with an email code, add friends by friend code, and drive together through a small shared
neighborhood on an authoritative game server. Guilds, racing, the shop, and territory arrive in
later phases.

![Two players driving together in Copperleaf Commons, seen from the first iPad](docs/images/two-ipads-driver-a.png)

**Current phase: 1, "Join and drive."** See [docs/PHASE-1.md](docs/PHASE-1.md) for what works,
test results, known limitations, and what comes next.

## Quick start (two iPads on your Wi-Fi)

Needs Docker Desktop and Node.js 22.12+ on one computer.

```bash
npm ci
npx supabase start
npm run lan
```

Open the printed `http://<computer>:5173` address on each iPad. Full instructions:
[docs/RUNNING.md](docs/RUNNING.md). Manual test script: [docs/IPAD-TEST-PLAN.md](docs/IPAD-TEST-PLAN.md).

## Documentation

- [docs/PHASE-1.md](docs/PHASE-1.md): Phase 1 report (feature status, tests, limitations, next task)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): engine, transport, server authority, data model, reconnect behavior
- [docs/RUNNING.md](docs/RUNNING.md): run, test, and deploy instructions
- [docs/IPAD-TEST-PLAN.md](docs/IPAD-TEST-PLAN.md): two-iPad manual test
- [ASSET-LICENSES.md](ASSET-LICENSES.md): asset and license manifest

## Stack

TypeScript everywhere. Client: Vite + Three.js, touch-first, landscape, safe-area aware. Game
server: Node 22 + `ws`, fixed 30 Hz authoritative simulation shared with client-side prediction.
Backend: Supabase (Auth, Postgres with row level security, Realtime). Hosting target: GitHub Pages
for the client, a container host (Fly.io config included) for the game server, Supabase Cloud.
