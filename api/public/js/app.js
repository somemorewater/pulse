// Console bootstrap: hash routing, match loading, scenario runs, polling.
import { api, timed, describeError } from './api.js';
import { connectMatch } from './ws.js';
import { createStore } from './state.js';
import { drawProbChart } from './charts.js';
import { SCENARIOS, runScenario } from './scenarios.js';
import {
  toast, setConnection, flashPipeline, renderOverview, renderLive,
  renderExplorer, renderFairness, fillPicker, initSimulator, initFairness,
} from './ui.js';

const store = createStore();
let wsHandle = null;
let currentView = 'overview';
const $ = (id) => document.getElementById(id);

function showView(name) {
  currentView = name;
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.hidden = el.dataset.view !== name;
  });
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === name);
  });
  render();
}

function render() {
  const s = store.state;
  if (currentView === 'overview') renderOverview(s);
  else if (currentView === 'live') renderLive(s);
  else if (currentView === 'events') { renderLivePickerOnly(); renderExplorer(s); }
  else if (currentView === 'fairness') renderFairness(s);
}

function renderLivePickerOnly() {
  // Explorer/fairness need a loaded match; picker lives in Live view.
}

store.subscribe(() => render());
initSimulator(store, (matchId, event) => timed(() => api.submitEvent(matchId, event)));
initFairness(store);

async function refreshMatches() {
  try {
    const res = await api.listMatches();
    store.setMatches(res.matches);
  } catch (err) {
    toast(describeError(err), true);
  }
}

async function loadMatch(matchId, commitment) {
  if (wsHandle) {
    wsHandle.close();
    wsHandle = null;
  }
  store.reset(matchId);
  try {
    const [detail, eventsRes, fairnessRes, historyRes] = await Promise.all([
      api.getMatch(matchId),
      api.getEvents(matchId),
      api.getFairness(matchId),
      api.oddsHistory(matchId),
    ]);
    store.applySnapshot({ state: detail.match, odds: detail.odds, sequence: detail.sequence, timestamp: new Date().toISOString() });
    store.setEventHistory(eventsRes.events);
    store.setFairness(fairnessRes.fairness, commitment);
    store.setHistory(historyRes.history);
  } catch (err) {
    toast(describeError(err), true);
    return;
  }

  wsHandle = connectMatch(matchId, {
    onSnapshot: (msg) => {
      store.applySnapshot(msg);
      flashPipeline();
    },
    onUpdate: (msg) => {
      store.applyUpdate(msg);
      flashPipeline();
    },
    onStatus: (status) => setConnection(status),
    onRefetch: async () => {
      try {
        const detail = await api.getMatch(matchId);
        const [eventsRes, fairnessRes, historyRes] = await Promise.all([
          api.getEvents(matchId),
          api.getFairness(matchId),
          api.oddsHistory(matchId),
        ]);
        store.applySnapshot({ state: detail.match, odds: detail.odds, sequence: detail.sequence, timestamp: new Date().toISOString() });
        store.setEventHistory(eventsRes.events);
        store.setFairness(fairnessRes.fairness, store.state.commitment);
        store.setHistory(historyRes.history);
      } catch (err) {
        toast(describeError(err), true);
      }
    },
  });
}

window.__pulseSelectSeq = (seq) => store.selectSeq(seq);

async function pollHealth() {
  try {
    store.setHealth(await api.health());
  } catch {
    store.setHealth({ status: 'down', dependencies: { api: false, engine: false, postgres: false, redis: false } });
  }
}

// ---------- scenarios ----------

