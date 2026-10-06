// Read models. PostgreSQL is the durable source of truth; Redis hot keys
// are a fast path with PG fallback. Writes go through the Go engine only.
import { pgPool, redisClient } from './db.js';
import { notFound, unavailable } from '../lib/errors.js';

function toMatch(row) {
  return {
    match_id: row.id,
    home_team: row.home_team,
    away_team: row.away_team,
    home_score: row.home_score,
    away_score: row.away_score,
    minute: row.current_minute,
    status: row.status,
    sequence: Number(row.last_sequence),
    home_reds: row.home_reds,
    away_reds: row.away_reds,
    home_yellows: row.home_yellows,
    away_yellows: row.away_yellows,
  };
}

function pgDown(err) {
  const msg = String(err?.message ?? err);
  if (/connect|ECONNREFUSED|timeout|terminat/i.test(msg)) throw unavailable('database unavailable');
  throw err;
}

export async function getMatchRow(matchId) {
  try {
    const { rows } = await pgPool().query(
      `SELECT id, home_team, away_team, home_score, away_score, current_minute,
              status, last_sequence, home_reds, away_reds, home_yellows, away_yellows
       FROM matches WHERE id = $1`,
      [matchId],
    );
    if (rows.length === 0) throw notFound('match not found');
    return toMatch(rows[0]);
  } catch (err) {
    if (err.status) throw err;
    throw pgDown(err);
  }
}

// Hot match snapshot, null when Redis is down or the key is absent.
export async function getHotState(matchId) {
  const rd = redisClient();
  if (!rd) return null;
  try {
    const raw = await rd.get(`pulse:match:${matchId}:state`);
    if (!raw) return null;
    const s = JSON.parse(raw);
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
  } catch {
    return null;
  }
}

export async function getHotOdds(matchId) {
  const rd = redisClient();
  if (!rd) return null;
  try {
    const raw = await rd.get(`pulse:match:${matchId}:odds`);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return {
      sequence: o.sequence,
      home_prob: o.home_prob, draw_prob: o.draw_prob, away_prob: o.away_prob,
      home_odds: o.home_odds, draw_odds: o.draw_odds, away_odds: o.away_odds,
    };
  } catch {
    return null;
  }
}

export async function getLatestOddsRow(matchId) {
  try {
    const { rows } = await pgPool().query(
      `SELECT sequence, home_probability, draw_probability, away_probability,
              home_odds, draw_odds, away_odds
       FROM odds_snapshots WHERE match_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [matchId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      sequence: Number(r.sequence),
      home_prob: r.home_probability, draw_prob: r.draw_probability, away_prob: r.away_probability,
      home_odds: r.home_odds, draw_odds: r.draw_odds, away_odds: r.away_odds,
    };
  } catch (err) {
    throw pgDown(err);
  }
}

export async function listEvents(matchId, limit = 100) {
  await getMatchRow(matchId); // 404 when unknown
  try {
    const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
    const { rows } = await pgPool().query(
      `SELECT id, match_id, sequence, type, payload, created_at
       FROM events WHERE match_id = $1 ORDER BY sequence ASC LIMIT $2`,
      [matchId, n],
    );
    return rows.map((r) => ({
      id: r.id,
      match_id: r.match_id,
      sequence: Number(r.sequence),
      type: r.type,
      payload: r.payload,
      created_at: r.created_at,
    }));
  } catch (err) {
    if (err.status) throw err;
    throw pgDown(err);
  }
}

export async function listFairness(matchId) {
  await getMatchRow(matchId); // 404 when unknown
  try {
    const { rows } = await pgPool().query(
      `SELECT sequence, market, commitment, generated_value, algorithm_version,
              revealed_at, created_at
       FROM fairness_commitments WHERE match_id = $1 ORDER BY sequence ASC, market ASC`,
      [matchId],
    );
    return rows.map((r) => ({
      match_id: matchId,
      sequence: Number(r.sequence),
      market: r.market,
      commitment: r.commitment,
      generated_value: r.generated_value,
      algorithm_version: r.algorithm_version,
      revealed_at: r.revealed_at,
      created_at: r.created_at,
    }));
  } catch (err) {
    if (err.status) throw err;
    throw pgDown(err);
  }
}
