// Package postgres is the durable adapter for matches, events,
// odds snapshots and fairness commitments.
//
// It knows SQL only. Odds, state and fairness rules stay in their
// domain packages; the engine never imports this package.
package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/lib/pq"

	"pulse/internal/engine"
	"pulse/internal/events"
	"pulse/internal/state"
)

// Sentinel errors so callers distinguish failure classes.
var (
	ErrDuplicate = errors.New("postgres: duplicate event (id or match sequence already stored)")
	ErrNotFound  = errors.New("postgres: match not found")
	ErrInfra     = errors.New("postgres: infrastructure failure")
)

// Store wraps a *sql.DB pool.
type Store struct {
	db *sql.DB
}

// Open connects and verifies the database is reachable.
func Open(databaseURL string) (*Store, error) {
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("%w: open: %v", ErrInfra, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("%w: ping: %v", ErrInfra, err)
	}
	return &Store{db: db}, nil
}

// DB exposes the pool for the migrate command. Prefer the typed methods.
func (s *Store) DB() *sql.DB { return s.db }

// Close releases the pool.
func (s *Store) Close() error { return s.db.Close() }

// Health reports database reachability.
func (s *Store) Health(ctx context.Context) error {
	if err := s.db.PingContext(ctx); err != nil {
		return fmt.Errorf("%w: %v", ErrInfra, err)
	}
	return nil
}

func isUniqueViolation(err error) bool {
	var pqErr *pq.Error
	if errors.As(err, &pqErr) {
		return pqErr.Code == "23505"
	}
	return false
}

// payloadJSON serialises the domain payload for the JSONB column.
func payloadJSON(p events.Payload) ([]byte, error) {
	return json.Marshal(map[string]any{
		"minute":     p.Minute,
		"minute_set": p.MinuteSet,
		"player":     p.Player,
		"detail":     p.Detail,
	})
}

func scanMatch(row interface {
	Scan(...any) error
}) (state.MatchState, error) {
	var st state.MatchState
	var status string
	var lastSeq int64
	var homeReds, awayReds, homeYellows, awayYellows int
	var createdAt, updatedAt time.Time
	_ = createdAt
	_ = updatedAt
	err := row.Scan(
		&st.MatchID, &st.HomeTeam, &st.AwayTeam,
		&st.HomeScore, &st.AwayScore, &st.Minute, &status, &lastSeq,
		&homeReds, &awayReds, &homeYellows, &awayYellows,
		&createdAt, &updatedAt,
	)
	if err != nil {
		return state.MatchState{}, err
	}
	st.Status = status
	st.Sequence = lastSeq
	st.HomeReds, st.AwayReds = homeReds, awayReds
	st.HomeYellows, st.AwayYellows = homeYellows, awayYellows
	return st, nil
}

const matchCols = `id, home_team, away_team, home_score, away_score,
	current_minute, status, last_sequence,
	home_reds, away_reds, home_yellows, away_yellows,
	created_at, updated_at`

// CreateMatch inserts the initial row for a new match.
func (s *Store) CreateMatch(ctx context.Context, st state.MatchState) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO matches (id, home_team, away_team, home_score, away_score,
			current_minute, status, last_sequence,
			home_reds, away_reds, home_yellows, away_yellows)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		st.MatchID, st.HomeTeam, st.AwayTeam, st.HomeScore, st.AwayScore,
		st.Minute, st.Status, st.Sequence,
		st.HomeReds, st.AwayReds, st.HomeYellows, st.AwayYellows,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return fmt.Errorf("match %s already exists: %w", st.MatchID, ErrDuplicate)
		}
		return fmt.Errorf("%w: create match: %v", ErrInfra, err)
	}
	return nil
}

// GetMatch loads the durable match row (source of truth for sequencing).
func (s *Store) GetMatch(ctx context.Context, matchID string) (state.MatchState, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+matchCols+` FROM matches WHERE id = $1`, matchID)
	st, err := scanMatch(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return state.MatchState{}, fmt.Errorf("match %s: %w", matchID, ErrNotFound)
		}
		return state.MatchState{}, fmt.Errorf("%w: get match: %v", ErrInfra, err)
	}
	return st, nil
}

