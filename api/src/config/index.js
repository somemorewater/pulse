// Central configuration. All values come from the environment.
export function loadConfig() {
  return {
    port: parseInt(process.env.PORT ?? '3000', 10),
    engineUrl: (process.env.GO_ENGINE_URL ?? 'http://localhost:8081').replace(/\/$/, ''),
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://pulse:pulse@localhost:5434/pulse?sslmode=disable',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6381/0',
  };
}
