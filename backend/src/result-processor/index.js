// Result Processor entry point.
//
// A standalone Node.js process that consumes from the result queue and
// delegates to processResult() for persistence and monitor state updates.
//
// This process is separate from the check worker because:
//   - Workers should be stateless (no DB connection).
//   - Result processing is a distinct concern: persistence, state machine,
//     incident detection (Phase 7), alerting (Phase 9).
//   - Scaling them independently makes sense: you might run 10 workers
//     but only 2 result processors.
//
// GRACEFUL SHUTDOWN:
//   On SIGINT/SIGTERM:
//     1. Stop accepting new result jobs.
//     2. Stop heartbeat (key deleted immediately).
//     3. Disconnect from DB.
//
// USAGE:
//   node -r dotenv/config src/result-processor/index.js

import { Worker } from 'bullmq';
import { redisConnection } from '../config/queue.js';
import { processResult } from './processor.js';
import { createHeartbeat } from '../worker/heartbeat.js';
import { prisma } from '../config/database.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../config/environment.js';

const logger = createLogger('result-processor');

// Result processor identity — distinct namespace from check workers.
const processorId = `result-processor-${config.workerId}`;
const region = config.workerRegion;

logger.info(
  {
    queueName: config.resultQueueName,
    processorId,
    region,
    stalledIntervalMs: config.stalledIntervalMs,
  },
  'Result processor starting'
);

const worker = new Worker(
  config.resultQueueName,
  processResult,
  {
    connection: redisConnection,
    concurrency: config.workerConcurrency,
    stalledInterval: config.stalledIntervalMs,
    maxStalledCount: config.maxStalledCount,
  }
);

worker.on('completed', (job, result) => {
  logger.info(
    {
      jobId: job.id,
      monitorId: result.monitorId,
      executionSlot: String(result.executionSlot),
      status: result.status,
      stateUpdated: result.stateUpdated,
    },
    'Result job completed'
  );
});

worker.on('failed', (job, err) => {
  logger.error(
    {
      jobId: job?.id,
      monitorId: job?.data?.monitorId,
      err: err.message,
      attempts: job?.attemptsMade,
    },
    'Result job failed'
  );
});

worker.on('error', (err) => {
  logger.error({ err: err.message, processorId }, 'Result processor connection error');
});

worker.on('stalled', (jobId) => {
  logger.warn({ jobId, processorId }, 'Result job stalled — will be retried');
});

// Heartbeat so the system knows this process is alive.
const heartbeat = createHeartbeat({
  workerId: processorId,
  region,
});
heartbeat.start();

async function shutdown(signal) {
  logger.info({ signal }, 'Result processor shutting down...');

  try {
    await worker.close();
    logger.info('Result processor worker closed');
  } catch (err) {
    logger.error({ err: err.message }, 'Error closing result processor worker');
  }

  try {
    await heartbeat.stop();
  } catch (err) {
    logger.error({ err: err.message }, 'Error stopping heartbeat');
  }

  try {
    await prisma.$disconnect();
    logger.info('Database connection closed');
  } catch (err) {
    logger.error({ err: err.message }, 'Error closing database connection');
  }

  logger.info('Result processor shutdown complete');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection in result processor');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception in result processor');
  process.exit(1);
});

logger.info('Result processor ready — consuming from result queue');
