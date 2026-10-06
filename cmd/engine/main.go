// Command engine demonstrates the standalone odds engine with provably-fair draws:
//
//	server seed -> commitment -> event -> odds + deterministic value -> reveal -> verify
//
// Pre-reveal only the commitment is shown; the seed is printed explicitly
// at the reveal step. No HTTP, Redis or PostgreSQL. Run: go run ./cmd/engine
package main

import (
	"encoding/hex"
	"fmt"
	"time"

	"pulse/internal/engine"
	"pulse/internal/events"
	"pulse/internal/fairness"
	"pulse/internal/state"
)

func mustEvent(id, matchID string, seq int64, typ string, payload events.Payload) events.Event {
	return events.Event{
		ID:        id,
		MatchID:   matchID,
		Sequence:  seq,
		Type:      typ,
		Timestamp: time.Now().UTC(),
		Payload:   payload,
	}
}

func show(r engine.Result) {
	s := r.State
	fmt.Printf("== seq=%d (latency=%s)\n", s.Sequence, r.Latency)
	fmt.Printf("   %s %d - %d %s  minute=%d status=%s reds=%d/%d yellows=%d/%d\n",
		s.HomeTeam, s.HomeScore, s.AwayScore, s.AwayTeam,
		s.Minute, s.Status, s.HomeReds, s.AwayReds, s.HomeYellows, s.AwayYellows)
	fmt.Printf("   P(home=%.3f draw=%.3f away=%.3f)  odds(H=%.2f D=%.2f A=%.2f)\n",
		r.Odds.HomeProb, r.Odds.DrawProb, r.Odds.AwayProb,
		r.Odds.HomeOdds, r.Odds.DrawOdds, r.Odds.AwayOdds)
	for _, rec := range r.Fairness {
		fmt.Printf("   fair[%s]=%.6f (%s)\n", rec.Market, rec.Value, rec.Algorithm)
	}
	fmt.Println()
}

func main() {
	seed, err := fairness.GenerateSeed()
	if err != nil {
		fmt.Println("seed generation failed:", err)
		return
	}
	eng, err := engine.NewWithSeed(0.05, seed)
	if err != nil {
		fmt.Println("engine setup failed:", err)
		return
	}

	st := state.MatchState{
		MatchID:  "match-demo-1",
		HomeTeam: "Pulse FC",
		AwayTeam: "Odds United",
		Minute:   0,
		Status:   state.StatusScheduled,
		Sequence: 0,
	}

	// PRE-REVEAL: only the commitment is public; the seed stays hidden.
	fmt.Println("commitment:", eng.Commitment())
	fmt.Println("(seed hidden pre-reveal)")
	fmt.Println()
	fmt.Printf("Initial: %s vs %s status=%s\n\n", st.HomeTeam, st.AwayTeam, st.Status)

	script := []struct {
		name string
		ev   events.Event
	}{
		{"match_start", mustEvent("ev-1", st.MatchID, 1, events.TypeMatchStart, events.Payload{})},
		{"minute 23", mustEvent("ev-2", st.MatchID, 2, events.TypeMinuteUpdate, events.MinutePayload(23))},
		{"goal_home", mustEvent("ev-3", st.MatchID, 3, events.TypeGoalHome, events.MinutePayload(23))},
		{"red_card_away", mustEvent("ev-4", st.MatchID, 4, events.TypeRedAway, events.MinutePayload(40))},
		{"minute 75", mustEvent("ev-5", st.MatchID, 5, events.TypeMinuteUpdate, events.MinutePayload(75))},
	}

	var history []engine.Result
	for _, step := range script {
		r, err := eng.Process(st, step.ev)
		if err != nil {
			fmt.Printf("!! %s failed: %v\n", step.name, err)
			return
		}
		st = r.State
		fmt.Printf("-- %s\n", step.name)
		show(r)
		history = append(history, r)
	}

	// Idempotency: replaying an old sequence must not mutate state.
	replay := mustEvent("ev-3-replay", st.MatchID, 3, events.TypeGoalHome, events.MinutePayload(23))
	if _, err := eng.Process(st, replay); err != nil {
		fmt.Printf("Replay seq=3 correctly rejected: %v (score %d-%d)\n\n",
			err, st.HomeScore, st.AwayScore)
	}

	// REVEAL: operator publishes the seed; anyone can verify.
	fmt.Println("== REVEAL ==")
	fmt.Println("seed:", hex.EncodeToString(seed))
	if err := fairness.VerifyCommitment(eng.Commitment(), seed); err != nil {
		fmt.Println("commitment verification FAILED:", err)
		return
	}
	fmt.Println("commitment ok: SHA-256(seed) matches published commitment")

	ok := true
	for _, r := range history {
		for _, rec := range r.Fairness {
			if err := fairness.VerifyRecord(seed, rec); err != nil {
				fmt.Printf("verify FAILED seq=%d market=%s: %v\n", rec.Sequence, rec.Market, err)
				ok = false
			}
		}
	}
	if ok {
		fmt.Printf("verification success: %d events x 3 markets reproduced exactly\n", len(history))
	}
}
