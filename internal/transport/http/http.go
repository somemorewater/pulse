// Package enginetransport exposes the pure engine plus persistence over
// a minimal internal HTTP contract for the Node.js gateway.
//
// The endpoints here are INTERNAL (localhost only in deployment).
// The public API lives in Node; this server never serves browsers.
// It performs no odds modelling beyond delegating to engine/service.
package enginetransport

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"pulse/internal/engine"
	"pulse/internal/events"
	"pulse/internal/fairness"
	infraredis "pulse/internal/infrastructure/redis"
	"pulse/internal/persistence/postgres"
	"pulse/internal/service"
	"pulse/internal/state"
)

// error codes consumed by the Node gateway for status mapping.
const (
	codeRejected   = "rejected"
	codeDuplicate  = "duplicate"
	codeTransition = "invalid_transition"
	codeNotFound   = "not_found"
	codeInfra      = "unavailable"
)

// Handler wires HTTP to the domain. Seeds live in an in-memory registry
// (single instance, MVP): restart loses unrevealed seeds, so production
// would back this with a KMS/vault. Only commitments leave this process
// before an explicit reveal call.
type Handler struct {
	pg     *postgres.Store
	rd     *infraredis.Client
	mu     sync.RWMutex
	seeds  map[string][]byte
	margin float64
}

// New builds a handler sharing one PG pool and Redis client.
func New(pg *postgres.Store, rd *infraredis.Client, margin float64) *Handler {
	if margin <= 0 {
		margin = 0.05
	}
	return &Handler{pg: pg, rd: rd, seeds: map[string][]byte{}, margin: margin}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}

// serviceErr maps domain/service failures to HTTP status + code.
func serviceErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrDuplicate):
		writeErr(w, http.StatusConflict, codeDuplicate, "event already processed")
	case errors.Is(err, engine.ErrSequenceGap):
		writeErr(w, http.StatusBadRequest, codeRejected, "event sequence gap: fetch the match to find the next expected sequence")
	case errors.Is(err, engine.ErrBadStatus):
		writeErr(w, http.StatusUnprocessableEntity, codeTransition, "event not allowed in current status")
	case errors.Is(err, service.ErrRejected):
		writeErr(w, http.StatusBadRequest, codeRejected, "invalid event")
	case errors.Is(err, postgres.ErrNotFound):
		writeErr(w, http.StatusNotFound, codeNotFound, "match not found")
	default:
		writeErr(w, http.StatusServiceUnavailable, codeInfra, "engine or infrastructure unavailable")
	}
}

// --- shapes (snake_case for the Node gateway) ---

type stateJSON struct {
	MatchID     string `json:"match_id"`
	HomeTeam    string `json:"home_team"`
	AwayTeam    string `json:"away_team"`
	HomeScore   int    `json:"home_score"`
	AwayScore   int    `json:"away_score"`
	Minute      int    `json:"minute"`
	Status      string `json:"status"`
	Sequence    int64  `json:"sequence"`
	HomeReds    int    `json:"home_reds"`
	AwayReds    int    `json:"away_reds"`
	HomeYellows int    `json:"home_yellows"`
	AwayYellows int    `json:"away_yellows"`
}

func toStateJSON(s state.MatchState) stateJSON {
	return stateJSON{s.MatchID, s.HomeTeam, s.AwayTeam, s.HomeScore, s.AwayScore,
		s.Minute, s.Status, s.Sequence, s.HomeReds, s.AwayReds, s.HomeYellows, s.AwayYellows}
}

type oddsJSON struct {
	HomeProb float64 `json:"home_prob"`
	DrawProb float64 `json:"draw_prob"`
	AwayProb float64 `json:"away_prob"`
	HomeOdds float64 `json:"home_odds"`
	DrawOdds float64 `json:"draw_odds"`
	AwayOdds float64 `json:"away_odds"`
}

type fairnessJSON struct {
	MatchID    string  `json:"match_id"`
	Sequence   int64   `json:"sequence"`
	Market     string  `json:"market"`
	Commitment string  `json:"commitment"`
	Value      float64 `json:"value"`
	Algorithm  string  `json:"algorithm"`
}

