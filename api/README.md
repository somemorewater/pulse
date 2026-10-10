# Pulse API gateway

Node.js (Fastify) gateway in front of the Go odds engine. It owns HTTP,
validation and reads; **all odds calculation and fairness derivation live
in Go** (`../internal/*`). This service never computes odds.

Flow: `client → Node :3000 → Go :8081 → PostgreSQL + Redis`.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service + dependency status (`engine`, `postgres`, `redis`) |
| `POST` | `/api/matches` | Create a match |
| `GET` | `/api/matches` | List matches (newest 50) |
| `GET` | `/api/matches/:id` | Match + score + minute + status + odds + sequence |
| `GET` | `/api/matches/:id/odds` | Latest odds |
| `GET` | `/api/matches/:id/odds/history` | Persisted odds snapshots, oldest-first |
| `GET` | `/api/matches/:id/events` | Event history (`?limit=`, max 1000) |
| `POST` | `/api/matches/:id/events` | Submit a live event (forwarded to Go) |
| `GET` | `/api/matches/:id/fairness` | Stored commitments (no seed) |
| `POST` | `/api/matches/:id/fairness/verify` | Recompute + check a fairness value |
| `POST` | `/api/matches/:id/fairness/reveal` | Demo-only reveal stage: returns the seed |

Errors are always `{ "error": { "code": "...", "message": "..." } }` with
`400` invalid request, `404` not found, `409` duplicate event,
`422` invalid transition, `500` internal, `503` engine/infra unavailable.
Stacks and connection strings are never returned.

## Examples

```bash
# Create
curl -s -X POST localhost:3000/api/matches \
  -H 'content-type: application/json' \
  -d '{"home_team":"Arsenal","away_team":"Chelsea"}'
# → 201 { "match": { "match_id": "m_…", "status": "scheduled", … }, "commitment": "…" }

# Start + goal
curl -s -X POST localhost:3000/api/matches/m_…/events \
  -H 'content-type: application/json' \
  -d '{"id":"evt_1","type":"match_start","sequence":1}'
curl -s -X POST localhost:3000/api/matches/m_…/events \
  -H 'content-type: application/json' \
  -d '{"id":"evt_2","type":"goal_home","sequence":2,"payload":{"minute":23}}'
# → 200 { "state": {…}, "odds": {…}, "fairness": […], "sequence": 2, "processing_latency_us": N }

# Reads
curl -s localhost:3000/api/matches               # list (newest first)
curl -s localhost:3000/api/matches/m_…            # match + odds + sequence
curl -s localhost:3000/api/matches/m_…/events     # history
curl -s localhost:3000/api/matches/m_…/fairness   # commitments

# Reveal (demo) then verify
curl -s -X POST localhost:3000/api/matches/m_…/fairness/reveal
curl -s -X POST localhost:3000/api/matches/m_…/fairness/verify \
  -H 'content-type: application/json' \
  -d '{"sequence":2,"market":"1","seed":"<hex>"}'
# → { "valid": true, "algorithm": "HMAC-SHA256", "algorithm_version": "pf-v1" }
```

The verify endpoint recomputes `HMAC-SHA256(seed, match:seq:market)` in Go
and compares it against durable history — it never just echoes `true`.
The seed is only exposed via the explicit reveal call, never in normal reads.

## WebSocket live updates

```
GET /ws/matches/:id   (WebSocket upgrade)
```

No polling: the API subscribes to the engine's Redis channel
`pulse:match:{id}:updates` (one subscription per match, shared by all
sockets on that match) and fans updates out. On connect the server first
sends the current snapshot, then streams updates:

```jsonc
// snapshot on connect
{ "v": 1, "type": "snapshot", "match_id": "m_…", "sequence": 12,
  "state": { "home_score": 1, "away_score": 0, "minute": 63, "status": "live", … },
  "odds": { "home_win": 1.42, "draw": 4.80, "away_win": 9.20, … },
  "timestamp": "…" }
// per processed event
{ "v": 1, "type": "match_update", "match_id": "m_…", "sequence": 13,
  "event_type": "goal_home",
  "state": { … }, "odds": { "home_win": 1.42, "draw": 4.80, "away_win": 9.20, … },
  "processing_latency_us": 37, "timestamp": "…" }
```

Notes:

- Messages are versioned (`v`, `type`). Node never recalculates odds.
- Order follows Redis publish order; every frame carries `sequence` so
  clients detect gaps. No replay buffer: after a drop, reconnect and
  re-fetch `GET /api/matches/:id`, then continue from live frames.
- The socket is server-to-client; clients may send `{ "type": "ping" }`
  (answered with a pong) — anything else is ignored.
- `GET /health` also reports `websocket: { connections, subscriptions,
  messages_broadcast, redis_errors }` (in-memory counters, no I/O).

## Environment

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | API listen port |
| `GO_ENGINE_URL` | `http://localhost:8081` | Internal Go service |
| `DATABASE_URL` | `postgres://pulse:pulse@localhost:5434/pulse?sslmode=disable` | Reads (writes go via Go) |
| `REDIS_URL` | `redis://localhost:6381/0` | Hot-state fast path, PG fallback |

## Run

```bash
# 1. Infrastructure + Go engine (repo root)
docker compose up -d
go run ./cmd/migrate
DATABASE_URL=… REDIS_URL=… go run ./cmd/engineserver  # :8081

# 2. API + dashboard (this folder)
cp .env.example .env   # adjust ports if compose uses overrides
pnpm install
pnpm start             # :3000
```

## Dashboard

The API also serves a dependency-free console at `http://localhost:3000/`
(`public/`, no build step, no framework), with hash-routed views:

- **Overview** — dependency health, pipeline, match list (click opens Live),
  observed issues.
- **Live Matches** — workspace with match picker, scoreboard, odds terminal
  (probability bars + persisted/live history chart), status-gated simulator,
  engine vs API-round-trip latency (p95 at ≥20 samples), event feed.
- **Scenario Lab** — fresh match by default (or existing), predefined
  scenarios executed as real sequential API calls with progress + abort.
- **Event Explorer** — chronological stream with per-event odds/fairness
  inspection and a client-observed submission log.
- **Fairness** — commitment, reveal, verify latest or any sequence/market.

Connection badge with auto-reconnect (REST refetch, then live frames resume).
Deep-link a match via `#/live/<match_id>` (legacy `#m=<id>` redirects).
