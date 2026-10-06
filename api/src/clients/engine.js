// Thin HTTP client for the internal Go engine contract.
// Throws ApiError mapped from engine error codes; network failures -> 503.
import { ApiError, statusForEngineCode, unavailable } from '../lib/errors.js';

const TIMEOUT_MS = 10000;

async function call(engineUrl, path, body, method = 'POST') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${engineUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    throw unavailable('odds engine unreachable');
  } finally {
    clearTimeout(timer);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw unavailable('odds engine returned an invalid response');
  }
  if (!res.ok) {
    const code = data?.error?.code ?? 'unavailable';
    throw new ApiError(statusForEngineCode(code), code, data?.error?.message ?? 'engine error');
  }
  return data;
}

export function createEngineClient(engineUrl) {
  return {
    health: () => call(engineUrl, '/health', undefined, 'GET'),
    createMatch: (input) => call(engineUrl, '/internal/matches', input),
    processEvent: (matchId, event) => call(engineUrl, '/internal/events', { match_id: matchId, event }),
    verify: (input) => call(engineUrl, '/internal/fairness/verify', input),
    reveal: (matchId) => call(engineUrl, `/internal/matches/${encodeURIComponent(matchId)}/reveal`, {}),
  };
}