// processorFor builds a per-match processor from the registered seed.
// Unknown match IDs fail closed: without the seed the engine cannot
// reproduce that match's fairness stream.
func (h *Handler) processorFor(matchID string) (*service.Processor, error) {
	h.mu.RLock()
	seed, ok := h.seeds[matchID]
	h.mu.RUnlock()
	if !ok {
		return nil, postgres.ErrNotFound
	}
	eng, err := engine.NewWithSeed(h.margin, seed)
	if err != nil {
		return nil, err
	}
	return service.New(eng, h.pg, h.rd), nil
}

func newMatchID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "m_" + hex.EncodeToString(b), nil
}

// Routes registers the internal endpoints on mux.
func (h *Handler) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /health", h.health)
	mux.HandleFunc("POST /internal/matches", h.createMatch)
	mux.HandleFunc("POST /internal/events", h.processEvent)
	mux.HandleFunc("POST /internal/fairness/verify", h.verify)
	mux.HandleFunc("POST /internal/matches/{id}/reveal", h.reveal)
}

func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	pgOK := h.pg.Health(ctx) == nil
	rdOK := h.rd.Health(ctx) == nil
	status := http.StatusOK
	overall := "ok"
	if !pgOK || !rdOK {
		status = http.StatusServiceUnavailable
		overall = "degraded"
	}
	writeJSON(w, status, map[string]any{
		"status":   overall,
		"postgres": pgOK,
		"redis":    rdOK,
		"fairness": fairness.Version,
		"time":     time.Now().UTC().Format(time.RFC3339),
	})
}

type createMatchReq struct {
	HomeTeam string `json:"home_team"`
	AwayTeam string `json:"away_team"`
}

func (h *Handler) createMatch(w http.ResponseWriter, r *http.Request) {
	var req createMatchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, codeRejected, "invalid JSON body")
		return
	}
	req.HomeTeam = strings.TrimSpace(req.HomeTeam)
	req.AwayTeam = strings.TrimSpace(req.AwayTeam)
	if req.HomeTeam == "" || req.AwayTeam == "" {
		writeErr(w, http.StatusBadRequest, codeRejected, "home_team and away_team are required")
		return
	}
	if len(req.HomeTeam) > 64 || len(req.AwayTeam) > 64 {
		writeErr(w, http.StatusBadRequest, codeRejected, "team names must be 64 chars or fewer")
		return
	}

	id, err := newMatchID()
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, codeInfra, "engine or infrastructure unavailable")
		return
	}
	seed, err := fairness.GenerateSeed()
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, codeInfra, "engine or infrastructure unavailable")
		return
	}
	commit, err := fairness.Commitment(seed)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, codeInfra, "engine or infrastructure unavailable")
		return
	}
	st := state.MatchState{
		MatchID: id, HomeTeam: req.HomeTeam, AwayTeam: req.AwayTeam,
		Status: state.StatusScheduled,
	}
	if err := h.pg.CreateMatch(r.Context(), st); err != nil {
		if errors.Is(err, postgres.ErrDuplicate) {
			writeErr(w, http.StatusConflict, codeDuplicate, "match already exists")
			return
		}
		writeErr(w, http.StatusServiceUnavailable, codeInfra, "engine or infrastructure unavailable")
		return
	}
	h.mu.Lock()
	h.seeds[id] = seed
	h.mu.Unlock()

	writeJSON(w, http.StatusCreated, map[string]any{
		"match":      toStateJSON(st),
		"commitment": commit,
	})
}

type eventPayloadJSON struct {
	Minute *int   `json:"minute"`
	Player string `json:"player"`
	Detail string `json:"detail"`
}

type processEventReq struct {
	MatchID string `json:"match_id"`
	Event   struct {
		ID       string           `json:"id"`
		Type     string           `json:"type"`
		Sequence int64            `json:"sequence"`
		Payload  eventPayloadJSON `json:"payload"`
	} `json:"event"`
}

