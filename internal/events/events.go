// Package events defines the live incident types and validation.
//
// Every event carries an ID, match ID, sequence number, type,
// timestamp and payload so it can be persisted and replayed idempotently.
package events

import (
	"errors"
	"time"
)

// Event types supported by the MVP engine.
const (
	TypeGoalHome     = "goal_home"
	TypeGoalAway     = "goal_away"
	TypeYellowHome   = "yellow_card_home"
	TypeYellowAway   = "yellow_card_away"
	TypeRedHome      = "red_card_home"
	TypeRedAway      = "red_card_away"
	TypeMinuteUpdate = "minute_update"
	TypeMatchStart   = "match_start"
	TypeMatchEnd     = "match_end"
)

var (
	ErrMissingID      = errors.New("events: event ID is required")
	ErrMissingMatchID = errors.New("events: match ID is required")
	ErrBadSequence    = errors.New("events: sequence must be > 0")
	ErrUnknownType    = errors.New("events: unknown event type")
	ErrMissingTime    = errors.New("events: timestamp is required")
	ErrBadMinute      = errors.New("events: minute must be 0-120")
	ErrMinuteRequired = errors.New("events: minute_update requires payload.Minute")
)

// Payload carries per-type data. Only Minute is interpreted for now;
// Player/Detail are informational and never affect validation outcome.
type Payload struct {
	// Minute is the match clock for minute_update.
	// For other types it optionally syncs the clock forward.
	Minute int
	// MinuteSet distinguishes "minute 0" from "no minute supplied".
	MinuteSet bool
	Player    string
	Detail    string
}

// MinutePayload is a helper for building payloads with a clock value.
func MinutePayload(minute int) Payload {
	return Payload{Minute: minute, MinuteSet: true}
}

// Event is a single live incident.
type Event struct {
	ID        string
	MatchID   string
	Sequence  int64
	Type      string
	Timestamp time.Time
	Payload   Payload
}

// Validate checks structural correctness. State-dependent rules
// (match-ID match, ordering, status transitions) live in the engine.
func Validate(e Event) error {
	if e.ID == "" {
		return ErrMissingID
	}
	if e.MatchID == "" {
		return ErrMissingMatchID
	}
	if e.Sequence <= 0 {
		return ErrBadSequence
	}
	if e.Timestamp.IsZero() {
		return ErrMissingTime
	}
	switch e.Type {
	case TypeGoalHome, TypeGoalAway,
		TypeYellowHome, TypeYellowAway,
		TypeRedHome, TypeRedAway,
		TypeMatchStart, TypeMatchEnd:
		if e.Payload.MinuteSet && (e.Payload.Minute < 0 || e.Payload.Minute > 120) {
			return ErrBadMinute
		}
		return nil
	case TypeMinuteUpdate:
		if !e.Payload.MinuteSet {
			return ErrMinuteRequired
		}
		if e.Payload.Minute < 0 || e.Payload.Minute > 120 {
			return ErrBadMinute
		}
		return nil
	default:
		return ErrUnknownType
	}
}