// AppendProcessed commits one processed event atomically:
// event row + match row update + odds snapshot + fairness rows.
// It must be called only after engine.Process succeeded.
func (s *Store) AppendProcessed(ctx context.Context, ev events.Event, res engine.Result) error {
	payload, err := payloadJSON(ev.Payload)
	if err != nil {
		return fmt.Errorf("encode payload: %w", err)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("%w: begin: %v", ErrInfra, err)
	}
	// Roll back on any failure; no silent commits.
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO events (id, match_id, sequence, type, payload)
		VALUES ($1,$2,$3,$4,$5)`,
		ev.ID, ev.MatchID, ev.Sequence, ev.Type, string(payload),
	); err != nil {
		if isUniqueViolation(err) {
			return fmt.Errorf("event %s seq %d: %w", ev.ID, ev.Sequence, ErrDuplicate)
		}
		return fmt.Errorf("%w: insert event: %v", ErrInfra, err)
	}

	st := res.State
	if _, err := tx.ExecContext(ctx, `
		UPDATE matches SET home_score=$2, away_score=$3, current_minute=$4,
			status=$5, last_sequence=$6,
			home_reds=$7, away_reds=$8, home_yellows=$9, away_yellows=$10,
			updated_at=now()
		WHERE id=$1`,
		st.MatchID, st.HomeScore, st.AwayScore, st.Minute, st.Status, st.Sequence,
		st.HomeReds, st.AwayReds, st.HomeYellows, st.AwayYellows,
	); err != nil {
		return fmt.Errorf("%w: update match: %v", ErrInfra, err)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO odds_snapshots (match_id, sequence,
			home_probability, draw_probability, away_probability,
			home_odds, draw_odds, away_odds, processing_latency_ns)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		st.MatchID, st.Sequence,
		res.Odds.HomeProb, res.Odds.DrawProb, res.Odds.AwayProb,
		res.Odds.HomeOdds, res.Odds.DrawOdds, res.Odds.AwayOdds,
		res.Latency.Nanoseconds(),
	); err != nil {
		if isUniqueViolation(err) {
			return fmt.Errorf("odds snapshot seq %d: %w", st.Sequence, ErrDuplicate)
		}
		return fmt.Errorf("%w: insert odds: %v", ErrInfra, err)
	}

	for _, rec := range res.Fairness {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO fairness_commitments (match_id, sequence, market,
				commitment, generated_value, algorithm_version)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			rec.MatchID, rec.Sequence, rec.Market,
			rec.Commitment, rec.Value, rec.Algorithm,
		); err != nil {
			if isUniqueViolation(err) {
				return fmt.Errorf("fairness seq %d market %s: %w", rec.Sequence, rec.Market, ErrDuplicate)
			}
			return fmt.Errorf("%w: insert fairness: %v", ErrInfra, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("%w: commit: %v", ErrInfra, err)
	}
	return nil
}

// EnsureMigrated applies *.sql files from dir in lexical order, tracking
// applied versions in schema_migrations. Safe to run repeatedly.
func EnsureMigrated(ctx context.Context, db *sql.DB, dir string, files []string, read func(string) ([]byte, error)) error {
	if _, err := db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("%w: migrations table: %v", ErrInfra, err)
	}
	for _, f := range files {
		var applied bool
		if err := db.QueryRowContext(ctx,
			`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version=$1)`, f,
		).Scan(&applied); err != nil {
			return fmt.Errorf("%w: migration check: %v", ErrInfra, err)
		}
		if applied {
			continue
		}
		body, err := read(dir + "/" + f)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", f, err)
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("%w: migration begin: %v", ErrInfra, err)
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration %s: %w", f, err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO schema_migrations (version) VALUES ($1)`, f,
		); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("record migration %s: %w", f, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("%w: migration commit: %v", ErrInfra, err)
		}
	}
	return nil
}

// EventRow is a stored event with its raw JSON payload.
type EventRow struct {
	ID        string
	MatchID   string
	Sequence  int64
	Type      string
	Payload   json.RawMessage
	CreatedAt time.Time
}

