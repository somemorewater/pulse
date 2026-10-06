// Shared PostgreSQL pool and Redis client (singletons per process).
import pg from 'pg';
import { createClient } from 'redis';

const { Pool } = pg;

let pool;
let redis;
let redisReady = false;

export function initInfra({ databaseUrl, redisUrl }, log) {
  pool = new Pool({ connectionString: databaseUrl });
  pool.on('error', (err) => log?.error({ err: String(err) }, 'pg pool error'));

  redis = createClient({ url: redisUrl });
  redis.on('error', (err) => log?.warn({ err: String(err?.message ?? err) }, 'redis error'));
  // Connect in the background: the API boots degraded and recovers,
  // dependency state is reported via GET /health.
  redis.connect().then(() => { redisReady = true; }).catch(() => { redisReady = false; });
}

export function pgPool() {
  return pool;
}

export function redisClient() {
  return redisReady ? redis : null;
}

export async function closeInfra() {
  try { await pool?.end(); } catch { /* shutting down */ }
  try { await redis?.quit(); } catch { /* shutting down */ }
}
