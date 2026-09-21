// Worker process entry point.
//
// This is a standalone Node.js process separate from the Express API
// and the Scheduler. It consumes jobs from the BullMQ check queue and
// persists check results to PostgreSQL.
//
// USAGE:
//   node -r dotenv/config src/worker/index.js
//   # or via npm:
//   npm run worker
//
// HEARTBEAT (Phase 5):
//   On startup, the worker begins writing a Redis heartbeat key:
//     worker:heartbeat:<workerId>
//   with a TTL. If the process crashes, the key expires and downstream
//   observers know the worker is dead. On graceful shutdown, the key is
//   deleted immediately.
//
// STALLED JOB RECOVERY (Phase 5):
//   BullMQ's built-in stalledInterval is configured in worker.js.
//   If this worker dies mid-job, another worker detects the stall and
//   re-processes the job (at-least-once delivery).
//
// GRACEFUL SHUTDOWN:
//   On SIGINT/SIGTERM:
//     1. Stop accepting new jobs (worker.close())
//     2. Stop heartbeat and delete key
//     3. Disconnect from database
//     4. Exit cleanly
//
// WHY A SEPARATE PROCESS:
//   Workers are stateless and horizontally scalable. Running them as
//   separate processes allows independent deployment, restart, and
//   scaling without affecting the API or Scheduler.

import { createWorker } from './worker.js';
import { createHeartbeat } from './heartbeat.js';
import { prisma } from '../config/database.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../config/environment.js';

const logger = createLogger('worker');

logger.info(
  {
    queueName: config.checkQueueName,
    workerId: config.workerId,
    region: config.workerRegion,
    concurrency: config.workerConcurrency,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    heartbeatTtlS: config.heartbeatTtlS,
    stalledIntervalMs: config.stalledIntervalMs,
    maxStalledCount: config.maxStalledCount,
  },
  'Worker process starting'
);

const worker = createWorker();

// Start the heartbeat loop.
const heartbeat = createHeartbeat({
  workerId: config.workerId,
  region: config.workerRegion,
});
heartbeat.start();

/**
 * Gracefully shut down the worker.
 *
 * Order matters:
 *   1. Stop accepting new jobs (worker.close waits for in-progress jobs)
 *   2. Stop heartbeat and delete the Redis key
 *   3. Disconnect from database
 */
async function shutdown(signal) {
  logger.info({ signal }, 'Worker shutting down...');

  try {
    await worker.close();
    logger.info('Worker closed');
  } catch (err) {
    logger.error({ err: err.message }, 'Error closing worker');
  }

  try {
    await heartbeat.stop();
    logger.info('Heartbeat stopped');
  } catch (err) {
    logger.error({ err: err.message }, 'Error stopping heartbeat');
  }

  try {
    await prisma.$disconnect();
    logger.info('Database connection closed');
  } catch (err) {
    logger.error({ err: err.message }, 'Error closing database connection');
  }

  logger.info('Worker shutdown complete');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection in worker');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception in worker');
  process.exit(1);
});

logger.info('Worker ready — consuming jobs from queue');
