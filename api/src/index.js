import { loadConfig } from './config/index.js';
import { buildApp } from './server.js';

const config = loadConfig();
const app = await buildApp(config);

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  });
}
