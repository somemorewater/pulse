// API-boundary validation. Rejects untrusted input before it reaches the
// engine. Odds, probabilities, latency and match state are never accepted
// from clients — the Go engine is authoritative for all of those.
import { badRequest } from '../lib/errors.js';

export const EVENT_TYPES = [
  'goal_home',
  'goal_away',
  'yellow_card_home',
  'yellow_card_away',
  'red_card_home',
  'red_card_away',
  'minute_update',
  'match_start',
  'match_end',
];

export const MARKETS = ['1', 'X', '2'];

function assertString(value, name, max = 64) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${name} is required`);
  }
  if (value.length > max) {
    throw badRequest(`${name} must be ${max} chars or fewer`);
  }
  return value.trim();
}

export function validateCreateMatch(body) {
  if (!body || typeof body !== 'object') throw badRequest('body must be JSON');
  return {
    home_team: assertString(body.home_team, 'home_team'),
    away_team: assertString(body.away_team, 'away_team'),
  };
}

export function validateEvent(body) {
  if (!body || typeof body !== 'object') throw badRequest('body must be JSON');
  const id = assertString(body.id, 'id', 128);
  if (typeof body.type !== 'string' || !EVENT_TYPES.includes(body.type)) {
    throw badRequest(`type must be one of: ${EVENT_TYPES.join(', ')}`);
  }
  if (!Number.isInteger(body.sequence) || body.sequence <= 0) {
    throw badRequest('sequence must be a positive integer');
  }
  let payload;
  if (body.payload !== undefined) {
    if (!body.payload || typeof body.payload !== 'object') throw badRequest('payload must be an object');
    const { minute, player, detail } = body.payload;
    payload = {};
    if (minute !== undefined) {
      if (!Number.isInteger(minute) || minute < 0 || minute > 120) {
        throw badRequest('payload.minute must be 0-120');
      }
      payload.minute = minute;
    }
    if (player !== undefined) {
      if (typeof player !== 'string' || player.length > 128) throw badRequest('payload.player must be a short string');
      payload.player = player;
    }
    if (detail !== undefined) {
      if (typeof detail !== 'string' || detail.length > 512) throw badRequest('payload.detail must be a short string');
      payload.detail = detail;
    }
  }
  if (body.type === 'minute_update' && payload?.minute === undefined) {
    throw badRequest('minute_update requires payload.minute');
  }
  return { id, type: body.type, sequence: body.sequence, payload };
}

export function validateVerify(body) {
  if (!body || typeof body !== 'object') throw badRequest('body must be JSON');
  if (!Number.isInteger(body.sequence) || body.sequence <= 0) {
    throw badRequest('sequence must be a positive integer');
  }
  if (typeof body.market !== 'string' || !MARKETS.includes(body.market)) {
    throw badRequest(`market must be one of: ${MARKETS.join(', ')}`);
  }
  if (typeof body.seed !== 'string' || !/^[0-9a-fA-F]{64}$/.test(body.seed)) {
    throw badRequest('seed must be 32 bytes hex-encoded');
  }
  const out = { sequence: body.sequence, market: body.market, seed: body.seed.toLowerCase() };
  if (body.expected !== undefined) {
    if (typeof body.expected !== 'number' || body.expected < 0 || body.expected >= 1) {
      throw badRequest('expected must be a number in [0, 1)');
    }
    out.expected = body.expected;
  }
  return out;
}

export function validateMatchId(id) {
  return assertString(id, 'match id', 128);
}
