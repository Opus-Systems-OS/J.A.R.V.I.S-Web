# J.A.R.V.I.S. — web

Jarvis at **`https://jarvis.opustower.dev`**: a password-locked HUD that greets
you, listens for "Jarvis", answers in his Fish voice, and shows the whole of
Opus Systems OS — the fleet, the architecture (Quest 3, Mac apps, rig), usage
and credits — in one place.

It is a **thin client**, like every other Opus Systems client. Jarvis is a
`jarvis` Managed Agents session reached through the Opus Systems OS API; this
repo adds a password gate and a page.

```
browser ──> jarvis-web (droplet) ──/bff, own osk_ key──> api.opustower.dev ──> control plane ──> Managed Agents
  lock screen, HUD, voice            password gate, static page                                    └─ cloud sandbox
```

## Rules

- **The browser never holds a key.** It holds an unlock cookie (`__Host-jw`,
  HttpOnly, Secure, SameSite=Strict). `jarvis-web` adds this site's own `osk_`
  key on the way to the API.
- **`/bff` is an allowlist.** Only `me`, `fleet`, `rig`, `sessions`, `usage`,
  `voice`, `ops`, `sources`, `briefing` and `clients` are reachable. Key
  management and pairing never are, whatever scopes the `web` key has.
- **Every load starts locked.** Each unlock posts the passphrase, and that
  click is also the user gesture that lets Jarvis use the mic and speaker.
- **Brute force is bounded before hashing:** 5 failures per IP per 15 min,
  30 per hour from everyone (Argon2id, constant-time verify).
- **Markup only through `html`.** The CSP enforces Trusted Types
  (`require-trusted-types-for 'script'; trusted-types jarvis`): the page's
  one policy lives in `web/src/html.ts` and only accepts what its `html`
  template built, escaping every value. Text from the API or the agent goes
  in with `textContent`. Never assign a string to `innerHTML`.
- **Nothing from another site.** `/auth`, `/web` and `/bff` refuse any
  request a browser marks `Sec-Fetch-Site: cross-site` or `same-site`, reads
  included, on top of the cookie's SameSite=Strict and the `x-jarvis` header.
- **An agent's file never renders here.** `/bff/v1/files/*/content` always
  goes out as an attachment under `Content-Security-Policy: sandbox`.
- **The honeypot bans until you lift it.** Trap paths (`/.env`, `/wp-*`,
  `*.php`, `/admin`, `/bff/v1/keys`, …), the canary passphrase in the fake
  `/.env`, and the lock form's hidden honey field all ban the address. A
  browser holding a valid unlock is never banned (and gets in even from a
  banned address). Only public addresses are banned: on the droplet every
  IPv6 visitor arrives as Docker's gateway `172.18.0.1`. Unban from **Systems → Defenses** or
  `docker compose exec jarvis-web jarvis-web unban <ip>`.
  Jarvis mentions any new bans in the greeting when you unlock.
- **Sessions:** 12 h at most, and 2 h unused locks them (`SESSION_IDLE_MINUTES`).
  **Lock all** in the top bar ends every browser unlocked as you.
- **Nothing secret is in this repository.** It is public. The password hash
  lives in the droplet's `.env`; each `osk_` key in its own 0400 Docker
  secret file (`WEB_API_KEY_FILE`), held in memory as a zeroizing secret.
- **Supply chain:** CI pins every action to a commit SHA, gives
  `packages: write` only to the image job, and fails on `cargo audit` or
  `npm audit --audit-level=high`.
- **No fleet state here.** Sessions, usage and everything Jarvis knows are
  read live from the API.

## Layout

```
server/src/main.rs     CLI: serve (default) | hash-password | bans | unban <ip>
server/src/lib.rs      app(): /auth, /bff, static page, security headers (CSP + Trusted Types)
server/src/auth.rs     unlock, cookie, idle lock, rate limits, CSRF header, Sec-Fetch-Site
server/src/bff.rs      allowlisted passthrough to the API (SSE streams through)
server/src/honey.rs    honeypot: trap paths, bait .env, canary, bans
server/src/db.rs       SQLite: web_sessions, login_failures, bans, trap_hits, …
web/src/html.ts        the one Trusted Types policy + the escaping `html` template
server/src/mic.rs      the one-HUD-listens lease (memory only)
server/tests/web.rs    contract tests through the real router, API stubbed
web/                   Vite + TypeScript page (no framework), self-hosted fonts
Dockerfile             page build → server build → debian-slim
```

Deployment config (compose service, Caddy host) lives in
**Iron-Fleet/deploy/droplet**.

## Local development

```sh
cargo test                                   # server
cd web && npm ci && npm run build            # page → web/dist

# a throwaway local passphrase (never the real one)
echo "local-dev-passphrase" | cargo run -q -- hash-password
JARVIS_WEB_PASSWORD_HASH='$argon2id$…' \
OPUS_API_URL=https://api.opustower.dev \
WEB_API_KEY="$(cat ~/.config/opus-systems/api-key)" \
STATIC_DIR=web/dist cargo run -- serve       # http://localhost:8200

cd web && npm run dev                        # hot reload on :5173, proxied to :8200
```

## Deploy

Merge to `main`, and CI pushes `ghcr.io/opus-systems-os/jarvis-web`. Then, on
the droplet:

```sh
ssh root@198.199.66.109 /opt/iron-fleet/deploy/droplet/deploy.sh
```

Setting or changing the passphrase (you type it; it is never echoed or
stored, only its hash):

```sh
ssh -t root@198.199.66.109 "cd /opt/iron-fleet/deploy/droplet && docker compose run --rm jarvis-web jarvis-web hash-password"
# put the printed $argon2id$… in .env as JARVIS_WEB_PASSWORD_HASH (single-quoted),
# then: docker compose up -d jarvis-web
```

### Profiles

The lock screen asks who you are, then that profile's passphrase.

- **Mr. Walker** is the owner: `JARVIS_WEB_PASSWORD_HASH` + `WEB_API_KEY_FILE`, every panel.
- **Mr. Powers** appears when both `JARVIS_WEB_POWERS_PASSWORD_HASH` and
  `WEB_POWERS_API_KEY_FILE` are set (the same `hash-password` step; he types his own).
  - Least privilege: his own conversation on the `jarvis-powers` agent, his own
    reminders, visits and microphone lease, and the Fleet, Usage and Terminal tabs.
  - No Systems, Jobs, briefing or credit ledger.
  - His key is limited to `jarvis-powers` by the API (`opus-api keys create …
    --agents jarvis-powers`), so it cannot reach anyone else's sessions whatever
    the page asks.

## Build order

Do not start a stage before the one above it works live.

1. **Skeleton that deploys.** Lock screen, unlock, `/bff`, and an empty HUD at
   `jarvis.opustower.dev`. *Live 2026-09-23.*
2. **Jarvis himself.** Always-on voice (wake word), Fish speech, a
   minimizable transcript, the model picker, and the sandbox (repos, browser).
   *Live 2026-09-23.* Voice uses Chrome's recognition, or "cloud ears" (Fish
   speech-to-text) in Arc, Safari and Firefox.
3. **Fleet, Systems map, Terminal.** One HUD holds the mic at a time
   (`/web/mic`).
4. **Usage tab and credit warnings.**
5. **Briefing, sources, reminders.** Weather, Gmail, Calendar, YouTube, WHOOP
   and Buffer (API `/v1/briefing`); reminders and the last visit live in
   `jarvis-web`. Roblox is parked.

The plan, with each stage's exit test, is recorded in Iron-Fleet
`docs/centralization-plan.md` ("J.A.R.V.I.S. on the web").
