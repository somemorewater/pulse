// Package state holds the mutable match snapshot.
//
// The engine treats MatchState as a value: events produce a new
// state, the old one is never mutated in place.
package state

// Match lifecycle statuses.
const (
	StatusScheduled = "scheduled"
	StatusLive      = "live"
	StatusFinished  = "finished"
)

// MatchState is the minimal snapshot the odds model needs.
type MatchState struct {
	MatchID  string
	HomeTeam string
	AwayTeam string

	HomeScore int
	AwayScore int

	// Minute is 0-120. Regulation is 90; values above are stoppage/extra time.
	Minute int
	Status string

	// Sequence is the last applied event sequence number.
	// Used for idempotency: stale events must not mutate state.
	Sequence int64

	HomeReds    int
	AwayReds    int
	HomeYellows int
	AwayYellows int
}
