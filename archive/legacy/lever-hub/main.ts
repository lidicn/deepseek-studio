/**
 * Lever-Hub server 启动入口
 */
import { createLeverHubServer } from './lever-hub-server';

const server = createLeverHubServer();

server.start()
  .then(() => {
    console.log('[lever-hub] listening on http://127.0.0.1:8762');
  })
  .catch((err) => {
    console.error('[lever-hub] failed to start:', err);
    process.exit(1);
  });

function shutdown(): void {
  void server.stop().then(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
