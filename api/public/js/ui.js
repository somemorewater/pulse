// View bindings for the console. Subscribes to the store and renders each
// visible view; owns no networking except through injected api callbacks.
import { api, describeError } from './api.js';
import { eventLabel, describeSamples } from './state.js';
import { drawProbChart } from './charts.js';

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
  if (!dot) return;
  dot.classList.add('flash');
  setTimeout(() => dot.classList.remove('flash'), 400);
}

function statusPill(status) {
  return `<span class="pill${status === 'live' ? ' live' : status === 'finished' ? ' finished' : ''}">${status}</span>`;
}

// ---------- overview ----------

export function renderOverview(s) {
  const hc = $('health-cards');
  if (!s.health) {
    hc.innerHTML = '<p class="muted">Checking…</p>';
  } else {
    const deps = s.health.dependencies ?? {};
    const card = (name, ok, extra = '') =>
      `<div class="hcard ${ok ? 'ok' : 'down'}"><strong>${name}</strong>${ok ? 'ok' : 'DOWN'}${extra}</div>`;
    const ws = s.health.websocket;
    hc.innerHTML =
      card('api', deps.api) + card('go engine', deps.engine) +
      card('postgres', deps.postgres) + card('redis', deps.redis) +
      (ws ? card('websocket', true, ` · ${ws.connections} conn / ${ws.subscriptions} sub`) : '');
    $('health-age').textContent = s.healthAt ? `(checked ${new Date(s.healthAt).toLocaleTimeString()})` : '';
  }

  const issues = [];
  if (s.health && s.health.status !== 'ok') {
    const deps = s.health.dependencies ?? {};
    Object.entries(deps).forEach(([k, v]) => {
      if (!v) issues.push({ bad: true, text: `${k} is unreachable — check that service and env URLs.` });
    });
  }
  s.submissions.filter((x) => x.outcome.startsWith('failed')).slice(0, 5).forEach((x) =>
    issues.push({ bad: false, text: `${x.event} on ${x.matchId}: ${x.outcome}` }));
  $('recent-issues').innerHTML = issues.length === 0
    ? '<p class="muted">No issues observed.</p>'
    : issues.map((i) => `<div class="issue${i.bad ? ' bad' : ''}">${i.text}</div>`).join('');

  const box = $('overview-matches');
  if (s.matches.length === 0) {
    box.innerHTML = '<p class="muted">No matches yet — create one in Live Matches.</p>';
  } else {
    box.innerHTML = s.matches.map((m) =>
      `<div class="issue" style="border-color:var(--line);background:#fafbfc">
        <a href="#/live/${m.match_id}">${m.home_team} vs ${m.away_team}</a>
        ${statusPill(m.status)} ${m.home_score}–${m.away_score} · ${m.minute}′ · seq ${m.sequence}
      </div>`).join('');
  }
}

// ---------- live matches ----------

export function fillPicker(sel, matches, current) {
  sel.innerHTML = '<option value="">— select —</option>' + matches.map((m) =>
    `<option value="${m.match_id}"${m.match_id === current ? ' selected' : ''}>${m.home_team} vs ${m.away_team} (${m.status}, seq ${m.sequence})</option>`).join('');
}

function gateSimulator(s) {
  const status = s.match?.status;
  const btns = [...document.querySelectorAll('#sim-buttons button')];
  const note = $('sim-note');
  btns.forEach((b) => {
    const ev = b.dataset.ev;
    if (!status) b.disabled = true;
    else if (status === 'scheduled') b.disabled = ev !== 'match_start';
    else if (status === 'finished') b.disabled = true;
    else b.disabled = ev === 'match_start';
  });
  note.textContent = !status ? ''
    : status === 'scheduled' ? 'Only Start works before kickoff.'
    : status === 'finished' ? 'Match finished — create a new match to continue experimenting.'
    : '';
}

