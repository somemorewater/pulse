# Pulse

**Real-Time Odds Calculation Engine**

Pulse is a real-time odds calculation system designed to demonstrate
low-latency event processing, deterministic provably-fair computation,
Redis-based live state, PostgreSQL persistence, and WebSocket-based updates.

A goal is triggered in the dashboard and, within milliseconds, the score,
recalculated odds and fairness proof stream to every connected client —
with the engine's measured compute time attached to each update.

This is a technical simulation. There is no real-money betting, no payments,
and no wallet anywhere in the system.

## Overview

Live betting interfaces must turn a stream of match incidents (goals, cards,
clock) into fresh prices for thousands of viewers with minimal delay, while
keeping an auditable record of every change. Pulse models that pipeline at a
small, explainable scale: a Go engine owns all calculation, PostgreSQL owns
durable history, Redis owns hot state and fan-out, a Node gateway owns HTTP
and WebSockets, and a dependency-free dashboard visualizes the whole flow.

## Architecture

```
                    ┌──────────────┐
                    │  PostgreSQL  │  durable: matches, events,
                    │  :5432       │  odds snapshots, fairness
                    └──────▲───────┘
                             │ commit first
                    ┌────────┴───────┐
  dashboard ──REST──▶   Node API     │
  dashboard ──WS────▶   :3000        │
                    └────────┬───────┘
                             │ /internal/* (localhost)
                    ┌────────▼───────┐
                    │  Go engine     │
                    │  :8081         │── odds + fairness compute
                    └────────┬───────┘
                             │
                    ┌────────▼───────┐
                    │  Redis :6379   │  hot state + Pub/Sub
                    └────────┬───────┘
                             │ pulse:match:{id}:updates
                    ┌────────▼───────┐
                    │ Node WS fan-out│── one subscription per match
                    └────────┬───────┘
                             ▼
                         dashboard
```

## Event Flow

```
dashboard button
  → POST /api/matches/:id/events            (Node validates shape)
  → POST /internal/events                   (gateway forwards)
  → validate → sequence/idempotency check    (stale → 409, gap → 400)
  → match state update                      (score, clock, cards, status)
  → odds calculation                        (Poisson 1X2 + margin)
  → fairness draws                           (HMAC-SHA256 per market)
  → PostgreSQL transaction                  (event + match + odds + fairness)
  → Redis state/odds write                  (hot snapshot)
  → Redis PUBLISH                            (only after commit)
  → Node subscriber → WebSocket clients
  → dashboard re-renders (no refresh)
```

PostgreSQL commits before Redis is touched and before anything is published,
so a broadcast never represents uncommitted state. If Redis or publish fails
after the commit, the error is still surfaced and live state reconciles from
PostgreSQL (documented in `internal/service`).

## Odds Model

Deliberately simple and explainable — **not** a commercial sportsbook model:

1. **Inputs:** current score, minutes remaining (of 90), red/yellow card counts,
   fixed home edge (1.15×).
2. **Intensities:** `expected goals = 0.015 × minutes_remaining × strength`,
   where strength is `1.15 − 0.30·ownReds + 0.25·oppReds − 0.02·ownYellows`
   (away baseline 1.0), clamped to `[0.2, 2.0]`.
3. **Probabilities:** independent Poisson futures enumerated over a fixed
   11×11 grid added to the current score, renormalized to sum to 1.
4. **Margin + conversion:** `decimal_odds = 1 / (p × (1 + margin))` with a
   configurable 5% overround; near-zero probabilities report closed (`0`),
   decided matches pay `1.01`.
5. **Fairness perturbation:** each probability shifts by at most ±0.2pp from
   its deterministic draw before renormalization — auditable, never decisive.

Same state + same inputs ⇒ same output. No hardcoded odds for any scenario.

## Provably Fair System

```
server seed (32 bytes, crypto/rand, never stored, never pre-revealed)
  → commitment = hex(SHA-256(seed))              published at match creation
  → value = HMAC-SHA256(seed, "match:seq:market") / 2^64   in [0,1), per market
  → stored alongside each odds snapshot          (algorithm "pf-v1")
  → reveal                                       returns the seed, timestamps it
  → independent verification                   recomputes value + commitment
```

