// Benchmarks for the core engine operation:
//
//	event → state update → odds calculation → fairness draws
//
// This measures pure in-memory computation only: no HTTP, no PostgreSQL,
// no Redis, no WebSocket. Those layers add their own latency on top and
// are reported separately (see README). This is a local measurement on
// development hardware, not a claim about production sportsbook performance.
package engine

import (
	"fmt"
	"testing"
	"time"

	"pulse/internal/events"
	"pulse/internal/fairness"
	"pulse/internal/state"
)

var benchTime = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// benchEvent cycles card/goal types so every iteration does the same shape
// of work (constant 11x11 Poisson grid) without touching the match clock.
func benchEvent(matchID string, seq int64, i int) events.Event {
	typ := events.TypeGoalHome
	switch i % 4 {
	case 1:
		typ = events.TypeGoalAway
	case 2:
		typ = events.TypeYellowHome
	case 3:
		typ = events.TypeRedAway
	}
	return events.Event{
		ID:        fmt.Sprintf("bench-%d", i),
		MatchID:   matchID,
		Sequence:  seq,
		Type:      typ,
		Timestamp: benchTime,
	}
}

func BenchmarkProcess(b *testing.B) {
	// Fixed zero seed: draws stay deterministic, timing the derivation itself.
	eng, err := NewWithSeed(0.05, make([]byte, fairness.SeedSize))
	if err != nil {
		b.Fatal(err)
	}
	st := state.MatchState{
		MatchID: "bench", HomeTeam: "H", AwayTeam: "A",
		Minute: 60, Status: state.StatusLive,
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		res, err := eng.Process(st, benchEvent(st.MatchID, st.Sequence+1, i))
		if err != nil {
			b.Fatal(err)
		}
		st = res.State
	}
}

func BenchmarkFairnessDraw(b *testing.B) {
	seed := make([]byte, fairness.SeedSize)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := fairness.Draw(seed, "bench", int64(i), fairness.MarketHome); err != nil {
			b.Fatal(err)
		}
	}
}
