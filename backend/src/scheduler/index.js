// Scheduler process entry point.
//
// This is a standalone Node.js process separate from the Express API.
// It runs independently and can be started/stopped without affecting the API.
//
// USAGE:
//   node -r dotenv/config src/scheduler/index.js
//   # or via npm:
//   npm run scheduler
//
// WHY A SEPARATE PROCESS:
// The scheduler only produces jobs; workers consume them.
// Separating concerns means the scheduler can be restarted, scaled, or
// replaced without affecting API request handling.
//
// GRACEFUL SHUTDOWN:
// On SIGINT/SIGTERM, the scheduler stops its polling loop, closes the
// BullMQ queue connection, and disconnects from the database cleanly.

import { config } from '../config/environment.js';
import { prisma } from '../config/database.js';
import { checkQueue } from '../config/queue.js';
import { scheduleMonitors } from './scheduler.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('scheduler');

let isRunning = false;
let pollTimer = null;

/**
 * Start the scheduler polling loop.
 * Runs scheduleMonitors() every `schedulerPollIntervalMs` milliseconds.
 */
async function start() {
  isRunning = true;

  logger.info(
    { pollIntervalMs: config.schedulerPollIntervalMs, queueName: config.checkQueueName },
    'Scheduler starting'
  );

  // Run immediately on start, then repeat on interval.
  await tick();

  pollTimer = setInterval(async () => {
    if (!isRunning) return;
    await tick();
  }, config.schedulerPollIntervalMs);
}

/**
 * Execute one scheduling cycle with error handling.
 */
async function tick() {
  try {
    const stats = await scheduleMonitors();

    if (stats.total > 0) {
      logger.info(
        { total: stats.total, enqueued: stats.enqueued, skipped: stats.skipped },
        'Scheduling cycle complete'
      );
    }
  } catch (err) {
    // Don't crash the scheduler on a single failed cycle.
    // Log the error and try again on the next interval.
    logger.error({ err: err.message, stack: err.stack }, 'Scheduling cycle failed');
  }
}

/**
 * Gracefully stop the scheduler.
 */
async function shutdown(signal) {
  if (!isRunning) return;
  isRunning = false;

  logger.info({ signal }, 'Scheduler shutting down...');

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  try {
    await checkQueue.close();
    logger.info('BullMQ queue connection closed');
  } catch (err) {
    logger.error({ err: err.message }, 'Error closing queue connection');
  }

  try {
    await prisma.$disconnect();
    logger.info('Database connection closed');
  } catch (err) {
    logger.error({ err: err.message }, 'Error closing database connection');
  }

  logger.info('Scheduler shutdown complete');
  process.exit(0);
}

// --- Signal handlers ---
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection in scheduler');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception in scheduler');
  process.exit(1);
});

// --- Start ---
start().catch((err) => {
  logger.fatal({ err: err.message }, 'Scheduler failed to start');
  process.exit(1);
});