> The fairness system proves deterministic reproducibility of the committed
> result. It does **not** prove that the underlying probability model is
> objectively fair.

## Technology

- **Go 1.27** — engine, fairness, persistence, internal HTTP (`database/sql` +
  `lib/pq`, `go-redis`, stdlib HTTP server)
- **Node.js 20+** — Fastify 5 gateway (`fastify`, `pg`, `redis`,
  `@fastify/websocket`, `@fastify/static`)
- **PostgreSQL 16** — matches, events, odds snapshots, fairness commitments
  (migration-based schema in `db/migrations`)
- **Redis 7** — hot snapshots (`pulse:match:{id}:state|odds`) and Pub/Sub
  (`pulse:match:{id}:updates`)
- **Frontend** — dependency-free static HTML/CSS/vanilla JS modules served by
  the API itself (no build step, no framework)

## API

Base `http://localhost:3000`. Errors are always
`{ "error": { "code": "...", "message": "..." } }`
(`400` invalid, `404` not found, `409` duplicate, `422` bad transition,
`500` internal, `503` engine/infra down).

```bash
# Create a match → 201 { match: {...}, commitment: "…" }
curl -X POST localhost:3000/api/matches \
  -H 'content-type: application/json' \
  -d '{"home_team":"Arsenal","away_team":"Chelsea"}'

# Start the match → 200 { state, odds, fairness, sequence, processing_latency_us }
curl -X POST localhost:3000/api/matches/m_…/events \
  -H 'content-type: application/json' \
  -d '{"id":"evt_1","type":"match_start","sequence":1}'

# Goal in the 23rd minute
curl -X POST localhost:3000/api/matches/m_…/events \
  -H 'content-type: application/json' \
  -d '{"id":"evt_2","type":"goal_home","sequence":2,"payload":{"minute":23}}'

# Reads
curl localhost:3000/api/matches/m_…            # match + odds + sequence
curl localhost:3000/api/matches/m_…/odds      # { match_id, odds }
curl "localhost:3000/api/matches/m_…/events?limit=100"
curl localhost:3000/api/matches/m_…/fairness  # commitments (no seed)
curl localhost:3000/health                    # deps + websocket counters

# Reveal (intended stage) then verify (recomputed in Go, never echoed)
curl -X POST localhost:3000/api/matches/m_…/fairness/reveal
curl -X POST localhost:3000/api/matches/m_…/fairness/verify \
  -H 'content-type: application/json' \
  -d '{"sequence":2,"market":"1","seed":"<hex>"}'
# → { "valid": true, "algorithm": "HMAC-SHA256", "algorithm_version": "pf-v1" }
```

Event types: `match_start`, `match_end`, `goal_home`, `goal_away`,
`yellow_card_home`, `yellow_card_away`, `red_card_home`, `red_card_away`,
`minute_update` (requires `payload.minute` 0–120).

## WebSocket

`GET /ws/matches/:id` (upgrade). The server first sends the current snapshot,
then streams one frame per processed event — no polling:

```jsonc
{ "v": 1, "type": "snapshot", "match_id": "m_…", "sequence": 2,
  "state": { "home_score": 1, "away_score": 0, "minute": 23, "status": "live", "…" },
  "odds": { "home_win": 1.39, "draw": 4.84, "away_win": 7.97, "…" },
  "timestamp": "…" }
{ "v": 1, "type": "match_update", "match_id": "m_…", "sequence": 3,
  "event_type": "goal_home", "state": { … }, "odds": { … },
  "processing_latency_us": 26, "timestamp": "…" }
```

Frames arrive in publish order with `sequence` on each; there is no replay
buffer — after a drop, clients refetch `GET /api/matches/:id` and continue
from live frames. The socket is server-to-client (`{"type":"ping"}` is
answered, everything else ignored).

## Local Development

Prerequisites: Docker, Go ≥ 1.27, Node ≥ 20, `pnpm`.

