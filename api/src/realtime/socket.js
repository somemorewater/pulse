// WebSocket endpoint: server-to-client live updates for one match.
//
// On connect the server first sends the current snapshot (so the client
// never waits for the next event), then streams `match_update` frames.
// Client messages are optional: `{ "type": "ping" }` gets a pong, anything
// else is ignored. Malformed input can never crash the server.
import { validateMatchId } from '../schemas/index.js';

const WS_OPEN = 1;

function send(ws, obj) {
  try {
    if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj));
  } catch {
    // Socket went away mid-send; close handler cleans up.
  }
}

export function createSocketHandler({ hub, queryService, log }) {
  return async (socket, req) => {
    let matchId;
    try {
      matchId = validateMatchId(req.params.id);
    } catch {
      try { socket.close(1008, 'invalid match id'); } catch { /* ignore */ }
      return;
    }

    // Snapshot first: also proves the match exists (404 -> close, no leak
    // of internal errors to the client).
    let detail;
    try {
      detail = await queryService.matchDetail(matchId);
    } catch (err) {
      const code = err?.status === 404 ? 1008 : 1011;
      try { socket.close(code, err?.status === 404 ? 'match not found' : 'internal error'); } catch { /* ignore */ }
      return;
    }

    send(socket, {
      v: 1,
      type: 'snapshot',
      match_id: matchId,
      sequence: detail.sequence,
      state: detail.match,
      odds: detail.odds ? {
        home_win: detail.odds.home_odds,
        draw: detail.odds.draw_odds,
        away_win: detail.odds.away_odds,
        home_prob: detail.odds.home_prob,
        draw_prob: detail.odds.draw_prob,
        away_prob: detail.odds.away_prob,
      } : null,
      timestamp: new Date().toISOString(),
    });

    try {
      await hub.attach(matchId, socket);
    } catch (err) {
      log?.error({ err: String(err?.message ?? err) }, 'ws attach failed');
      try { socket.close(1011, 'subscription unavailable'); } catch { /* ignore */ }
      return;
    }

    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return; // ignore malformed frames
      }
      if (msg && msg.type === 'ping') send(socket, { v: 1, type: 'pong' });
    };
    const onDone = () => {
      try { socket.off('message', onMessage); } catch { /* ignore */ }
      hub.detach(matchId, socket).catch(() => {});
    };

    socket.on('message', onMessage);
    socket.on('close', onDone);
    socket.on('error', () => {
      try { socket.close(1011, 'socket error'); } catch { /* ignore */ }
    });
  };
}
