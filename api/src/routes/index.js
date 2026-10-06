// Public routes. The /internal/* engine contract stays behind the gateway.
export function registerMatchRoutes(app, c) {
  app.post('/api/matches', c.matches.create);
  app.get('/api/matches/:id', c.query.detail);
  app.get('/api/matches/:id/odds', c.query.odds);
  app.get('/api/matches/:id/events', c.query.events);
  app.post('/api/matches/:id/events', c.events.submit);
  app.get('/api/matches/:id/fairness', c.query.fairness);
  app.post('/api/matches/:id/fairness/verify', c.fairness.verify);
  // Demo-only reveal stage: publishes the seed so clients can verify.
  app.post('/api/matches/:id/fairness/reveal', c.fairness.reveal);
}

export function registerHealthRoutes(app, deps) {
  app.get('/health', async () => {
    const out = { status: 'ok', dependencies: { api: true, engine: false, postgres: false, redis: false } };
    const { engine, pgCheck, redisCheck, wsStats } = deps;
    try {
      await engine.health();
      out.dependencies.engine = true;
    } catch { /* reported as false */ }
    try {
      out.dependencies.postgres = await pgCheck();
    } catch { /* reported as false */ }
    try {
      out.dependencies.redis = await redisCheck();
    } catch { /* reported as false */ }
    if (!out.dependencies.engine || !out.dependencies.postgres || !out.dependencies.redis) {
      out.status = 'degraded';
    }
    if (wsStats) {
      out.websocket = wsStats(); // in-memory counters, no I/O
    }
    return out;
  });
}
