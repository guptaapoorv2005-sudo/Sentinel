// Scheduler — turns monitors into BullMQ jobs.
//
// HOW IT WORKS:
// 1. Every N seconds (configurable, default 15s), query all enabled monitors.
// 2. For each monitor, compute an "execution slot" — a deterministic timestamp
//    derived from the current time and the monitor's interval.
// 3. Attempt to enqueue a BullMQ job with a stable jobId.
//    - jobId = `check:${monitorId}:${executionSlot}`
//    - If BullMQ already has a job with this ID (pending, active, or completed),
//      the add() call is silently ignored. No duplicate check needed.
//
// WHY EXECUTION SLOTS:
// A monitor with interval=60s should produce one job per 60-second window,
// regardless of how many times the scheduler polls within that window.
//
// Example for interval=60, current time = 1720000045:
//   slot = Math.floor(1720000045000 / 60000) * 60000 = 1720000020000
//
// If the scheduler runs again at 1720000055, the same slot is computed,
// producing the same jobId — BullMQ ignores the duplicate.
//
// At 1720000080, the slot advances to 1720000080000, producing a new jobId.
//
// IDEMPOTENCY:
// This design means the scheduler is stateless. It stores nothing.
// After a restart, it computes the current slot from the wall clock and
// either enqueues (if the job hasn't been created yet) or skips (if it has).
//
// WHY removeOnComplete.age:
// If a completed job is removed from Redis, BullMQ would accept a new job
// with the same jobId. By setting removeOnComplete.age = interval (seconds),
// the completed job stays in Redis long enough that a duplicate enqueue
// within the same slot is still rejected.

import { prisma } from '../config/database.js';
import { checkQueue } from '../config/queue.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('scheduler');

function computeExecutionSlot(intervalSeconds, nowMs = Date.now()) {
  const intervalMs = intervalSeconds * 1000;
  return Math.floor(nowMs / intervalMs) * intervalMs;
}

/**
 * Run one scheduling cycle:
 * 1. Fetch all enabled monitors from the database.
 * 2. Compute their execution slot.
 * 3. Attempt to enqueue a job for each.
 *
 * Returns stats about the cycle for logging.
 */
async function scheduleMonitors() {
  const monitors = await prisma.monitor.findMany({
    where: { enabled: true },
    select: {
      id: true,
      url: true,
      method: true,
      interval: true,
      timeout: true,
      expectedStatus: true,
    },
  });

  if (monitors.length === 0) {
    logger.debug('No enabled monitors found');
    return { total: 0, enqueued: 0, skipped: 0 };
  }

  let enqueued = 0;
  let skipped = 0;

  const now = Date.now();

  for (const monitor of monitors) {
    const executionSlot = computeExecutionSlot(monitor.interval, now);
    const jobId = `check:${monitor.id}:${executionSlot}`;

    const payload = {
      monitorId: monitor.id,
      url: monitor.url,
      method: monitor.method,
      expectedStatus: monitor.expectedStatus,
      timeout: monitor.timeout,
      executionSlot,
    };

    try {
      // Attempt to add the job. If a job with this jobId already exists
      // (pending, active, or completed and still retained), BullMQ
      // returns the existing job and does not create a duplicate.
      const job = await checkQueue.add('check', payload, {
        jobId,
        removeOnComplete: {
          // Keep the completed job in Redis for at least one interval,
          // so the scheduler won't re-enqueue within the same slot.
          age: monitor.interval,
        },
      });

      // BullMQ returns null when a job with this ID already exists in some
      // versions, or returns the existing job. We can check by comparing
      // the job's timestamp to determine if it was just created.
      // However, the simplest reliable approach: if add() doesn't throw,
      // the job is either new or already existed. We count it as enqueued
      // either way since the effect is correct.
      if (job) {
        enqueued++;
      }
    } catch (err) {
      // If the error indicates a duplicate jobId, that's expected — skip.
      // BullMQ throws an error with message containing 'exists' for duplicates.
      if (err.message && err.message.includes('exists')) {
        skipped++;
      } else {
        logger.error(
          { monitorId: monitor.id, jobId, err: err.message },
          'Failed to enqueue check job'
        );
      }
    }
  }

  return { total: monitors.length, enqueued, skipped };
}

export { scheduleMonitors, computeExecutionSlot };
