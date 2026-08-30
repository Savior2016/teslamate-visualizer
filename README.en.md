# TESLA Home

[中文](README.md) | English

An all-in-one self-hosted solution for Tesla vehicle data: **TeslaMate** (data collection) + **TESLA Home dashboard** (visualization), orchestrated by a single `docker compose`.

The dashboard reads TeslaMate's PostgreSQL database directly: FastAPI + psycopg3 backend, ECharts + Leaflet frontend, read-only.

## Features

**Dashboard modules**
- Vehicle overview: top-view car SVG, per-charge-cycle energy ring (remaining / driving / sentry / parked climate / parked drain / not-charged), cycle efficiency bar, tire pressure for all four wheels, in-cabin temperature sparkline; left column stats include rated range, monthly/weekly mileage and a compact **battery health** module (baseline = highest-ever full-pack estimate, current = latest charge's estimate)
- Charging sessions: one card per charge; editable cost / metered total kWh / charger name, auto-computed unit price and per-km cost
- Charger statistics: per-location aggregation of sessions / energy / losses / cost
- Battery activity timeline: dual-lane segments for driving / charging / sentry / parked drain
- Activity events, sentry timeline & drain curve, efficiency trend, tire pressure trend, in/out-cabin temperature, daily distance, charging log
- Trip map: day-grouped collapsible drive list, click to zoom into a route
- Battery % ⇄ kWh ⇄ range km three-way toggle; mobile-friendly; dark/light themes

**All-in-one deployment**
- Single compose stack: TeslaMate + PostgreSQL + MQTT + dashboard (optional Grafana, Caddy HTTPS)
- `setup.sh` one-step bootstrap (auto-generated secrets and dashboard account)
- In-app **Account Center**: self-service Tesla authorization (step-by-step visual guide), password change, account management
- Versioning via git tags; the dashboard image is built locally from source (amd64/arm64)

## Quick start (fresh machine)

Prerequisite: [Docker](https://docs.docker.com/engine/install/) with the Compose v2 plugin.

```bash
git clone https://github.com/Savior2016/teslamate-visualizer.git
cd teslamate-visualizer
./setup.sh
```

The script will: generate a random encryption key and database password → ask for a dashboard username/password → (optionally) configure a domain for automatic HTTPS → build the image and start everything.

Then:

1. Open `http://<server-IP>:8080` and log in with the account you just set
2. Click "**Account Center**" (个人中心) in the top bar and follow the step-by-step guide to authorize your **Tesla account** (see below)
3. Data starts accumulating automatically once authorized

### Tesla account authorization (self-service Tesla credentials)

TeslaMate connects to your vehicle via official Tesla API tokens. The Account Center shows live status for each step:

1. **Get tokens**: on iPhone/Mac use the App Store app "Auth app for Tesla"; on Windows/macOS/Linux use [Tesla Auth](https://github.com/adriankumpf/tesla_auth). Sign in with your Tesla account and copy the Access Token and Refresh Token
2. **Paste tokens**: open the TeslaMate web UI at `http://<server-IP>:4000` and paste both tokens on the sign-in page
   - On a public server, port 4000 only listens on loopback by default — create a tunnel first: `ssh -L 4000:127.0.0.1:4000 user@<server>`, then visit `http://localhost:4000`
   - On a home server/LAN: set `TESLAMATE_BIND=0.0.0.0` in `.env`, then `docker compose up -d`
3. The Account Center guide lights up automatically: authorized ✓ → vehicle detected ✓ → data syncing ✓

Tokens are stored encrypted (with `ENCRYPTION_KEY`) in the database on your own server — nothing passes through third parties.

### Change dashboard password / manage accounts

Top bar → "**Account Center**" → change password / add / remove accounts. Takes effect immediately, no config edits, no restart.

> Accounts live in `data/users.json` (pbkdf2_sha256 hashes). `PANEL_USERS` in `.env` only seeds the first boot; editing it later has no effect.

## Manual deployment (without setup.sh)

```bash
cp .env.example .env
# Edit .env: TESLAMATE_ENCRYPTION_KEY (openssl rand -hex 32),
#            POSTGRES_PASSWORD, PANEL_USERS
docker compose up -d --build
```

Optional services (profiles):

```bash
docker compose --profile grafana up -d   # Official TeslaMate Grafana dashboards (127.0.0.1:3000)
docker compose --profile https up -d     # Caddy automatic HTTPS; copy Caddyfile.example to Caddyfile and set your domain first
```

### HTTPS

1. Point your domain at the server; open ports 80 and 443 in the firewall/security group
2. `cp Caddyfile.example Caddyfile`, replace `tesla.example.com` with your domain
3. `docker compose --profile https up -d` — Caddy issues and renews the Let's Encrypt certificate automatically
4. After issuance, optionally set `VISUALIZER_BIND=127.0.0.1` in `.env` (stops exposing 8080 directly), then `docker compose --profile https up -d`

Authentication is handled by the dashboard app layer (independent of Caddy); password changes are self-service in the Account Center.

## Upgrading

```bash
git pull --tags                      # dashboard: pull latest code / version tags
docker compose up -d --build         # rebuild and rolling-restart the dashboard
# TeslaMate: bump TESLAMATE_VERSION in .env (back up the database first), then
docker compose pull teslamate && docker compose up -d
```

## Configuration (.env)

| Variable | Description |
|---|---|
| `TESLAMATE_ENCRYPTION_KEY` | Encryption key for Tesla API tokens. **Do not change after first authorization** — stored tokens become undecryptable |
| `POSTGRES_PASSWORD` | Database password |
| `PANEL_USERS` | Initial dashboard account `user:pass` (seeded on first boot only; manage via Account Center afterwards) |
| `TZ` | Display timezone, default `Asia/Shanghai` |
| `VISUALIZER_BIND` | Dashboard bind address, default `0.0.0.0` (app-layer auth enforced) |
| `TESLAMATE_BIND` | TeslaMate web UI bind address, default `127.0.0.1` |
| `GRAFANA_BIND` | Grafana bind address, default `127.0.0.1` |
| `TESLAMATE_VERSION` etc. | Image versions/tags |

## Data & backup

| Data | Location |
|---|---|
| Vehicle telemetry database | docker volume `teslamate_teslamate-db` |
| Dashboard accounts / charging costs / charger info / tile cache | `./data/` |
| TeslaMate import directory | `./import/` |
| HTTPS certificates | docker volume `teslamate-visualizer_caddy_data` |

Backup: `docker exec tesla-home-database-1 pg_dump -U teslamate teslamate | gzip > backup.sql.gz`, plus the `data/` directory.

## Migrating from the legacy split deployment (separate teslamate + teslamate-visualizer projects)

The all-in-one stack pins the same docker volume names as the legacy deployment, so data carries over untouched:

1. Note `ENCRYPTION_KEY` and `DATABASE_PASS` from the old `teslamate/docker-compose.yml`, and `VISUALIZER_USERS` from the old dashboard project
2. Prepare `.env` per manual deployment above, reusing the **same ENCRYPTION_KEY and database password** (otherwise stored tokens can't be decrypted and DB auth fails)
3. Stop the old projects: `docker compose -f old-teslamate-dir/docker-compose.yml down`, same for the old dashboard project
4. Start the new stack: `docker compose up -d --build` (copy the old dashboard `data/` directory over to keep charging cost records)
5. If you use Caddy: authentication now lives in the app layer — regenerate Caddyfile from `Caddyfile.example` (no more basic_auth)

## Deployment guide for AI agents

> This section targets AI coding/ops assistants (Claude Code, Cursor, etc.) asked by a user to "deploy this project for me". Following it should require zero human intervention until the Tesla sign-in step.

**Architecture**: one compose project (name `tesla-home`). `visualizer` (the dashboard, built from this repo) reads TeslaMate's PostgreSQL (`database`) read-only; `teslamate` collects and writes data; `mosquitto` is the MQTT broker TeslaMate needs; `grafana`/`caddy` are optional profiles. Containers talk via internal DNS aliases (`database`, `mosquitto`) — never substitute localhost.

**Steps**:

1. Verify `docker` and `docker compose version` work; if missing, install Docker from the official repos (avoid the snap build)
2. After `git clone`, prefer `./setup.sh` (interactive). If the user is not present, go manual: `cp .env.example .env`, generate `TESLAMATE_ENCRYPTION_KEY` with `openssl rand -hex 32` and `POSTGRES_PASSWORD` with `openssl rand -hex 16`, set `PANEL_USERS` to `username:random-password` and **tell the user the password once in your final reply**
3. `docker compose up -d --build`; confirm 4 containers are Up via `docker compose ps` (database shows healthy)
4. Verify: `curl http://127.0.0.1:8080/api/health` returns `{"status":"ok"}`; `curl -u user:pass http://<IP>:8080/api/overview` returns JSON (empty vehicle fields are normal before Tesla authorization)
5. Walk the user through Tesla authorization: the Account Center has a live step guide; for accessing the TeslaMate UI on a remote server, suggest the `ssh -L 4000:127.0.0.1:4000` tunnel, or — with the user's consent — set `TESLAMATE_BIND=0.0.0.0` in `.env`
6. If the user has a domain: `cp Caddyfile.example Caddyfile`, replace the domain, `docker compose --profile https up -d`, make sure ports 80/443 are open

**Hard constraints (pitfalls)**:

- Never change `TESLAMATE_ENCRYPTION_KEY` after a Tesla token has been saved — stored tokens become undecryptable and re-authorization is required
- Tesla tokens live in the `private.tokens` table (note the `private` schema); query it to check authorization status
- `.env`, `Caddyfile`, `data/`, `import/` are gitignored — **never commit them under any circumstance**; use `CHANGE_ME` placeholders in docs/examples
- Do not expose port 4000 (TeslaMate UI, unauthenticated) to the public internet
- Tables are created by TeslaMate on first boot; 503s from dashboard APIs in the first seconds of a fresh deploy are normal and self-heal
- Volume names like `teslamate_teslamate-db` are pinned on purpose (legacy-deployment compatibility) — do not rename them

**Verification checklist** (run each after deployment):

```bash
docker compose ps                                  # all Up, database healthy
curl -s http://127.0.0.1:8080/api/health           # {"status":"ok"}
curl -s -u 'user:pass' http://127.0.0.1:8080/api/account/status | python3 -m json.tool
# steps.authorized=false is normal before Tesla authorization; it should turn true afterwards
```

## Development

```bash
# After editing source under app/, rebuild and restart the dashboard:
docker compose up -d --build visualizer

# Release a version (commit messages in English):
git tag v1.x.y && git push origin v1.x.y
```

## Implementation notes

- Sentry inference: Tesla does not report sentry mode directly; the dashboard infers it from "parked & awake ≥30 min + climate off + not inside a drive/charge interval"
- Self-calibrating energy model: kWh per ideal-range km is calibrated from charging history; parked drain uses "energy added ÷ displayed % gain" (includes charging losses)
- Battery health: each charge estimates full-pack capacity as "energy added ÷ % gain × 100" (filters: gain ≥10%, estimate within 30–150 kWh); baseline = highest-ever estimate, current = latest estimate
- Map tiles are proxied same-origin by the app (upstream: official OSM tiles, disk-cached), so maps load even on restrictive mobile networks