export function renderLive(s) {
  fillPicker($('match-picker'), s.matches, s.matchId);
  const has = !!s.match;
  $('live-empty').hidden = has;
  $('live-detail').hidden = !has;
  $('odds-panel').hidden = !has;
  $('sim-panel').hidden = !has;
  if (!has) return;

  const m = s.match;
  const pill = $('status-pill');
  pill.textContent = m.status;
  pill.className = 'pill' + (m.status === 'live' ? ' live' : m.status === 'finished' ? ' finished' : '');
  $('seq').textContent = s.sequence;
  $('home-name').textContent = m.home_team;
  $('away-name').textContent = m.away_team;
  $('home-score').textContent = m.home_score;
  $('away-score').textContent = m.away_score;
  $('minute').textContent = m.minute;
  $('updated-at').textContent = s.lastUpdate ? new Date(s.lastUpdate).toLocaleTimeString() : '—';

  $('odds-home').textContent = fmtOdds(s.odds?.home_win);
  $('odds-draw').textContent = fmtOdds(s.odds?.draw);
  $('odds-away').textContent = fmtOdds(s.odds?.away_win);
  $('prob-home').textContent = s.odds ? `${(s.odds.home_prob * 100).toFixed(1)}%` : '';
  $('prob-draw').textContent = s.odds ? `${(s.odds.draw_prob * 100).toFixed(1)}%` : '';
  $('prob-away').textContent = s.odds ? `${(s.odds.away_prob * 100).toFixed(1)}%` : '';
  $('prob-bars').innerHTML = s.odds ? [['1', s.odds.home_prob], ['X', s.odds.draw_prob], ['2', s.odds.away_prob]]
    .map(([k, p]) => `<div class="bar-row"><span>${k}</span><div class="bar-track"><div class="bar-fill" style="width:${(p * 100).toFixed(1)}%"></div></div><span>${(p * 100).toFixed(1)}%</span></div>`).join('') : '';

  const h = s.history;
  if (h.length >= 2) {
    const a = h[h.length - 2];
    const b = h[h.length - 1];
    const d = ((b.home_prob - a.home_prob) * 100).toFixed(1);
    const cause = s.events.find((e) => e.sequence === b.sequence);
    $('odds-delta').textContent =
      `Latest: home ${(a.home_prob * 100).toFixed(1)}% → ${(b.home_prob * 100).toFixed(1)}% (${d > 0 ? '+' : ''}${d}pp)` +
      (cause ? ` after ${eventLabel(cause.type)} (#${cause.sequence}).` : '.');
  } else {
    $('odds-delta').textContent = 'No movement yet.';
  }
  drawProbChart($('odds-chart'), h);

  gateSimulator(s);

  $('lat-last').textContent = fmtLatency(s.latencyUs);
  const eng = describeSamples(s.latencies);
  $('lat-stats').textContent = eng.n === 0 ? 'unavailable' : `${eng.text} µs over ${eng.n} event(s)`;
  const lastApi = s.apiLatencies[s.apiLatencies.length - 1];
  $('api-last').textContent = lastApi === undefined ? 'unavailable' : `${lastApi} ms`;
  const apiS = describeSamples(s.apiLatencies);
  $('api-stats').textContent = apiS.n === 0 ? 'unavailable' : `${apiS.text} ms over ${apiS.n} request(s)`;

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
    li.innerHTML = `<span class="min">${e.minute ?? '—'}${e.minute === null || e.minute === undefined ? '' : "'"}</span>` +
      `<span>${eventLabel(e.type)}</span><span class="seqn">seq ${e.sequence}</span>`;
    feed.appendChild(li);
  });
}

