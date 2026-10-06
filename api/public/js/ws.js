// WebSocket manager for one match. Server-to-client stream with automatic
// reconnect: after a drop it refetches REST state, then resumes from the
// fresh snapshot plus subsequent live frames. No polling, no replay buffer.
export function connectMatch(matchId, handlers) {
  const { onSnapshot, onUpdate, onStatus, onRefetch } = handlers;
  let ws = null;
  let stopped = false;
  let firstConnect = true;
  let backoff = 1000;
  const MAX_BACKOFF = 10000;

  function open() {
    if (stopped) return;
    onStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/matches/${encodeURIComponent(matchId)}`);

    ws.onopen = () => {
      backoff = 1000;
      onStatus('connected');
      if (!firstConnect && onRefetch) onRefetch();
      firstConnect = false;
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg?.type === 'snapshot') onSnapshot(msg);
      else if (msg?.type === 'match_update') onUpdate(msg);
    };

    ws.onclose = () => {
      ws = null;
      if (stopped) return;
      onStatus('disconnected');
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    };

    ws.onerror = () => {
      try { ws?.close(); } catch { /* handled by onclose */ }
    };
  }

  open();

  return {
    close() {
      stopped = true;
      try { ws?.close(); } catch { /* already gone */ }
      ws = null;
    },
  };
}
