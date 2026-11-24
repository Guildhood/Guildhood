# Guildhood architecture

```
 iPad Safari (web client)                        Host computer / cloud
 ┌─────────────────────────────┐   wss /game    ┌──────────────────────────────────┐
 │ Three.js renderer           │ ─────────────► │ Game server (Node 22, ws)        │
 │ Touch controls (2 thumbs)   │  inputs only   │  live instances, 30 Hz sim       │
 │ Own-car prediction          │ ◄───────────── │  verifies Supabase tokens (JWKS) │
 │ Remote-car interpolation    │  snapshots     │  loads players from the DB       │
 └──────────────┬──────────────┘                └───────────────┬──────────────────┘
                │ https: Auth, Data API, Realtime                │ secret key: server-only RPCs
                ▼                                                 ▼
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ Supabase: Auth (email + password) · Postgres + RLS · Realtime · Edge Functions   │
 │ profiles · private settings · restrictions · audit · friends · neighborhoods     │
 │ owned cars · Marks ledger · live-instance registry + presence                    │
 │ delete-account function (service role; the only place accounts are deleted)      │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

In development and the Wi-Fi test, the client's web server (Vite) also proxies `/auth/v1`,
`/rest/v1`, `/realtime/v1`, `/functions/v1`, and `/game`, so the iPads talk to a single origin and only port 5173 is
exposed. In production the client would use the Supabase project URL and a `wss://` game server URL.

## Code layout

| Path | What |
|---|---|
| `packages/shared` | Code the server and client both run: vehicle simulation, map layouts, wire protocol and validation, constants. |
| `apps/server` | Authoritative game server (`game-server.ts` connections/joining, `instance.ts` per-instance simulation, `auth.ts` token verification, `backend.ts` database RPCs). |
| `apps/client` | Web client (`src/auth/*` session state machine and email links; `src/game/*` netcode, controls, rendering; `src/ui/*` screens). |
| `supabase/functions/delete-account` | Trusted account deletion (Deno Edge Function). |
| `supabase/migrations` | Versioned schema, access policies, and database functions. |
| `tests/db` | Database, access policy, idempotency, and Realtime tests against the real local stack. |

## Trust boundaries

| Data | Who decides | How clients are prevented from forging it |
|---|---|---|
| Identity | Supabase Auth | Game server verifies the access token signature, issuer, audience, expiry, and role; the user id is the verified `sub`. |
| Car position, speed, collisions | Game server | Clients send only `{seq, steer, throttle, brake}`; values are range-checked; extra fields are discarded; at most one input is simulated per tick; inputs cannot be banked to move faster. |
| Which car a player drives, its paint | Database | Server loads the active car with `server_get_player`; the protocol has no field for it. The active car must be owned (composite foreign key). |
| Balances (Marks) | Database | Only `private.apply_wallet_delta` changes a balance; it is not callable by clients. Clients have no write privilege on wallets or the ledger. |
| Ownership | Database | `player_vehicles` has no client insert/delete privilege; grants are keyed (`grant_key` unique). |
| Friendships, requests, notifications | Database | Written only by `SECURITY DEFINER` functions that use `auth.uid()`; RLS limits reads to the people involved. |
| Who is in which live session | Game server | `session_instances` and `session_presence` are written only through service-role RPCs. |
| Joining a specific session | Game server | Targeted joins (`friend`/`instance`) require a friend in that session, checked against friendships loaded from the database. |

Access policies are deny-by-default: every table has RLS enabled and client roles get only the
column privileges listed in the migrations. Server-only functions are revoked from `anon` and
`authenticated` and granted to `service_role`.

## Persistent world vs. live sessions

- **Neighborhoods** (`public.neighborhoods`) are persistent rows: the world players belong to
  (`neighborhood_memberships`). Phase 1 has one: **Copperleaf Commons** (`map_key copperleaf_v1`).
- **Live session instances** are temporary rooms the game server creates on demand, each a running
  copy of one neighborhood with up to 8 players. Their authoritative state lives in server memory.
  The database keeps only a registry (`session_instances`, heartbeat every 10 s) and presence
  (`session_presence`) so friends can find each other.
- An instance closes 30 s after it empties. Instances whose server stops heartbeating for 45 s are
  closed by any server's reaper, which also clears presence.
