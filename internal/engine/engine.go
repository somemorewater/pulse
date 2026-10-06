// Package engine applies events to match state and recalculates odds.
//
// It owns all state-dependent validation: match-ID binding, idempotency
// (stale sequence numbers never mutate state) and status transitions.
package engine

import (
	"errors"
	"fmt"
	"time"

	"pulse/internal/events"
	"pulse/internal/fairness"
	"pulse/internal/odds"
	"pulse/internal/state"
)

var (
	ErrMatchMismatch  = errors.New("engine: event match ID does not match state")
	ErrStaleSequence  = errors.New("engine: stale sequence, already processed")
	ErrSequenceGap    = errors.New("engine: sequence gap, expected next sequence")
	ErrBadStatus      = errors.New("engine: event not allowed in current status")
	ErrClockBackwards = errors.New("engine: minute must not go backwards")
)

// Result is the outcome of processing one event.
// Fairness holds one record per 1X2 market when the engine was built
// with a server seed; it is nil for the seedless engine. The seed
// itself is never exposed here — only the commitment and the derived
// values, which become verifiable once the seed is revealed.
type Result struct {
	State    state.MatchState
	Odds     odds.Outcome
	Fairness []fairness.Record
	Latency  time.Duration
}

// Engine recalculates odds after each event. Margin is the bookmaker
// overround, e.g. 0.05 for 5%. ServerSeed is optional: nil preserves
// the original seedless behaviour exactly; set, it enables the small
// fairness perturbation via NewWithSeed.
type Engine struct {
	Margin     float64
	ServerSeed []byte
	commitment string
}

// New builds an engine; non-positive margins default to 0.05.
func New(margin float64) *Engine {
	if margin <= 0 {
		margin = 0.05
	}
	return &Engine{Margin: margin}
}

// NewWithSeed builds an engine bound to a 32-byte server seed.
// The seed is kept server-side; Commitment exposes only its SHA-256 hash.
func NewWithSeed(margin float64, seed []byte) (*Engine, error) {
	if margin <= 0 {
		margin = 0.05
	}
	commit, err := fairness.Commitment(seed)
	if err != nil {
		return nil, err
	}
	cp := make([]byte, len(seed))
	copy(cp, seed)
	return &Engine{Margin: margin, ServerSeed: cp, commitment: commit}, nil
}

// Commitment returns the published SHA-256 commitment, or "" when seedless.
func (e *Engine) Commitment() string { return e.commitment }

// Process validates the event, applies it to a copy of the state,
// recalculates odds and records the processing duration.
// Stale events (Sequence <= state.Sequence) return ErrStaleSequence
// and leave the state untouched.
func (e *Engine) Process(s state.MatchState, ev events.Event) (Result, error) {
	start := time.Now()

	if err := events.Validate(ev); err != nil {
		return Result{}, err
	}
	if ev.MatchID != s.MatchID {
		return Result{}, ErrMatchMismatch
	}
	if ev.Sequence <= s.Sequence {
		return Result{State: s, Latency: time.Since(start)}, ErrStaleSequence
	}
	// Sequences must advance by exactly 1 to detect gaps; gaps are
	// rejected rather than silently skipped.
	if ev.Sequence != s.Sequence+1 {
		return Result{}, fmt.Errorf("%w: got %d, state at %d", ErrSequenceGap, ev.Sequence, s.Sequence)
	}

	next := s
	if err := apply(&next, ev); err != nil {
		return Result{}, err
	}
	next.Sequence = ev.Sequence

	// Seedless path is byte-for-byte the original behaviour.
	if e.ServerSeed == nil {
		out := odds.Calculate(next, e.Margin)
		return Result{State: next, Odds: out, Latency: time.Since(start)}, nil
	}

	mk := []string{fairness.MarketHome, fairness.MarketDraw, fairness.MarketAway}
	draws := make([]float64, 3)
	records := make([]fairness.Record, 3)
	for i, m := range mk {
		rec, err := fairness.NewRecord(e.ServerSeed, next.MatchID, next.Sequence, m)
		if err != nil {
			return Result{}, err
		}
		records[i] = rec
		draws[i] = rec.Value
	}
	out := odds.CalculateWithFairness(next, e.Margin, draws[0], draws[1], draws[2])
	return Result{State: next, Odds: out, Fairness: records, Latency: time.Since(start)}, nil
}

func apply(s *state.MatchState, ev events.Event) error {
	syncClock := func() error {
		if ev.Payload.MinuteSet {
			if ev.Payload.Minute < s.Minute {
				return ErrClockBackwards
			}
			s.Minute = ev.Payload.Minute
		}
		return nil
	}

	switch ev.Type {
	case events.TypeMatchStart:
		if s.Status != state.StatusScheduled {
			return ErrBadStatus
		}
		s.Status = state.StatusLive
		return nil
	case events.TypeMatchEnd:
		if s.Status != state.StatusLive {
			return ErrBadStatus
		}
		s.Status = state.StatusFinished
		return nil
	case events.TypeMinuteUpdate:
		if s.Status != state.StatusLive {
			return ErrBadStatus
		}
		if ev.Payload.Minute < s.Minute {
			return ErrClockBackwards
		}
		s.Minute = ev.Payload.Minute
		return nil
	case events.TypeGoalHome, events.TypeGoalAway,
		events.TypeYellowHome, events.TypeYellowAway,
		events.TypeRedHome, events.TypeRedAway:
		if s.Status != state.StatusLive {
			return ErrBadStatus
		}
		if err := syncClock(); err != nil {
			return err
		}
		switch ev.Type {
		case events.TypeGoalHome:
			s.HomeScore++
		case events.TypeGoalAway:
			s.AwayScore++
		case events.TypeYellowHome:
			s.HomeYellows++
		case events.TypeYellowAway:
			s.AwayYellows++
		case events.TypeRedHome:
			s.HomeReds++
		case events.TypeRedAway:
			s.AwayReds++
		}
		return nil
	default:
		return events.ErrUnknownType
	}
}
