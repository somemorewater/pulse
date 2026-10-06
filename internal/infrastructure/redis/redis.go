// Package redis is the live-state adapter: hot match state, current
// odds and per-match Pub/Sub for the future Node.js broadcast layer.
//
// PostgreSQL stays the durable source of history; Redis holds only
// fast-changing live snapshots and ephemeral update messages.
package redis

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	goredis "github.com/redis/go-redis/v9"

	"pulse/internal/engine"
	"pulse/internal/events"
	"pulse/internal/fairness"
	"pulse/internal/state"
)

// Keys and channels:
//
//	pulse:match:{id}:state   — latest MatchState JSON
//	pulse:match:{id}:odds    — latest odds snapshot JSON
//	pulse:match:{id}:updates — Pub/Sub channel, one JSON message per commit
func stateKey(id string) string { return "pulse:match:" + id + ":state" }
func oddsKey(id string) string  { return "pulse:match:" + id + ":odds" }
func channel(id string) string  { return "pulse:match:" + id + ":updates" }

// ChannelFor exposes the per-match channel name for future subscribers.
func ChannelFor(matchID string) string { return channel(matchID) }

// OddsValue is the JSON shape stored at the odds key.
type OddsValue struct {
	Sequence int64   `json:"sequence"`
	HomeProb float64 `json:"home_prob"`
	DrawProb float64 `json:"draw_prob"`
	AwayProb float64 `json:"away_prob"`
	HomeOdds float64 `json:"home_odds"`
	DrawOdds float64 `json:"draw_odds"`
	AwayOdds float64 `json:"away_odds"`
}

// Update is the Pub/Sub message consumed later by Node.js to broadcast
// to WebSocket clients. Structured JSON with everything needed to render
// without an extra round trip; history reconciliation still reads Postgres.
type Update struct {
	Type                string            `json:"type"` // always "update"
	MatchID             string            `json:"match_id"`
	Sequence            int64             `json:"sequence"`
	EventType           string            `json:"event_type"`
	State               state.MatchState  `json:"state"`
	Odds                OddsValue         `json:"odds"`
	Fairness            []fairness.Record `json:"fairness"`
	ProcessingLatencyUs int64             `json:"processing_latency_us"`
	PublishedAt         time.Time         `json:"published_at"`
}

// Client wraps a go-redis client.
type Client struct {
	rdb *goredis.Client
}

// New connects from a redis:// URL and verifies with PING.
func New(redisURL string) (*Client, error) {
	opt, err := goredis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("redis: parse url: %w", err)
	}
	rdb := goredis.NewClient(opt)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		_ = rdb.Close()
		return nil, fmt.Errorf("redis: ping: %w", err)
	}
	return &Client{rdb: rdb}, nil
}

// Close releases connections.
func (c *Client) Close() error { return c.rdb.Close() }

// Health reports Redis reachability.
func (c *Client) Health(ctx context.Context) error {
	if err := c.rdb.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis: ping: %w", err)
	}
	return nil
}

// SetState stores the hot match snapshot (no TTL: matches are short-lived;
// future layers may add expiry after final whistle).
func (c *Client) SetState(ctx context.Context, st state.MatchState) error {
	body, err := json.Marshal(st)
	if err != nil {
		return fmt.Errorf("redis: encode state: %w", err)
	}
	if err := c.rdb.Set(ctx, stateKey(st.MatchID), body, 0).Err(); err != nil {
		return fmt.Errorf("redis: set state: %w", err)
	}
	return nil
}

// GetState loads the hot snapshot; returns redis.Nil when absent.
func (c *Client) GetState(ctx context.Context, matchID string) (state.MatchState, error) {
	raw, err := c.rdb.Get(ctx, stateKey(matchID)).Bytes()
	if err != nil {
		return state.MatchState{}, err
	}
	var st state.MatchState
	if err := json.Unmarshal(raw, &st); err != nil {
		return state.MatchState{}, fmt.Errorf("redis: decode state: %w", err)
	}
	return st, nil
}

// SetOdds stores the current odds for a match.
func (c *Client) SetOdds(ctx context.Context, matchID string, res engine.Result) error {
	v := OddsValue{
		Sequence: res.State.Sequence,
		HomeProb: res.Odds.HomeProb, DrawProb: res.Odds.DrawProb, AwayProb: res.Odds.AwayProb,
		HomeOdds: res.Odds.HomeOdds, DrawOdds: res.Odds.DrawOdds, AwayOdds: res.Odds.AwayOdds,
	}
	body, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("redis: encode odds: %w", err)
	}
	if err := c.rdb.Set(ctx, oddsKey(matchID), body, 0).Err(); err != nil {
		return fmt.Errorf("redis: set odds: %w", err)
	}
	return nil
}

// PublishUpdate emits one structured message after the durable commit.
// It must only be called for state that was successfully persisted.
func (c *Client) PublishUpdate(ctx context.Context, ev events.Event, res engine.Result) error {
	msg := Update{
		Type:      "update",
		MatchID:   ev.MatchID,
		Sequence:  res.State.Sequence,
		EventType: ev.Type,
		State:     res.State,
	}
	msg.Odds = OddsValue{
		Sequence: res.State.Sequence,
		HomeProb: res.Odds.HomeProb, DrawProb: res.Odds.DrawProb, AwayProb: res.Odds.AwayProb,
		HomeOdds: res.Odds.HomeOdds, DrawOdds: res.Odds.DrawOdds, AwayOdds: res.Odds.AwayOdds,
	}
	msg.Fairness = res.Fairness
	msg.ProcessingLatencyUs = res.Latency.Microseconds()
	msg.PublishedAt = time.Now().UTC()
	body, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("redis: encode update: %w", err)
	}
	if err := c.rdb.Publish(ctx, channel(ev.MatchID), body).Err(); err != nil {
		return fmt.Errorf("redis: publish: %w", err)
	}
	return nil
}
