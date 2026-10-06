// Single match store. Holds the latest snapshot/update plus derived lists.
// UI subscribes and re-renders; networking never touches the DOM directly.
export const EVENT_LABELS = {
  match_start: 'Match started',
  match_end: 'Match ended',
  goal_home: '⚽ Home goal',
  goal_away: '⚽ Away goal',
  yellow_card_home: '🟨 Home yellow card',
  yellow_card_away: '🟨 Away yellow card',
  red_card_home: '🟥 Home red card',
  red_card_away: '🟥 Away red card',
  minute_update: '⏱ Minute update',
};

export function eventLabel(type) {
  return EVENT_LABELS[type] ?? type;
}

// normalizeOdds unifies the two wire shapes into the client contract:
// REST serves { home_odds, draw_odds, away_odds, … }, the WebSocket serves
// { home_win, draw, away_win, … }. One place, so views use a single shape.
export function normalizeOdds(odds) {
  if (!odds) return null;
  if (odds.home_win !== undefined) {
    return {
      home_win: odds.home_win, draw: odds.draw, away_win: odds.away_win,
      home_prob: odds.home_prob, draw_prob: odds.draw_prob, away_prob: odds.away_prob,
    };
  }
  return {
    home_win: odds.home_odds, draw: odds.draw_odds, away_win: odds.away_odds,
    home_prob: odds.home_prob, draw_prob: odds.draw_prob, away_prob: odds.away_prob,
  };
}

export function createStore() {
  const listeners = new Set();
  const state = {
    matchId: null,
    match: null,
    odds: null,
    sequence: 0,
    latencyUs: null,
    latencies: [],
    lastUpdate: null,
    events: [], // { sequence, type, minute } — newest first, capped
    fairness: [],
    commitment: null,
    seed: null,
    verifyStatus: 'unverified', // unverified | verified | failed
  };

  function emit() {
    for (const fn of listeners) {
      try { fn(state); } catch { /* one bad view must not break others */ }
    }
  }

  return {
    state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    reset(matchId) {
      Object.assign(state, {
        matchId, match: null, odds: null, sequence: 0,
        latencyUs: null, latencies: [], lastUpdate: null,
        events: [], fairness: [], commitment: null,
        seed: null, verifyStatus: 'unverified',
      });
      emit();
    },
    applySnapshot(msg) {
      state.match = msg.state ?? msg.match ?? null;
      state.odds = normalizeOdds(msg.odds);
      state.sequence = msg.sequence ?? 0;
      state.lastUpdate = msg.timestamp ?? new Date().toISOString();
      state.verifyStatus = 'unverified';
      emit();
    },
    applyUpdate(msg) {
      // Guard late frames: after a REST refetch the store may already be
      // ahead of a delayed update. Sequences only move forward.
      if (typeof msg.sequence === 'number' && msg.sequence < state.sequence) return;
      state.match = msg.state;
      state.odds = msg.odds;
      state.sequence = msg.sequence;
      state.lastUpdate = msg.timestamp ?? new Date().toISOString();
      if (typeof msg.processing_latency_us === 'number') {
        state.latencyUs = msg.processing_latency_us;
        state.latencies = [...state.latencies, msg.processing_latency_us].slice(-20);
      }
      state.verifyStatus = 'unverified';
      this.prependEvent({ sequence: msg.sequence, type: msg.event_type, minute: msg.state?.minute });
    },
    recordRestLatency(us) {
      if (typeof us === 'number') {
        state.latencyUs = us;
        state.latencies = [...state.latencies, us].slice(-20);
        emit();
      }
    },
    setEventHistory(events) {
      state.events = events
        .map((e) => ({ sequence: e.sequence, type: e.type, minute: e.payload?.minute ?? null }))
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, 20);
      emit();
    },
    prependEvent(entry) {
      state.events = [entry, ...state.events.filter((e) => e.sequence !== entry.sequence)].slice(0, 20);
      emit();
    },
    setFairness(records, commitment) {
      state.fairness = records;
      if (commitment) state.commitment = commitment;
      else if (records.length > 0) state.commitment = records[0].commitment;
      emit();
    },
    setSeed(seed) {
      state.seed = seed;
      state.verifyStatus = 'unverified';
      emit();
    },
    setVerified(ok) {
      state.verifyStatus = ok ? 'verified' : 'failed';
      emit();
    },
  };
}
