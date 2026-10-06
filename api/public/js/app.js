// Bootstrap: match creation/selection, REST load, WebSocket live stream.
import { api, describeError } from './api.js';
import { connectMatch } from './ws.js';
import { createStore } from './state.js';
import { toast, setConnection, flashPipeline, renderDashboard, initSimulator, initFairness } from './ui.js';

const store = createStore();
let wsHandle = null;

store.subscribe((s) => renderDashboard(s));
initSimulator(store);
initFairness(store);

function showDashboard(show) {
  document.getElementById('dashboard').hidden = !show;
  document.getElementById('create-panel').hidden = show;
}

async function loadMatch(matchId, commitment) {
  if (wsHandle) {
    wsHandle.close();
    wsHandle = null;
  }
  store.reset(matchId);
  try {
    const [detail, eventsRes, fairnessRes] = await Promise.all([
      api.getMatch(matchId),
      api.getEvents(matchId),
      api.getFairness(matchId),
    ]);
    store.applySnapshot({ state: detail.match, odds: detail.odds, sequence: detail.sequence, timestamp: new Date().toISOString() });
    store.setEventHistory(eventsRes.events);
    store.setFairness(fairnessRes.fairness, commitment);
    if (location.hash !== `#m=${matchId}`) history.replaceState(null, '', `#m=${matchId}`);
  } catch (err) {
    toast(describeError(err), true);
    showDashboard(false);
    return;
  }
  showDashboard(true);

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
    // After a drop, REST is the recovery path: refresh, then live frames resume.
    onRefetch: async () => {
      try {
        const detail = await api.getMatch(matchId);
        const eventsRes = await api.getEvents(matchId);
        const fairnessRes = await api.getFairness(matchId);
        store.applySnapshot({ state: detail.match, odds: detail.odds, sequence: detail.sequence, timestamp: new Date().toISOString() });
        store.setEventHistory(eventsRes.events);
        store.setFairness(fairnessRes.fairness, store.state.commitment);
      } catch (err) {
        toast(describeError(err), true);
      }
    },
  });
}

document.getElementById('create-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const home = document.getElementById('home-team').value.trim();
  const away = document.getElementById('away-team').value.trim();
  try {
    const created = await api.createMatch(home, away);
    toast(`Match created: ${home} vs ${away}`);
    await loadMatch(created.match.match_id, created.commitment);
  } catch (err) {
    toast(describeError(err), true);
  }
});

// Deep link: #m=<match_id> loads an existing match on open.
const fromHash = location.hash.match(/^#m=(.+)$/);
if (fromHash) {
  loadMatch(decodeURIComponent(fromHash[1]));
}
setConnection('disconnected');