- Competitive progression is scoped by neighborhood: ledger entries carry `scope_neighborhood_id`
  (used from Phase 2). Nothing in a live instance is written back as progression in Phase 1.

## Money and rewards: atomic and idempotent

`private.apply_wallet_delta(user, delta, reason, idempotency_key, scope, metadata)`:

1. Locks the wallet row (`FOR UPDATE`), serializing all changes to that wallet.
2. If the idempotency key exists, returns the original entry (`applied = false`), or raises
   `idempotency_key_conflict` if the same key is reused with different contents.
3. Refuses to go below zero (`insufficient_funds`), then updates the balance and appends the ledger
   row in the same transaction. The ledger is append-only (an `UPDATE` trigger raises).

The starter pack (car, 500 Marks, starter-neighborhood membership) is granted in the same
transaction as account creation, every step keyed by `starter_pack:v1:<user>`. Tests run 12–20
concurrent replays and concurrent debits to prove single application and no overdraft.

## Netcode

- Fixed 30 Hz simulation on the server; snapshots every 2 ticks (15 Hz), each carrying the
  recipient's last applied input `ack`.
- The client samples input at 30 Hz, sends it, and simulates it immediately (prediction). On each
  snapshot it resets to the server's state and replays unacknowledged inputs (reconciliation). The
  state is quantized after every step, so a replay from a snapshot is bit-identical on the same
  JavaScript engine; differences between engines (Safari vs. Node math functions) are small and
  smoothed out visually.
- Other cars are drawn 110 ms in the past, blended between snapshots.
- Input queue per player: capped at 6; a sustained backlog is drained by dropping (never
  simulating) the oldest input; with no input the last one repeats for 200 ms, then the car parks.

## Failure and reconnect behavior

| Situation | What happens |
|---|---|
| Wi-Fi drops (socket closes or goes silent) | Client notices within 5 s (no traffic) or immediately (close), abandons the socket, shows "Reconnecting…", disables controls, retries with backoff (0.5 s → 8 s) for up to 60 s. Server notices via WebSocket ping within ~20 s or on close. |
| Back within 20 s | Server still holds the seat; the car was parked meanwhile and is shown faded to others. Reconnect resumes the same seat and car (`resumed: true`). |
| Back after 20 s | Seat was released ("lost connection" to others), presence cleared. Reconnect joins again, preferring the instance where friends are. |
| App backgrounded | Controls released; on return the client checks the connection and reconnects if needed. |
| Access token expires mid-session | Client sends refreshed tokens as Supabase rotates them. If one expires anyway, the server closes with `token_expired`, keeps the seat, and the client reconnects with a fresh token. |
| Same account on a second screen | The newer connection takes over the seat; the older one is told "You started driving on another screen" and stops. |
| Database unavailable | New joins fail closed (`backend_unavailable`, no unverified players admitted). Players already driving continue; registry and presence writes are retried on the next heartbeat. |
| Game server restarts | Clients get `server_shutdown` (or a dropped socket) and reconnect into a new instance. Instances from a crashed server are reaped after 45 s. Persistent data is unaffected. |
| Session full, ended, friend offline, not a friend | Client shows the reason and offers "Drive anyway" (auto-join). No automatic retry. |
| Malformed or flooding client | Closed with `bad_message` / `rate_limited`. |
| Graphics reset by iPadOS (WebGL context lost) | Shows a message to go back and drive again. |

## Accounts and profiles (Phase 2)

- **Authentication:** Supabase Auth, email + password, verification required, password recovery.
  One `AuthManager` in the client owns the session and exposes explicit states; connectivity is a
  separate signal. Details: [authentication.md](authentication.md).
- **Profiles:** created by the signup trigger (single provisioning path) and completed in
  onboarding through validated functions. Rows are owner-only; others see projections. Details:
  [database-schema.md](database-schema.md), [security.md](security.md).
- **Game server handshake:** verifies the token, derives the player id from it, then checks
  eligibility in the database (profile complete, not restricted); re-checks connected players.
- **Deletion:** the `delete-account` Edge Function. Details: [account-deletion.md](account-deletion.md).
- **iPad input:** [ipad-input.md](ipad-input.md).
