// REST client. Same-origin: the dashboard is served by the API itself.
// Throws Error with { status, code, message } parsed from the API envelope.
async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...options,
    });
  } catch {
    const err = new Error('API unavailable');
    err.status = 503;
    err.code = 'unavailable';
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.error?.code ?? 'unknown';
    throw err;
  }
  return data;
}

const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  createMatch: (homeTeam, awayTeam) => post('/api/matches', { home_team: homeTeam, away_team: awayTeam }),
  listMatches: (limit = 50) => request(`/api/matches?limit=${limit}`),
  getMatch: (id) => request(`/api/matches/${encodeURIComponent(id)}`),
  getEvents: (id, limit = 100) => request(`/api/matches/${encodeURIComponent(id)}/events?limit=${limit}`),
  getFairness: (id) => request(`/api/matches/${encodeURIComponent(id)}/fairness`),
  oddsHistory: (id, limit = 200) => request(`/api/matches/${encodeURIComponent(id)}/odds/history?limit=${limit}`),
  health: () => request('/health'),
  submitEvent: (id, event) => post(`/api/matches/${encodeURIComponent(id)}/events`, event),
  revealSeed: (id) => post(`/api/matches/${encodeURIComponent(id)}/fairness/reveal`, {}),
  verify: (id, input) => post(`/api/matches/${encodeURIComponent(id)}/fairness/verify`, input),
};

// timed runs fn and reports this client's round-trip milliseconds alongside
// the result — the honest counterpart to the engine's processing_latency_us.
export async function timed(fn) {
  const t0 = performance.now();
  try {
    return { data: await fn(), ms: performance.now() - t0 };
  } catch (err) {
    err.elapsedMs = performance.now() - t0;
    throw err;
  }
}

export function describeError(err) {
  if (err?.status === 409) return 'Duplicate event: already processed.';
  if (err?.status === 422) return 'Invalid transition for the current match state.';
  if (err?.status === 404) return 'Match not found.';
  if (err?.status === 410) return 'This match predates restart recovery and cannot take new events. Create a new match — its history stays readable.';
  if (err?.status === 503) return 'API or engine unavailable. Is everything running?';
  return err?.message ?? 'Request failed.';
}
