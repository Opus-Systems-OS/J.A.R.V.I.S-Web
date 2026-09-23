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
- **Nothing secret is in this repository.** It is public. The password hash
  and the key live in the droplet's `.env`.
- **No fleet state here.** Sessions, usage and everything Jarvis knows are
  read live from the API.

## Layout

```
server/src/main.rs     CLI: serve (default) | hash-password
server/src/lib.rs      app(): /auth, /bff, static page, security headers
server/src/auth.rs     unlock, cookie, rate limits, CSRF header (x-jarvis: 1)
server/src/bff.rs      allowlisted passthrough to the API (SSE streams through)
server/src/db.rs       SQLite: web_sessions, login_failures
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
ssh -t root@198.199.66.109 "cd /opt/iron-fleet/deploy/droplet && docker compose run --rm jarvis-web hash-password"
# put the printed $argon2id$… in .env as JARVIS_WEB_PASSWORD_HASH (single-quoted),
# then: docker compose up -d jarvis-web
```

## Build order

Do not start a stage before the one above it works live.

1. **Skeleton that deploys.** Lock screen, unlock, `/bff`, and an empty HUD at
   `jarvis.opustower.dev`.
2. **Jarvis himself.** Always-on voice (wake word), Fish speech, a
   minimizable transcript, the model picker, and the sandbox (repos, browser).
3. **Fleet, Systems map, Terminal.**
4. **Usage tab and credit warnings.**
5. **Briefing, sources, reminders.** Gmail, Calendar, YouTube, Whoop, Roblox
   and Buffer.

The plan, with each stage's exit test, is recorded in Iron-Fleet
`docs/centralization-plan.md` ("J.A.R.V.I.S. on the web").
