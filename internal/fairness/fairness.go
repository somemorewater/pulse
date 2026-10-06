// Package fairness implements the provably-fair commitment/reveal scheme.
//
// Algorithm "pf-v1":
//
//	commitment = hex(SHA-256(server_seed))
//	value      = first-8-bytes(HMAC-SHA256(server_seed, "matchID:seq:market")) / 2^64
//
// Value range: [0, 1). Same inputs always yield the same value;
// different sequence/market inputs yield unrelated values.
//
// Security notes:
//   - crypto/rand generates the 32-byte server seed because math/rand is
//     predictable and timestamps are guessable; only crypto/rand gives
//     256-bit unpredictability.
//   - SHA-256 commitment is preimage-resistant: publishing the commitment
//     hides the seed but binds the operator — the seed cannot be changed
//     after commitment without changing the hash.
//   - HMAC-SHA256 (keyed by the seed) derives per-market values so that
//     knowing one market/sequence value reveals nothing about others or
//     the key, unlike a raw hash of concatenated strings.
//   - PROVES: a revealed seed reproduces the previously committed values.
//     Anyone with (seed, matchID, seq, market) recomputes the exact value
//     and checks it against the commitment.
//   - DOES NOT PROVE: that the probability model or the odds are
//     objectively "fair". The odds model stays a separate, explainable
//     Poisson model; fairness only adds a small auditable perturbation.
package fairness

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
)

// Version identifies the derivation algorithm. Bump on any format change.
const Version = "pf-v1"

// Canonical market identifiers for 1X2.
const (
	MarketHome = "1"
	MarketDraw = "X"
	MarketAway = "2"
)

// SeedSize is the server seed length in bytes (256 bits).
const SeedSize = 32

var (
	ErrBadSeed       = errors.New("fairness: seed must be 32 bytes")
	ErrBadCommitment = errors.New("fairness: commitment mismatch")
	ErrBadValue      = errors.New("fairness: value mismatch")
)

// GenerateSeed returns a cryptographically secure random 32-byte seed.
func GenerateSeed() ([]byte, error) {
	seed := make([]byte, SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	return seed, nil
}

// Commitment returns hex(SHA-256(seed)). Safe to publish pre-reveal.
func Commitment(seed []byte) (string, error) {
	if len(seed) != SeedSize {
		return "", ErrBadSeed
	}
	sum := sha256.Sum256(seed)
	return hex.EncodeToString(sum[:]), nil
}

// message is the HMAC input. %d for seq avoids ambiguity ("12:3" vs "1:23"
// cannot collide because fields are positionally separated by ":").
func message(matchID string, seq int64, market string) string {
	return fmt.Sprintf("%s:%d:%s", matchID, seq, market)
}

// Draw derives the deterministic value in [0,1) for one market point.
// It is pure: same inputs always produce the same output.
func Draw(seed []byte, matchID string, seq int64, market string) (float64, error) {
	if len(seed) != SeedSize {
		return 0, ErrBadSeed
	}
	mac := hmac.New(sha256.New, seed)
	_, _ = mac.Write([]byte(message(matchID, seq, market)))
	digest := mac.Sum(nil)
	u := binary.BigEndian.Uint64(digest[:8])
	return float64(u) / float64(1<<64), nil
}

// Verify recomputes the value from public inputs plus the revealed seed
// and reports whether it matches expected. No hidden state is needed.
func Verify(seed []byte, matchID string, seq int64, market string, expected float64) error {
	got, err := Draw(seed, matchID, seq, market)
	if err != nil {
		return err
	}
	if got != expected {
		return fmt.Errorf("%w: got %0.17g want %0.17g", ErrBadValue, got, expected)
	}
	return nil
}

// VerifyCommitment checks a revealed seed against its published commitment
// in constant time.
func VerifyCommitment(commitmentHex string, seed []byte) error {
	want, err := Commitment(seed)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare([]byte(want), []byte(commitmentHex)) != 1 {
		return ErrBadCommitment
	}
	return nil
}

// Record is the auditable unit persisted later (PostgreSQL comes later).
// It carries no secret: the seed is never stored here.
type Record struct {
	MatchID    string
	Commitment string // hex(SHA-256(seed)), published pre-reveal
	Sequence   int64
	Market     string
	Value      float64 // deterministic draw in [0,1)
	Algorithm  string  // e.g. "pf-v1"
}

// NewRecord derives one market value and binds it to the commitment.
func NewRecord(seed []byte, matchID string, seq int64, market string) (Record, error) {
	commit, err := Commitment(seed)
	if err != nil {
		return Record{}, err
	}
	v, err := Draw(seed, matchID, seq, market)
	if err != nil {
		return Record{}, err
	}
	return Record{
		MatchID:    matchID,
		Commitment: commit,
		Sequence:   seq,
		Market:     market,
		Value:      v,
		Algorithm:  Version,
	}, nil
}

// VerifyRecord independently reproduces a record from the revealed seed.
func VerifyRecord(seed []byte, r Record) error {
	if err := VerifyCommitment(r.Commitment, seed); err != nil {
		return err
	}
	if r.Algorithm != Version {
		return fmt.Errorf("fairness: unknown algorithm %q", r.Algorithm)
	}
	return Verify(seed, r.MatchID, r.Sequence, r.Market, r.Value)
}
