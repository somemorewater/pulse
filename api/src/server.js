// Fastify application assembly. Error handler guarantees consistent
// { error: { code, message } } bodies and never leaks stacks or secrets.
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ApiError } from './lib/errors.js';
import { createEngineClient } from './clients/engine.js';
import { initInfra, closeInfra, pgPool, redisClient } from './repositories/db.js';
import { createMatchService, createEventService, createQueryService, createFairnessService } from './services/index.js';
import { createMatchController, createQueryController, createEventController, createFairnessController } from './controllers/index.js';
import { registerMatchRoutes, registerHealthRoutes } from './routes/index.js';
import { createHub } from './realtime/hub.js';
import { createSocketHandler } from './realtime/socket.js';

export async function buildApp(config) {
  const app = Fastify({ logger: true });
  const engine = createEngineClient(config.engineUrl);

  await app.register(fastifyWebsocket);

  // Static dashboard (no build step). API and WS routes take precedence;
  // only exact file paths under public/ are served.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  await app.register(fastifyStatic, { root: publicDir, prefix: '/' });

  initInfra(config, app.log);

  const queryService = createQueryService();
  const hub = createHub({ redisUrl: config.redisUrl, log: app.log });
  const controllers = {
    matches: createMatchController(createMatchService(engine)),
    query: createQueryController(queryService),
    events: createEventController(createEventService(engine)),
    fairness: createFairnessController(createFairnessService(engine)),
  };

  registerMatchRoutes(app, controllers);
  app.get('/ws/matches/:id', { websocket: true }, createSocketHandler({ hub, queryService, log: app.log }));
  registerHealthRoutes(app, {
    engine,
    pgCheck: async () => {
      await pgPool().query('SELECT 1');
      return true;
    },
    redisCheck: async () => {
      const rd = redisClient();
      if (!rd) return false;
      await rd.ping();
      return true;
    },
    wsStats: () => hub.stats(),
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err?.validation || err?.statusCode === 400) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'invalid request' } });
    }
    app.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'internal error' } });
  });

  app.addHook('onClose', async () => {
    await hub.close();
    await closeInfra();
  });

  return app;
}
