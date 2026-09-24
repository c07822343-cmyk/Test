// ApexWeb OS core service entry point.
import { loadConfig } from './config/env.ts';
import { buildServer } from './api/server.ts';
import { createServices, recoverAfterRestart } from './services.ts';
import { errorMessage, logger } from './util/log.ts';

const log = logger('main');

async function main() {
  const config = loadConfig();
  const s = await createServices(config);
  s.keyPool.startSweeper();
  if (config.nvidia.discoverModels && config.nvidia.keys.length) {
    s.provider.discoverModels().then(
      (r) => log.info('model discovery', { ok: r.ok, missing: r.missing, message: r.message }),
      (err) => log.warn('model discovery failed', { error: errorMessage(err) }),
    );
  }
  const recovered = await recoverAfterRestart(s);
  s.driver.start();
  const app = await buildServer(s);
  await app.listen({ host: config.host, port: config.port });
  log.info('ApexWeb OS core listening', {
    port: config.port,
    driver: config.executionDriver,
    nvidia_keys: config.nvidia.keys.map((k) => k.id),
    rpm_per_key: config.nvidia.rpmPerKey,
    recovered,
  });

  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal });
    await app.close();
    await s.driver.stop({ abort: true, timeoutMs: 20_000 } as any);
    s.keyPool.stop();
    await s.db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('fatal startup error', { error: errorMessage(err) });
  process.exit(1);
});