function initScenarios() {
  $('sc-picker').innerHTML = SCENARIOS.map((s) => `<option value="${s.id}">${s.name} — ${s.blurb}</option>`).join('');
  document.querySelectorAll('input[name="sc-target"]').forEach((r) =>
    r.addEventListener('change', () => {
      const isNew = document.querySelector('input[name="sc-target"]:checked').value === 'new';
      $('sc-new-form').hidden = !isNew;
      $('sc-existing-form').hidden = isNew;
    }));
  $('sc-run').addEventListener('click', async () => {
    const btn = $('sc-run');
    if (btn.disabled) return;
    const sc = SCENARIOS.find((x) => x.id === $('sc-picker').value);
    const log = $('sc-log');
    const useNew = document.querySelector('input[name="sc-target"]:checked').value === 'new';
    btn.disabled = true;
    log.innerHTML = '';
    $('sc-result').textContent = '';
    const step = (text, newest) => {
      const li = document.createElement('li');
      if (newest) li.className = 'newest';
      li.textContent = text;
      log.prepend(li);
    };
    try {
      let matchId;
      let startSeq;
      if (useNew) {
        const home = $('sc-home').value.trim() || 'Home';
        const away = $('sc-away').value.trim() || 'Away';
        step(`creating ${home} vs ${away}…`);
        const { data, ms } = await timed(() => api.createMatch(home, away));
        store.recordApiLatency(ms);
        matchId = data.match.match_id;
        startSeq = 0;
        step(`match ${matchId} created (commitment ${data.commitment.slice(0, 12)}…)`, true);
        await refreshMatches();
      } else {
        matchId = $('sc-match-picker').value;
        if (!matchId) {
          toast('Select an existing match first.', true);
          btn.disabled = false;
          return;
        }
        const detail = await api.getMatch(matchId);
        startSeq = detail.sequence;
        step(`using ${matchId} from seq ${startSeq}`, true);
      }
      step(`running "${sc.name}" (${sc.steps.length} steps)…`);
      const res = await runScenario(api, store, matchId, startSeq, sc,
        ({ i, total, step: st, ok, message }) => step(`step ${i + 1}/${total} ${st.type}: ${message}`, true));
      if (!res.ok) {
        $('sc-result').textContent = `Aborted at step ${res.failedStep + 1}. No further steps executed; nothing is claimed beyond the accepted events above.`;
      } else {
        $('sc-result').textContent = `Scenario complete: ${res.lastSequence - startSeq} events accepted on ${matchId}.`;
        const h = await api.oddsHistory(matchId);
        drawProbChart($('sc-chart'), h.history);
        if (store.state.matchId === matchId) {
          const detail = await api.getMatch(matchId);
          store.setHistory(h.history);
          store.applySnapshot({ state: detail.match, odds: detail.odds, sequence: detail.sequence, timestamp: new Date().toISOString() });
        }
      }
      await refreshMatches();
    } catch (err) {
      step(`failed: ${describeError(err)}`, true);
      $('sc-result').textContent = 'Scenario did not complete.';
    } finally {
      btn.disabled = false;
    }
  });
}

function syncScenarioPickers() {
  fillPicker($('sc-match-picker'), store.state.matches, null);
}

// ---------- wiring ----------

$('match-picker').addEventListener('change', (e) => {
  if (e.target.value) location.hash = `#/live/${encodeURIComponent(e.target.value)}`;
});
$('refresh-matches').addEventListener('click', refreshMatches);

$('create-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const home = $('home-team').value.trim();
  const away = $('away-team').value.trim();
  try {
    const { data, ms } = await timed(() => api.createMatch(home, away));
    store.recordApiLatency(ms);
    toast(`Match created: ${home} vs ${away}`);
    await refreshMatches();
    location.hash = `#/live/${encodeURIComponent(data.match.match_id)}`;
  } catch (err) {
    if (err.elapsedMs !== undefined) store.recordApiLatency(err.elapsedMs);
    toast(describeError(err), true);
  }
});

function route() {
  const h = location.hash || '#/overview';
  const live = h.match(/^#\/live\/(.+)$/);
  if (live) {
    const id = decodeURIComponent(live[1]);
    showView('live');
    if (id !== store.state.matchId) loadMatch(id);
    return;
  }
  const name = { '#/overview': 'overview', '#/live': 'live', '#/scenarios': 'scenarios', '#/events': 'events', '#/fairness': 'fairness' }[h] ?? 'overview';
  showView(name);
  if ((name === 'live' || name === 'events' || name === 'fairness') && !store.state.matchId && store.state.matches.length > 0) {
    loadMatch(store.state.matches[0].match_id);
  }
}
window.addEventListener('hashchange', route);

store.subscribe((s) => {
  if (currentView === 'scenarios') syncScenarioPickers();
});

initScenarios();
setConnection('disconnected');
refreshMatches().then(() => {
  const m = location.hash.match(/^#m=(.+)$/); // legacy deep link
  if (m) location.hash = `#/live/${m[1]}`;
  else route();
});
pollHealth();
setInterval(pollHealth, 10000);
