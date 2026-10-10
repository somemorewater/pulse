// Match store. Holds snapshots, live updates, persisted history, health and
// client-observed submission outcomes. UI subscribes and re-renders;
// networking never touches the DOM directly.
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

// stats over real samples only. p95 needs ≥20 samples, else "collecting".
export function describeSamples(samples) {
  const n = samples.length;
  if (n === 0) return { n, text: 'no samples yet' };
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / n);
  const p95 = n >= 20 ? sorted[Math.min(n - 1, Math.ceil(n * 0.95) - 1)] : null;
  return {
    n,
    min: sorted[0],
    avg,
    max: sorted[n - 1],
    p95,
    text: p95 === null
      ? `min ${sorted[0]} · avg ${avg} · max ${sorted[n - 1]} (p95 needs ${20 - n} more)`
      : `min ${sorted[0]} · avg ${avg} · p95 ${p95} · max ${sorted[n - 1]}`,
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
    apiLatencies: [],
    lastUpdate: null,
    events: [], // { sequence, type, minute } — newest first, capped
    history: [], // merged odds series [{ sequence, probs…, odds…, latency_us, live }] sorted ASC
    fairness: [],
    commitment: null,
    seed: null,
    verifyStatus: 'unverified', // unverified | verified | failed
    matches: [],
    health: null,
    healthAt: null,
    submissions: [], // client-observed POST outcomes, newest first
    selectedSeq: null,
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
        events: [], history: [], fairness: [], commitment: null,
        seed: null, verifyStatus: 'unverified', selectedSeq: null,
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
      state.odds = normalizeOdds(msg.odds);
      state.sequence = msg.sequence;
      state.lastUpdate = msg.timestamp ?? new Date().toISOString();
      if (typeof msg.processing_latency_us === 'number') {
        state.latencyUs = msg.processing_latency_us;
        state.latencies = [...state.latencies, msg.processing_latency_us].slice(-100);
      }
      state.verifyStatus = 'unverified';
      this.mergeLivePoint(msg);
      this.prependEvent({ sequence: msg.sequence, type: msg.event_type, minute: msg.state?.minute });
    },
    // mergeHistory replaces the persisted series; mergeLivePoint overlays a
    // frame only when its sequence is absent — WS and history never duplicate.
    setHistory(rows) {
      const seen = new Set(rows.map((r) => r.sequence));
      const liveOnly = state.history.filter((h) => h.live && !seen.has(h.sequence));
      state.history = [...rows.map((r) => ({ ...r, live: false })), ...liveOnly]
        .sort((a, b) => a.sequence - b.sequence);
      emit();
    },
    mergeLivePoint(msg) {
      if (!msg.odds || state.history.some((h) => h.sequence === msg.sequence)) return;
      const o = msg.odds;
      state.history = [...state.history, {
        sequence: msg.sequence,
        home_prob: o.home_prob, draw_prob: o.draw_prob, away_prob: o.away_prob,
        home_odds: o.home_odds ?? o.home_win, draw_odds: o.draw_odds ?? o.draw,
        away_odds: o.away_odds ?? o.away_win,
        latency_us: msg.processing_latency_us ?? null,
        live: true,
      }].sort((a, b) => a.sequence - b.sequence);
      emit();
    },
    recordRestLatency(us) {
      if (typeof us === 'number') {
        state.latencyUs = us;
        state.latencies = [...state.latencies, us].slice(-100);
        emit();
      }
    },
    recordApiLatency(ms) {
      state.apiLatencies = [...state.apiLatencies, Math.round(ms * 100) / 100].slice(-100);
      emit();
    },
    submit(entry) {
      state.submissions = [{ time: new Date().toISOString(), ...entry }, ...state.submissions].slice(0, 30);
      emit();
    },
    setEventHistory(events) {
      state.events = events
        .map((e) => ({ sequence: e.sequence, type: e.type, minute: e.payload?.minute ?? null, created_at: e.created_at, id: e.id }))
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, 50);
      emit();
    },
    prependEvent(entry) {
      state.events = [entry, ...state.events.filter((e) => e.sequence !== entry.sequence)].slice(0, 50);
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
    setMatches(matches) {
      state.matches = matches;
      emit();
    },
    setHealth(health) {
      state.health = health;
      state.healthAt = new Date().toISOString();
      emit();
    },
    selectSeq(seq) {
      state.selectedSeq = seq;
      emit();
    },
  };
}