// Simulator: builds the next event from local state and POSTs it.
// Live state itself always arrives back through the WebSocket.
export function initSimulator(store, timedSubmit) {
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
      const { data, ms } = await timedSubmit(s.matchId, event);
      store.recordRestLatency(data.processing_latency_us);
      store.recordApiLatency(ms);
      store.submit({ matchId: s.matchId, seq: data.sequence, event: `${type} #${event.sequence}`, outcome: `accepted (seq ${data.sequence})` });
    } catch (err) {
      if (err.elapsedMs !== undefined) store.recordApiLatency(err.elapsedMs);
      store.submit({ matchId: s.matchId, seq: event.sequence, event: `${type} #${event.sequence}`, outcome: `failed: ${err?.code ?? err?.status ?? 'error'}` });
      toast(describeError(err), true);
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- event explorer ----------

export function renderExplorer(s) {
  const tb = $('explorer-rows');
  tb.innerHTML = '';
  if (s.events.length === 0) {
    tb.innerHTML = '<tr><td colspan="6" class="muted">No events for this match yet.</td></tr>';
  }
  [...s.events].sort((a, b) => a.sequence - b.sequence).forEach((e) => {
    const snap = s.history.find((h) => h.sequence === e.sequence);
    const sub = s.submissions.find((x) => x.matchId === s.matchId && x.seq === e.sequence);
    const failed = sub && sub.outcome.startsWith('failed');
    const tr = document.createElement('tr');
    if (e.sequence === s.selectedSeq) tr.className = 'selected';
    else if (failed) tr.className = 'failed';
    tr.innerHTML = `<td>${e.sequence}</td><td>${e.created_at ? new Date(e.created_at).toLocaleTimeString() : 'live'}</td>` +
      `<td>${eventLabel(e.type)}</td><td>${e.minute ?? '—'}</td>` +
      `<td>${snap?.latency_us !== undefined && snap?.latency_us !== null ? snap.latency_us + ' µs' : '—'}</td>` +
      `<td>${failed ? sub.outcome : 'accepted'}</td>`;
    tr.addEventListener('click', () => window.__pulseSelectSeq(e.sequence));
    tb.appendChild(tr);
  });

  const box = $('event-detail');
  const sel = s.events.find((e) => e.sequence === s.selectedSeq);
  if (!sel) {
    box.innerHTML = '<p class="muted">Select an event.</p>';
  } else {
    const snap = s.history.find((h) => h.sequence === sel.sequence);
    const fair = s.fairness.filter((r) => r.sequence === sel.sequence);
    box.innerHTML =
      `<p><strong>${eventLabel(sel.type)}</strong> · seq ${sel.sequence} · id <code>${sel.id ?? '—'}</code></p>` +
      `<pre class="detail">payload: ${JSON.stringify(sel.minute !== undefined ? { minute: sel.minute } : {}, null, 1)}` +
      (snap ? `\nodds: H ${snap.home_odds?.toFixed?.(2) ?? snap.home_odds} · D ${snap.draw_odds?.toFixed?.(2) ?? snap.draw_odds} · A ${snap.away_odds?.toFixed?.(2) ?? snap.away_odds}` : '\nodds: snapshot unavailable') +
      (fair.length > 0 ? `\nfairness: ${fair.map((r) => `${r.market}=${Number(r.generated_value ?? r.value).toFixed(4)}`).join(' ')}` : '') + '</pre>';
  }

  const log = $('submission-log');
  log.innerHTML = s.submissions.length === 0 ? '<li class="empty">No submissions yet.</li>' : '';
  s.submissions.slice(0, 15).forEach((x) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${x.event}</span><span class="seqn">${x.outcome}</span>`;
    log.appendChild(li);
  });
}

// ---------- fairness ----------

export function renderFairness(s) {
  $('fair-commitment').textContent = s.commitment ?? '—';
  const latestFair = s.fairness.length > 0 ? s.fairness[s.fairness.length - 1] : null;
  $('fair-algo').textContent = latestFair?.algorithm_version ?? 'pf-v1';
  $('fair-seq').textContent = latestFair ? latestFair.sequence : '—';
  const st = $('fair-status');
  st.textContent = s.verifyStatus === 'verified' ? 'Verified' : s.verifyStatus === 'failed' ? 'Verification failed' : 'unverified';
  st.className = s.verifyStatus === 'verified' ? 'verified' : s.verifyStatus === 'failed' ? 'failed' : '';
  $('fair-seed').hidden = !s.seed;
  if (s.seed) $('fair-seed-val').textContent = s.seed;
  const vs = $('verify-seq');
  if (vs && !vs.value && latestFair) vs.value = latestFair.sequence;
}

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
      const ok = results.every((r) => r.valid);
      store.setVerified(ok);
      toast(ok ? 'Verified against the revealed seed.' : 'Verification failed.', !ok);
    } catch (err) {
      store.setVerified(false);
      toast(describeError(err), true);
    }
  });
  $('verify-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const s = store.state;
    if (!s.seed) {
      toast('Reveal the seed first.', true);
      return;
    }
    try {
      const res = await api.verify(s.matchId, {
        sequence: Number($('verify-seq').value),
        market: $('verify-market').value,
        seed: s.seed,
      });
      store.setVerified(res.valid);
      toast(res.valid ? 'Verified against the revealed seed.' : 'Verification failed.', !res.valid);
    } catch (err) {
      store.setVerified(false);
      toast(describeError(err), true);
    }
  });
}
