// View bindings. Subscribes to the store and renders; owns no networking
// except through the injected api + submit callback from app.js.
import { api, describeError } from './api.js';
import { eventLabel } from './state.js';

const $ = (id) => document.getElementById(id);

export function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function fmtOdds(v) {
  if (v === null || v === undefined || v === 0) return '—';
  return Number(v).toFixed(2);
}

function fmtLatency(us) {
  if (us === null || us === undefined) return 'unavailable';
  return `${us} µs`;
}

export function setConnection(status) {
  const badge = $('conn-badge');
  badge.dataset.state = status;
  $('conn-text').textContent = status[0].toUpperCase() + status.slice(1);
}

export function flashPipeline() {
  const dot = $('pulse-dot');
  dot.classList.add('flash');
  setTimeout(() => dot.classList.remove('flash'), 400);
}

export function renderDashboard(s) {
  if (!s.match) return;
  const m = s.match;
  $('status-pill').textContent = m.status;
  $('status-pill').className = 'pill' + (m.status === 'live' ? ' live' : m.status === 'finished' ? ' finished' : '');
  $('seq').textContent = s.sequence;
  $('home-name').textContent = m.home_team;
  $('away-name').textContent = m.away_team;
  $('home-score').textContent = m.home_score;
  $('away-score').textContent = m.away_score;
  $('minute').textContent = m.minute;
  $('odds-home').textContent = fmtOdds(s.odds?.home_win);
  $('odds-draw').textContent = fmtOdds(s.odds?.draw);
  $('odds-away').textContent = fmtOdds(s.odds?.away_win);
  $('updated-at').textContent = s.lastUpdate ? new Date(s.lastUpdate).toLocaleTimeString() : '—';

  $('lat-last').textContent = fmtLatency(s.latencyUs);
  $('lat-n').textContent = s.latencies.length;
  if (s.latencies.length > 0) {
    $('lat-min').textContent = `${Math.min(...s.latencies)} µs`;
    $('lat-max').textContent = `${Math.max(...s.latencies)} µs`;
    $('lat-avg').textContent = `${Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length)} µs`;
  } else {
    $('lat-min').textContent = $('lat-avg').textContent = $('lat-max').textContent = '—';
  }

  const feed = $('feed');
  feed.innerHTML = '';
  if (s.events.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No events yet — start the match from the simulator.';
    feed.appendChild(li);
  }
  s.events.forEach((e, i) => {
    const li = document.createElement('li');
    if (i === 0) li.className = 'newest';
    const min = document.createElement('span');
    min.className = 'min';
    min.textContent = e.minute === null || e.minute === undefined ? '—' : `${e.minute}'`;
    const label = document.createElement('span');
    label.textContent = eventLabel(e.type);
    const seq = document.createElement('span');
    seq.className = 'seqn';
    seq.textContent = `seq ${e.sequence}`;
    li.append(min, label, seq);
    feed.appendChild(li);
  });

  $('fair-commitment').textContent = s.commitment ?? '—';
  const latestFair = s.fairness.length > 0 ? s.fairness[s.fairness.length - 1] : null;
  $('fair-algo').textContent = latestFair?.algorithm_version ?? 'pf-v1';
  $('fair-seq').textContent = latestFair ? latestFair.sequence : '—';
  const st = $('fair-status');
  st.textContent = s.verifyStatus === 'verified' ? 'Verified' : s.verifyStatus === 'failed' ? 'Verification failed' : 'unverified';
  st.className = s.verifyStatus === 'verified' ? 'verified' : s.verifyStatus === 'failed' ? 'failed' : '';
  $('fair-seed').hidden = !s.seed;
  if (s.seed) $('fair-seed-val').textContent = s.seed;
}

// Simulator: builds the next event from local state and POSTs it.
// Live state itself always arrives back through the WebSocket.
export function initSimulator(store) {
  $('sim-buttons').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-ev]');
    if (!btn || btn.disabled) return;
    const s = store.state;
    const type = btn.dataset.ev;
    const payload = {};
    if (type === 'minute_update') {
      const next = (s.match?.minute ?? 0) + Number(btn.dataset.min || 1);
      if (next > 120) {
        toast('Minute would exceed 120.', true);
        return;
      }
      payload.minute = next;
    } else if (type.startsWith('goal_') || type.startsWith('yellow_') || type.startsWith('red_')) {
      payload.minute = s.match?.minute ?? 0;
    }
    const event = {
      id: `evt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      type,
      sequence: s.sequence + 1,
      ...(Object.keys(payload).length > 0 ? { payload } : {}),
    };
    btn.disabled = true;
    try {
      const res = await api.submitEvent(s.matchId, event);
      store.recordRestLatency(res.processing_latency_us);
    } catch (err) {
      toast(describeError(err), true);
    } finally {
      btn.disabled = false;
    }
  });
}

// Fairness: reveal publishes the seed (intended stage); verify recomputes
// every market of the latest recorded sequence independently.
export function initFairness(store) {
  $('reveal-btn').addEventListener('click', async () => {
    try {
      const res = await api.revealSeed(store.state.matchId);
      store.setSeed(res.seed);
      $('verify-btn').disabled = false;
      toast('Seed revealed. You can now verify.');
    } catch (err) {
      toast(describeError(err), true);
    }
  });
  $('verify-btn').addEventListener('click', async () => {
    const s = store.state;
    if (!s.seed) {
      toast('Reveal the seed first.', true);
      return;
    }
    if (s.fairness.length === 0) {
      toast('No fairness records yet — process an event first.', true);
      return;
    }
    const latest = Math.max(...s.fairness.map((r) => r.sequence));
    try {
      const results = await Promise.all(
        ['1', 'X', '2'].map((market) => api.verify(s.matchId, { sequence: latest, market, seed: s.seed })),
      );
      store.setVerified(results.every((r) => r.valid));
      toast(results.every((r) => r.valid) ? 'Verified against the revealed seed.' : 'Verification failed.', !results.every((r) => r.valid));
    } catch (err) {
      store.setVerified(false);
      toast(describeError(err), true);
    }
  });
}
