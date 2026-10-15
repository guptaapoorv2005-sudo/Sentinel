// Alert Dispatcher entry point.
//
// A standalone Node.js process that polls outbox_events and delivers
// alerts via configured channels (email via Resend, webhook).
//
// This process is separate from the result processor because:
//   - External HTTP calls (Resend API, customer webhooks) are I/O-heavy
//     and can be slow/unreliable — keeping them out of the result processor
//     keeps result processing fast and the incident state machine simple.
//   - Alert delivery can be scaled independently.
//   - A crash in the alert dispatcher does not affect incident detection.
//
// GRACEFUL SHUTDOWN:
//   On SIGINT/SIGTERM:
//     1. Stop the polling loop (no new events picked up).
//     2. Stop heartbeat.
//     3. Disconnect from DB.
//
// USAGE:
//   node -r dotenv/config src/alert-dispatcher/index.js

import { start, stop } from './dispatcher.js';
import { createHeartbeat } from '../worker/heartbeat.js';
import { prisma } from '../config/database.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../config/environment.js';

const logger = createLogger('alert-dispatcher');

const dispatcherId = `alert-dispatcher-${config.workerId}`;

logger.info({ dispatcherId }, 'Alert dispatcher starting');

// Heartbeat so the worker dashboard knows this process is alive.
const heartbeat = createHeartbeat({
  workerId: dispatcherId,
  region: config.workerRegion,
});
heartbeat.start();

// Start the polling loop.
await start();

async function shutdown(signal) {
  logger.info({ signal }, 'Alert dispatcher shutting down...');

  try {
    await stop();
  } catch (err) {
    logger.error({ err: err.message }, 'Error stopping dispatcher');
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

  logger.info('Alert dispatcher shutdown complete');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection in alert dispatcher');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception in alert dispatcher');
  process.exit(1);
});

logger.info('Alert dispatcher ready');