```bash
# 1–2. PostgreSQL + Redis (defaults :5432/:6379).
#     On clashes: POSTGRES_PORT=5434 REDIS_PORT=6381 docker compose up -d
docker compose up -d

# 3. Migrations (idempotent).
go run ./cmd/migrate

# 4. Go engine (:8081).
DATABASE_URL=postgres://pulse:pulse@localhost:5432/pulse?sslmode=disable \
REDIS_URL=redis://localhost:6379/0 \
  go run ./cmd/engineserver

# 5–6. Node API, which also serves the dashboard (:3000).
cd api && cp .env.example .env && pnpm install && pnpm start
```

## Demo

1. Open `http://localhost:3000/` → **Create match**.
2. **Start match** → status flips to live over the socket.
3. **Goal home** → score becomes 1–0, home odds collapse (~2.4 → ~1.4).
4. Watch **sequence**, **processing latency** and **timestamp** advance per event.
5. Open a second tab on `#m=<id>`: both receive identical frames.
6. **Reveal seed** → **Verify result** → `Verified`.

## Environment Variables

| Variable | Default | Used by |
|---|---|---|
| `DATABASE_URL` | `postgres://pulse:pulse@localhost:5432/pulse?sslmode=disable` | Go, migrate, Node reads |
| `REDIS_URL` | `redis://localhost:6379/0` | Go, Node |
| `ENGINE_PORT` | `8081` | Go listen port |
| `PORT` | `3000` | Node listen port |
| `GO_ENGINE_URL` | `http://localhost:8081` | Node → Go |
| `MIGRATIONS_DIR` | `db/migrations` | migrate command |
| `POSTGRES_PORT` / `REDIS_PORT` | `5432` / `6379` | compose host ports |

Examples in `.env.example` (root) and `api/.env.example`. The dashboard is
same-origin and needs no configuration. Go `/internal/*` must stay
localhost-only in any deployment.

## Benchmark

`go test ./internal/engine/ -run XXX -bench .` — measures the pure in-memory
core op (validate → transition → Poisson odds → 3 fairness draws). No HTTP,
PostgreSQL, Redis or WebSocket involved.

Machine: Intel i5-8350U @ 1.70GHz (8 threads), Linux x86_64, Go 1.27.1.

| Benchmark | Result | Allocs |
|---|---|---|
| `BenchmarkProcess` (event → state → odds → fairness) | **12,819 ns/op (~12.8 µs)** | 2,400 B/op, 41 allocs/op |
| `BenchmarkFairnessDraw` (one HMAC-SHA256 draw) | **2,706 ns/op (~2.7 µs)** | 584 B/op, 11 allocs/op |

This is a local development-machine measurement of engine compute only. It is
not API latency, not end-to-end delivery time, and not representative of
production infrastructure or sportsbook performance. Live `processing_latency_us`
values observed during development were in the same tens-of-microseconds range.

## Design Decisions

- **Go computes** because the hot path is deterministic numerics that benefit
  from a compiled, allocation-conscious core with microsecond timing.
- **Node serves clients** because the gateway is I/O-bound fan-out (REST +
  many concurrent sockets), where an event-loop server is idiomatic.
- **Redis holds hot state and Pub/Sub** because live snapshots and fan-out need
  sub-millisecond ephemeral messaging, not durable rows per tick.
- **PostgreSQL holds history** because events, odds and commitments need
  constraints, transactions and replayable order.
- **WebSockets push** because polling a fast-changing match state wastes
  requests and adds staleness; versioned frames keep the protocol evolvable.

## Limitations

- Simplified Poisson odds model; not a sportsbook pricing model.
- No authentication; internal engine endpoints rely on network locality.
- No real-money betting (by design).
- Fairness seeds live in Go process memory — an engine restart orphans
  unrevealed matches (history stays readable).
- Single engine instance; no distributed consensus or replayable event log
  (Redis Pub/Sub is fire-and-forget).
- Benchmark is local-only and not production-representative.

## Future Improvements

Event replay from PostgreSQL, durable event log, distributed engine workers,
richer probability models, Prometheus metrics, authentication, horizontal
scaling of the gateway. None of these exist yet.

---

*Portfolio: Pulse is a real-time odds calculation engine built with Go and
Node.js, using Redis for live state and event distribution, PostgreSQL for
durable history, and WebSockets for real-time updates. It demonstrates
low-latency event processing, deterministic provably-fair computation,
concurrency, and measurable engine performance.*
