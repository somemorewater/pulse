-- 0001_init: durable Pulse MVP tables.
-- Matches carry card counts beyond the spec minimum so the durable row
-- round-trips engine state exactly (reds/yellows feed the odds model).

CREATE TABLE IF NOT EXISTS matches (
    id             TEXT PRIMARY KEY,
    home_team      TEXT NOT NULL,
    away_team      TEXT NOT NULL,
    home_score     INTEGER NOT NULL DEFAULT 0,
    away_score     INTEGER NOT NULL DEFAULT 0,
    current_minute INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'live', 'finished')),
    last_sequence  BIGINT NOT NULL DEFAULT 0,
    home_reds      INTEGER NOT NULL DEFAULT 0,
    away_reds      INTEGER NOT NULL DEFAULT 0,
    home_yellows   INTEGER NOT NULL DEFAULT 0,
    away_yellows   INTEGER NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
    id         TEXT PRIMARY KEY,
    match_id   TEXT NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
    sequence   BIGINT NOT NULL,
    type       TEXT NOT NULL,
    payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (match_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_events_match_seq ON events (match_id, sequence);

CREATE TABLE IF NOT EXISTS odds_snapshots (
    id                  BIGSERIAL PRIMARY KEY,
    match_id            TEXT NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
    sequence            BIGINT NOT NULL,
    home_probability    DOUBLE PRECISION NOT NULL,
    draw_probability    DOUBLE PRECISION NOT NULL,
    away_probability    DOUBLE PRECISION NOT NULL,
    home_odds           DOUBLE PRECISION NOT NULL,
    draw_odds           DOUBLE PRECISION NOT NULL,
    away_odds           DOUBLE PRECISION NOT NULL,
    processing_latency_ns BIGINT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (match_id, sequence)
);

CREATE TABLE IF NOT EXISTS fairness_commitments (
    id                BIGSERIAL PRIMARY KEY,
    match_id          TEXT NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
    sequence          BIGINT NOT NULL,
    market            TEXT NOT NULL,
    commitment        TEXT NOT NULL,
    generated_value   DOUBLE PRECISION NOT NULL,
    algorithm_version TEXT NOT NULL,
    revealed_at       TIMESTAMPTZ NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (match_id, sequence, market)
);

-- The raw server seed is NEVER stored. Only the SHA-256 commitment and
-- derived values are persisted; revealed_at records when the seed was
-- intentionally revealed out of band.
