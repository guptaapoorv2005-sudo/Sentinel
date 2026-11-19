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
// LEADER ELECTION (Phase 10):
// Multiple scheduler instances may run simultaneously (for redundancy).
// Only the "leader" — the instance currently holding a Redis lease —
// actually calls scheduleMonitors(). Standbys skip every tick and try to
// acquire the lease until the leader crashes or releases it.
//
// The lease cannot guarantee strict mutual exclusion across every failure
// mode. Correctness is maintained by deterministic BullMQ jobIds
// (check:{monitorId}:{slot}:{region}), which cause duplicate enqueues to
// be silently rejected.
//
// BACKFILL ON TAKEOVER:
// The first tick after becoming leader runs with includePreviousSlot=true,
// recovering any slots missed during the failover gap (up to ~20s worst-case).
//
// GRACEFUL SHUTDOWN:
// On SIGINT/SIGTERM: stop poll loop → release lease (so standby can take
// over almost immediately) → close all BullMQ queues → disconnect DB.

import { hostname } from 'os';
import { config } from '../config/environment.js';
import { prisma } from '../config/database.js';
import { checkQueueCache, resultQueue } from '../config/queue.js';
import { scheduleMonitors } from './scheduler.js';
import { createLeaderElector } from './leader.js';
import { createHeartbeat } from '../worker/heartbeat.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('scheduler');

// ── Instance identity ─────────────────────────────────────────────────────────

const instanceId =
  process.env.SCHEDULER_ID ||
  `scheduler-${hostname()}-${process.pid}`;

// ── Leader elector ────────────────────────────────────────────────────────────

const elector = createLeaderElector({
  instanceId,
  ttlMs:           config.schedulerLeaseTtlMs,
  renewIntervalMs: config.schedulerLeaseRenewMs,
  safetyMarginMs:  config.schedulerLeaseSafetyMs,
  redisUrl:        config.redisUrl,
});

// ── Heartbeat (Phase 5 pattern) ───────────────────────────────────────────────
// Every scheduler instance (leader AND standby) writes a heartbeat so the
// /workers endpoint can show all live schedulers with their current role.

const heartbeat = createHeartbeat({
  workerId: instanceId,
  region:   'scheduler',
  intervalMs: config.heartbeatIntervalMs,
  ttlS:       config.heartbeatTtlS,
});

// ── Loop state ────────────────────────────────────────────────────────────────

let isRunning = false;
let pollTimer = null;
let isFirstLeaderTick = false;  // used for backfill on takeover

// ── Tick ──────────────────────────────────────────────────────────────────────

async function tick() {
  if (!elector.isLeader()) {
    logger.debug({ instanceId }, 'Standby — skipping tick');
    return;
  }

  // Detect a leadership transition to trigger backfill on the first tick.
  const backfill = isFirstLeaderTick;
  if (isFirstLeaderTick) {
    isFirstLeaderTick = false;
    logger.info({ instanceId, epoch: elector.getEpoch() }, 'First leader tick — backfilling previous slot');
  }

  try {
    const stats = await scheduleMonitors({
      includePreviousSlot: backfill,
      shouldContinue: () => elector.isLeader(),
    });

    if (stats.total > 0) {
      logger.info(
        {
          total: stats.total,
          enqueued: stats.enqueued,
          skipped: stats.skipped,
          aborted: stats.aborted,
          backfill,
        },
        'Scheduling cycle complete'
      );
    }
  } catch (err) {
    // Don't crash the scheduler on a single failed cycle.
    logger.error({ err: err.message, stack: err.stack }, 'Scheduling cycle failed');
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

let wasLeader = false;

async function start() {
  isRunning = true;

  logger.info(
    {
      instanceId,
      pollIntervalMs: config.schedulerPollIntervalMs,
      leaseTtlMs:     config.schedulerLeaseTtlMs,
      leaseRenewMs:   config.schedulerLeaseRenewMs,
    },
    'Scheduler starting'
  );

  // Start heartbeat (visible to /workers endpoint).
  heartbeat.start();

  // Start leader elector. The elector's internal poll runs on renewIntervalMs.
  // We wrap it so we can react to leadership transitions.

  // Start elector — first acquire attempt runs immediately inside.
  await elector.start();

  // Main poll loop — separate from the elector's renew loop.
  // Run immediately, then on interval.
  await tickWithLeaderCheck();

  pollTimer = setInterval(async () => {
    if (!isRunning) return;
    await tickWithLeaderCheck();
  }, config.schedulerPollIntervalMs);
}

async function tickWithLeaderCheck() {
  const nowLeader = elector.isLeader();

  if (nowLeader && !wasLeader) {
    // Just became leader — set the backfill flag for the upcoming tick.
    isFirstLeaderTick = true;
    wasLeader = true;
  } else if (!nowLeader && wasLeader) {
    wasLeader = false;
    isFirstLeaderTick = false;
    logger.info({ instanceId }, 'Transitioned to standby');
  }

  await tick();
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

async function shutdown(signal) {
  if (!isRunning) return;
  isRunning = false;

  logger.info({ signal, instanceId }, 'Scheduler shutting down...');

  // 1. Stop the poll loop.
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // 2. Release the lease (so standby can take over within ~1 renew interval).
  try {
    await elector.release();
  } catch (err) {
    logger.error({ err: err.message }, 'Error releasing leader lease');
  }

  // 3. Disconnect elector's Redis client.
  try {
    await elector.disconnect();
  } catch {}

  // 4. Stop heartbeat.
  try {
    await heartbeat.stop();
  } catch {}

  // 5. Close all BullMQ queue connections (Phase 8: per-region queues + result queue).
  const closePromises = [];
  for (const [region, queue] of checkQueueCache.entries()) {
    closePromises.push(
      queue.close().catch((err) =>
        logger.error({ err: err.message, region }, 'Error closing check queue')
      )
    );
  }
  closePromises.push(
    resultQueue.close().catch((err) =>
      logger.error({ err: err.message }, 'Error closing result queue')
    )
  );
  await Promise.all(closePromises);
  logger.info('BullMQ queue connections closed');

  // 6. Disconnect DB.
  try {
    await prisma.$disconnect();
    logger.info('Database connection closed');
  } catch (err) {
    logger.error({ err: err.message }, 'Error closing database connection');
  }

  logger.info({ instanceId }, 'Scheduler shutdown complete');
  process.exit(0);
}

// ── Signal handlers ───────────────────────────────────────────────────────────

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection in scheduler');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception in scheduler');
  process.exit(1);
});

// ── Boot ──────────────────────────────────────────────────────────────────────

start().catch((err) => {
  logger.fatal({ err: err.message }, 'Scheduler failed to start');
  process.exit(1);
});
