// Package service orchestrates the durable event flow:
//
//	event → validate → idempotency check → engine.Process → persist (PG tx)
//	→ update Redis → publish update
//
// Ordering and tradeoffs:
//
//  1. Validation and the in-memory transition happen first so invalid or
//     stale events are rejected before touching infrastructure.
//  2. PostgreSQL commits before anything is published. An event is only
//     "processed" after the tx commits; persistence failure means the
//     caller gets an infrastructure error and must retry with the same
//     event ID/sequence (idempotent on retry).
//  3. Redis state/odds are written after the commit, then the Pub/Sub
//     message is published. Publish always represents committed state —
//     we never broadcast what was not durably stored.
//  4. Tradeoff: if Redis or publish fails after the PG commit, the event
//     IS durable but live subscribers may lag. The error is still
//     reported as infrastructure failure so operators can reconcile:
//     Redis can be rebuilt from PostgreSQL and subscribers can replay
//     history. The alternative (publish-then-commit) would risk
//     broadcasting phantom state that never commits, which is worse.
package service

import (
	"context"
	"errors"
	"fmt"

	"pulse/internal/engine"
	"pulse/internal/events"
	infraredis "pulse/internal/infrastructure/redis"
	"pulse/internal/persistence/postgres"
)

// Failure classes returned by Processor.Process. Use errors.Is to branch:
//
//	Rejected  — invalid event (bad payload, wrong status, sequence gap)
//	Duplicate — already processed (stale sequence or stored row)
//	Infra     — persistence or publish failure (retry may be safe)
var (
	ErrRejected  = errors.New("service: event rejected")
	ErrDuplicate = errors.New("service: event already processed")
	ErrInfra     = errors.New("service: infrastructure failure")
)

// Processor binds the pure engine to the durable and live adapters.
// The engine itself stays free of SQL and Redis calls.
type Processor struct {
	eng *engine.Engine
	pg  *postgres.Store
	rd  *infraredis.Client
}

// New wires a processor. eng must already carry the match server seed
// (engine.NewWithSeed) when fairness output is desired.
func New(eng *engine.Engine, pg *postgres.Store, rd *infraredis.Client) *Processor {
	return &Processor{eng: eng, pg: pg, rd: rd}
}

// Process handles one event end to end.
func (p *Processor) Process(ctx context.Context, ev events.Event) (engine.Result, error) {
	// 1-2. Load durable base state, then validate + transition in memory.
	// PostgreSQL is the source of truth for sequencing across restarts.
	base, err := p.pg.GetMatch(ctx, ev.MatchID)
	if err != nil {
		if errors.Is(err, postgres.ErrNotFound) {
			return engine.Result{}, fmt.Errorf("%w: unknown match %s", ErrRejected, ev.MatchID)
		}
		return engine.Result{}, fmt.Errorf("%w: load match: %v", ErrInfra, err)
	}

	res, err := p.eng.Process(base, ev)
	if err != nil {
		if errors.Is(err, engine.ErrStaleSequence) {
			return res, fmt.Errorf("%w: %w", ErrDuplicate, err)
		}
		if errors.Is(err, postgres.ErrDuplicate) {
			return res, fmt.Errorf("%w: %w", ErrDuplicate, err)
		}
		// Double-wrap: classifiers upstream match both the service class
		// and the domain cause (e.g. engine.ErrBadStatus -> 422).
		return engine.Result{}, fmt.Errorf("%w: %w", ErrRejected, err)
	}

	// 3. Durable commit. Unique constraints re-guard the race where two
	// deliveries pass the in-memory check concurrently.
	if err := p.pg.AppendProcessed(ctx, ev, res); err != nil {
		if errors.Is(err, postgres.ErrDuplicate) {
			return res, fmt.Errorf("%w: %v", ErrDuplicate, err)
		}
		return engine.Result{}, fmt.Errorf("%w: persist: %v", ErrInfra, err)
	}

	// 4. Live state after commit only.
	if err := p.rd.SetState(ctx, res.State); err != nil {
		return res, fmt.Errorf("%w: redis state: %v", ErrInfra, err)
	}
	if err := p.rd.SetOdds(ctx, ev.MatchID, res); err != nil {
		return res, fmt.Errorf("%w: redis odds: %v", ErrInfra, err)
	}
	if err := p.rd.PublishUpdate(ctx, ev, res); err != nil {
		return res, fmt.Errorf("%w: publish: %v", ErrInfra, err)
	}
	return res, nil
}
