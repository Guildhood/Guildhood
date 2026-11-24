# Phase 2 report: accounts, profiles, and secure Supabase access

Branch `claude/bold-hamilton-yuof1l`, 2026-11-24. Builds on Phase 1 (same engine, transport, and
infrastructure; nothing recreated).

## What changed and why

| Area | Change | Why |
|---|---|---|
| Sign-in | Email + password with required email verification and password recovery replaced Phase 1's passwordless email codes | Spec baseline; nothing was deployed, so no players were affected |
| Emails | Every verification/recovery email has a 6-digit code **and** a link | iOS opens links in Safari, which does not share sign-in with a Home Screen web app |
| Client session | One `AuthManager` with explicit states (`INITIALIZING` … `ERROR`) and separate connectivity | Offline must never look like signed out; one place owns session, cleanup, and expiry |
| Profiles | Username (case-insensitive unique, reserved names), validated display name, preset avatars, bio, visibility, server-tracked onboarding | Spec; resumable onboarding |
| Access control | Profile rows owner-only; others see projections; all edits through validated functions; private settings, restrictions, moderator notes, and an audit log | Spec access matrix; Phase 1 let friends read whole profile rows |
| Game server | Handshake checks eligibility (complete profile, not restricted); connected players re-checked every 60 s | A token proves identity, not eligibility |
| Deletion | `delete-account` Edge Function: password confirmation (rate-limited), cleanup, hard delete, audit; retry-safe | Trusted infrastructure only |
| Client hardening | CSP for builds, redacted structured logs, tokens stripped from URLs | Session tokens live in `localStorage` on the web |
| Docs | authentication, account-deletion, database-schema, security, ipad-input, testing-plan, phase-backlog; architecture and deployment updated | Spec |

Preserved unchanged in behavior: Phase 1 friends, invites, neighborhoods, live instances, driving,
cars, and Marks (they now also respect restrictions and the friend-request privacy setting).

## Feature status

| Feature | Status | Evidence or limitation |
|---|---|---|
| Registration | Working | Auth tests; E2E registration with validation |
| Email verification | Working | Code and link (`?type=signup&token_hash=…`); app open, other tab, fresh launch; used/malformed links refused. On the LAN, links work only at the `.local` address |
| Sign-in | Working | Wrong password, unverified email, offline, success (E2E + Auth tests) |
| Password recovery | Working | Neutral confirmation, code and link, survives relaunch, expired link, new password works and old fails |
| Session restoration | Working | Relaunch (E2E, Auth tests); revalidation on foreground; revoked session → session expired |
| Profile onboarding | Working | 4 steps, resumes after relaunch, collisions and reserved names (E2E + DB) |
| Profile editing | Working | Partial updates, unsaved/saving/saved, failure during network loss is shown as not saved (E2E) |
| Access-control tests | Working | Separate identities, anonymous, privileged functions; mutation-checked |
| Account deletion | Working | Edge Function over HTTP and E2E; data removal/anonymization, retries, no way back in |
| Account restrictions | Working (backend + client screen) | No staff tool or UI yet; managed with service-role functions |
| Additional sign-in providers | Deferred | None configured (no buttons shown) |
| Email change | Deferred | Not offered (deliberately; needs a fully verified flow) |
| Physical iPad testing | Not performed | No iPad or Mac/Xcode simulator available; checklist ready |

## Test results

See [testing-plan.md](testing-plan.md#results-latest-full-run).

## Known limitations

See [phase-backlog.md](phase-backlog.md#outstanding-issues).

## Next phase

See the Phase 3 handoff in [phase-backlog.md](phase-backlog.md#phase-3-handoff-dependency-driven).
