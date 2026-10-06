// Match-level subscription manager.
//
// One Redis subscription per match, fanned out to N WebSocket clients:
//
//   match ID -> one Redis SUBSCRIBE -> many sockets
//
// The entry (and its Redis subscription) is removed when the last client
// leaves. Redis Pub/Sub preserves publish order per channel to a single
// subscriber, and this hub forwards in arrival order without reordering;
// every message carries `sequence` so clients can detect gaps. There is
// deliberately no replay buffer: reconnecting clients recover via
// GET /api/matches/:id and continue from live updates.
import { createClient } from 'redis';

const WS_OPEN = 1;

function channelFor(matchId) {
  return `pulse:match:${matchId}:updates`;
}

function toState(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    match_id: s.MatchID ?? s.match_id,
    home_team: s.HomeTeam ?? s.home_team,
    away_team: s.AwayTeam ?? s.away_team,
    home_score: s.HomeScore ?? s.home_score,
    away_score: s.AwayScore ?? s.away_score,
    minute: s.Minute ?? s.minute,
    status: s.Status ?? s.status,
    sequence: s.Sequence ?? s.sequence,
    home_reds: s.HomeReds ?? s.home_reds ?? 0,
    away_reds: s.AwayReds ?? s.away_reds ?? 0,
    home_yellows: s.HomeYellows ?? s.home_yellows ?? 0,
    away_yellows: s.AwayYellows ?? s.away_yellows ?? 0,
  };
}

// Translate the internal Go update into the versioned client contract.
// The gateway owns this shape; Go's internal format stays untouched.
function toClientMessage(update) {
  const o = update.odds ?? {};
  return {
    v: 1,
    type: 'match_update',
    match_id: update.match_id,
    sequence: update.sequence,
    event_type: update.event_type,
    state: toState(update.state),
    odds: {
      home_win: o.home_odds,
      draw: o.draw_odds,
      away_win: o.away_odds,
      home_prob: o.home_prob,
      draw_prob: o.draw_prob,
      away_prob: o.away_prob,
    },
    processing_latency_us: update.processing_latency_us ?? null,
    timestamp: update.published_at ?? new Date().toISOString(),
  };
}

export function createHub({ redisUrl, log }) {
  const subs = new Map(); // matchId -> { clients: Set<ws>, lastSeq }
  const stats = {
    connections: 0,
    messages_broadcast: 0,
    redis_errors: 0,
  };

  const subscriber = createClient({ url: redisUrl });
  subscriber.on('error', (err) => {
    stats.redis_errors += 1;
    log?.warn({ err: String(err?.message ?? err) }, 'ws subscriber redis error');
  });

  let ready = false;
  const readyP = subscriber.connect().then(() => { ready = true; }).catch((err) => {
    stats.redis_errors += 1;
    log?.error({ err: String(err?.message ?? err) }, 'ws subscriber connect failed');
  });

  function broadcast(matchId, raw) {
    const entry = subs.get(matchId);
    if (!entry) return; // nobody listening; drop (durable history stays in PG)
    let update;
    try {
      update = JSON.parse(raw);
    } catch {
      stats.redis_errors += 1;
      return; // malformed payload must never reach clients
    }
    if (!update || typeof update.sequence !== 'number') return;
    entry.lastSeq = update.sequence;
    const body = JSON.stringify(toClientMessage(update));
    for (const ws of entry.clients) {
      try {
        if (ws.readyState === WS_OPEN) {
          ws.send(body);
          stats.messages_broadcast += 1;
        }
      } catch {
        // A single broken socket must not break the fan-out.
      }
    }
  }

  return {
    async attach(matchId, ws) {
      await readyP;
      let entry = subs.get(matchId);
      if (!entry) {
        entry = { clients: new Set(), lastSeq: null };
        subs.set(matchId, entry);
        if (ready) {
          try {
            await subscriber.subscribe(channelFor(matchId), (msg) => broadcast(matchId, msg));
          } catch (err) {
            stats.redis_errors += 1;
            subs.delete(matchId);
            throw err;
          }
        }
      }
      entry.clients.add(ws);
      stats.connections += 1;
    },

    async detach(matchId, ws) {
      const entry = subs.get(matchId);
      if (!entry) return;
      if (entry.clients.delete(ws) && stats.connections > 0) {
        stats.connections -= 1;
      }
      if (entry.clients.size === 0) {
        subs.delete(matchId);
        if (ready) {
          try {
            await subscriber.unsubscribe(channelFor(matchId));
          } catch (err) {
            stats.redis_errors += 1;
            log?.warn({ err: String(err?.message ?? err) }, 'ws unsubscribe failed');
          }
        }
      }
    },

    stats() {
      return {
        connections: stats.connections,
        subscriptions: subs.size,
        messages_broadcast: stats.messages_broadcast,
        redis_errors: stats.redis_errors,
      };
    },

    async close() {
      for (const [matchId, entry] of subs) {
        for (const ws of entry.clients) {
          try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
        }
        subs.delete(matchId);
      }
      stats.connections = 0;
      try { await subscriber.quit(); } catch { /* shutting down */ }
    },
  };
}