func (h *Handler) processEvent(w http.ResponseWriter, r *http.Request) {
	var req processEventReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, codeRejected, "invalid JSON body")
		return
	}
	if strings.TrimSpace(req.MatchID) == "" || strings.TrimSpace(req.Event.ID) == "" {
		writeErr(w, http.StatusBadRequest, codeRejected, "match_id and event.id are required")
		return
	}
	var p events.Payload
	if req.Event.Payload.Minute != nil {
		p = events.Payload{Minute: *req.Event.Payload.Minute, MinuteSet: true,
			Player: req.Event.Payload.Player, Detail: req.Event.Payload.Detail}
	} else {
		p = events.Payload{Player: req.Event.Payload.Player, Detail: req.Event.Payload.Detail}
	}
	// The server clock is authoritative: timestamp is set here, never trusted
	// from the gateway/client.
	ev := events.Event{
		ID: req.Event.ID, MatchID: req.MatchID,
		Sequence: req.Event.Sequence, Type: req.Event.Type,
		Timestamp: time.Now().UTC(), Payload: p,
	}

	proc, err := h.processorFor(req.MatchID)
	if err != nil {
		serviceErr(w, err)
		return
	}
	res, err := proc.Process(r.Context(), ev)
	if err != nil {
		serviceErr(w, err)
		return
	}

	fj := make([]fairnessJSON, 0, len(res.Fairness))
	for _, rec := range res.Fairness {
		fj = append(fj, fairnessJSON{rec.MatchID, rec.Sequence, rec.Market,
			rec.Commitment, rec.Value, rec.Algorithm})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"state": toStateJSON(res.State),
		"odds": oddsJSON{res.Odds.HomeProb, res.Odds.DrawProb, res.Odds.AwayProb,
			res.Odds.HomeOdds, res.Odds.DrawOdds, res.Odds.AwayOdds},
		"fairness":              fj,
		"processing_latency_us": res.Latency.Microseconds(),
	})
}

type verifyReq struct {
	MatchID  string   `json:"match_id"`
	Sequence int64    `json:"sequence"`
	Market   string   `json:"market"`
	Seed     string   `json:"seed"`
	Expected *float64 `json:"expected"`
}

// verify independently reproduces the stored deterministic value from the
// caller-supplied (revealed) seed and compares it against durable history.
// It never accepts a bare "valid": true claim.
func (h *Handler) verify(w http.ResponseWriter, r *http.Request) {
	var req verifyReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, codeRejected, "invalid JSON body")
		return
	}
	seed, err := hex.DecodeString(strings.TrimSpace(req.Seed))
	if err != nil || len(seed) != fairness.SeedSize {
		writeErr(w, http.StatusBadRequest, codeRejected, "seed must be 32 bytes hex-encoded")
		return
	}
	stored, err := h.pg.GetFairnessRecord(r.Context(), req.MatchID, req.Sequence, req.Market)
	if err != nil {
		if errors.Is(err, postgres.ErrNotFound) {
			writeErr(w, http.StatusNotFound, codeNotFound, "no fairness record for this match/sequence/market")
			return
		}
		writeErr(w, http.StatusServiceUnavailable, codeInfra, "engine or infrastructure unavailable")
		return
	}
	recomputed, err := fairness.Draw(seed, req.MatchID, req.Sequence, req.Market)
	if err != nil {
		writeErr(w, http.StatusBadRequest, codeRejected, "invalid seed")
		return
	}
	commit, _ := fairness.Commitment(seed)
	valid := commit == stored.Commitment && recomputed == stored.Value
	if req.Expected != nil && *req.Expected != recomputed {
		valid = false
	}
	if stored.Algorithm != fairness.Version {
		valid = false
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"valid":             valid,
		"value":             recomputed,
		"algorithm":         "HMAC-SHA256",
		"algorithm_version": fairness.Version,
	})
}

func (h *Handler) reveal(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	h.mu.RLock()
	seed, ok := h.seeds[id]
	h.mu.RUnlock()
	if !ok {
		writeErr(w, http.StatusNotFound, codeNotFound, "match not found")
		return
	}
	commit, err := fairness.Commitment(seed)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, codeInfra, "engine or infrastructure unavailable")
		return
	}
	now := time.Now().UTC()
	if err := h.pg.MarkMatchRevealed(r.Context(), id, now); err != nil {
		writeErr(w, http.StatusServiceUnavailable, codeInfra, "engine or infrastructure unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"match_id":    id,
		"seed":        hex.EncodeToString(seed),
		"commitment":  commit,
		"revealed_at": now.Format(time.RFC3339),
	})
}
