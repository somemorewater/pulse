-- 0002_match_seeds: persist per-match fairness seeds for restart recovery.
--
-- Without this table a Go engine restart permanently orphans existing matches:
-- match state survives in matches/events, but the server seed (needed for
-- future fairness draws and for reveal) lived only in process memory.
--
-- Security: seeds are returned ONLY via the explicit reveal call, never in
-- normal reads, and never logged. This is demo-grade protection; production
-- should envelope-encrypt this column with a KMS-managed key.
-- Matches created before this migration have no seed row and cannot resume
-- event processing (their history and verification still read fine).

CREATE TABLE IF NOT EXISTS match_seeds (
    match_id   TEXT PRIMARY KEY REFERENCES matches (id) ON DELETE CASCADE,
    seed       BYTEA NOT NULL,
    commitment TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