// ListEvents returns a match's events oldest-first (for future read layers).
func (s *Store) ListEvents(ctx context.Context, matchID string, limit int) ([]EventRow, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, match_id, sequence, type, payload, created_at
		FROM events WHERE match_id=$1 ORDER BY sequence ASC LIMIT $2`,
		matchID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("%w: list events: %v", ErrInfra, err)
	}
	defer rows.Close()
	var out []EventRow
	for rows.Next() {
		var r EventRow
		var payload string
		if err := rows.Scan(&r.ID, &r.MatchID, &r.Sequence, &r.Type, &payload, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("%w: scan event: %v", ErrInfra, err)
		}
		r.Payload = json.RawMessage(payload)
		out = append(out, r)
	}
	return out, rows.Err()
}

// FairnessRow is one stored per-market commitment.
type FairnessRow struct {
	Sequence   int64
	Market     string
	Commitment string
	Value      float64
	Algorithm  string
	RevealedAt *time.Time
	CreatedAt  time.Time
}

// ListFairness returns all stored commitments for a match, ordered by
// sequence then market. It never returns a server seed (none is stored).
func (s *Store) ListFairness(ctx context.Context, matchID string) ([]FairnessRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT sequence, market, commitment, generated_value,
			algorithm_version, revealed_at, created_at
		FROM fairness_commitments WHERE match_id=$1
		ORDER BY sequence ASC, market ASC`,
		matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("%w: list fairness: %v", ErrInfra, err)
	}
	defer rows.Close()
	var out []FairnessRow
	for rows.Next() {
		var r FairnessRow
		var revealed sql.NullTime
		if err := rows.Scan(&r.Sequence, &r.Market, &r.Commitment, &r.Value,
			&r.Algorithm, &revealed, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("%w: scan fairness: %v", ErrInfra, err)
		}
		if revealed.Valid {
			t := revealed.Time
			r.RevealedAt = &t
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetFairnessRecord returns one stored market point, if present.
func (s *Store) GetFairnessRecord(ctx context.Context, matchID string, seq int64, market string) (FairnessRow, error) {
	var r FairnessRow
	var revealed sql.NullTime
	err := s.db.QueryRowContext(ctx, `
		SELECT sequence, market, commitment, generated_value,
			algorithm_version, revealed_at, created_at
		FROM fairness_commitments
		WHERE match_id=$1 AND sequence=$2 AND market=$3`,
		matchID, seq, market,
	).Scan(&r.Sequence, &r.Market, &r.Commitment, &r.Value,
		&r.Algorithm, &revealed, &r.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return FairnessRow{}, ErrNotFound
		}
		return FairnessRow{}, fmt.Errorf("%w: get fairness: %v", ErrInfra, err)
	}
	if revealed.Valid {
		t := revealed.Time
		r.RevealedAt = &t
	}
	return r, nil
}

// MarkMatchRevealed records the intentional reveal of a match seed.
// It stores only the timestamp, never the seed itself.
func (s *Store) MarkMatchRevealed(ctx context.Context, matchID string, at time.Time) error {
	if _, err := s.db.ExecContext(ctx, `
		UPDATE fairness_commitments SET revealed_at=$2
		WHERE match_id=$1 AND revealed_at IS NULL`,
		matchID, at.UTC(),
	); err != nil {
		return fmt.Errorf("%w: mark revealed: %v", ErrInfra, err)
	}
	return nil
}

// GetOddsHistory returns snapshots newest-first (for the future API layer).
func (s *Store) GetOddsHistory(ctx context.Context, matchID string, limit int) ([]engine.Result, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT sequence, home_probability, draw_probability, away_probability,
			home_odds, draw_odds, away_odds, processing_latency_ns
		FROM odds_snapshots WHERE match_id=$1 ORDER BY sequence DESC LIMIT $2`,
		matchID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("%w: odds history: %v", ErrInfra, err)
	}
	defer rows.Close()
	var out []engine.Result
	for rows.Next() {
		var r engine.Result
		var latencyNs int64
		var seq int64
		if err := rows.Scan(&seq,
			&r.Odds.HomeProb, &r.Odds.DrawProb, &r.Odds.AwayProb,
			&r.Odds.HomeOdds, &r.Odds.DrawOdds, &r.Odds.AwayOdds,
			&latencyNs,
		); err != nil {
			return nil, fmt.Errorf("%w: scan odds: %v", ErrInfra, err)
		}
		r.State.MatchID = matchID
		r.State.Sequence = seq
		r.Latency = time.Duration(latencyNs)
		out = append(out, r)
	}
	return out, rows.Err()
}
