// Scheduler — turns monitors into BullMQ jobs.
//
// HOW IT WORKS:
// 1. Every N seconds (configurable, default 15s), query all enabled monitors.
// 2. For each monitor × configured region, compute an "execution slot" — a
//    deterministic timestamp derived from the current time and the monitor's
//    interval.
// 3. Attempt to enqueue a BullMQ job on the region's queue with a stable jobId.
//    - jobId = `check:${monitorId}:${executionSlot}:${region}`
//    - If BullMQ already has a job with this ID, the add() call is silently
//      ignored. No duplicate check needed.
//
// WHY EXECUTION SLOTS:
// A monitor with interval=60s should produce one job per 60-second window
// per region, regardless of how many times the scheduler polls.
//
// Example for interval=60, current time = 1720000045:
//   slot = Math.floor(1720000045000 / 60000) * 60000 = 1720000020000
//
// If the scheduler runs again at 1720000055, the same slot is computed —
// same jobId — BullMQ ignores the duplicate.
//
// At 1720000080, the slot advances to 1720000080000, producing a new jobId.
//
// FAN-OUT (Phase 8):
// With N configured regions (QUORUM_REGIONS), each monitor slot produces N
// jobs — one per region. Each job is enqueued into the region's own queue
// (sentinel.checks.<region>). Workers consume exclusively from their queue,
// so each region independently observes the target.
//
// Single-region mode (QUORUM_REGIONS=default):
// Produces exactly one job per slot, queued to sentinel.checks.default.
// This is backward-compatible with Phase 7 behavior.
//
// IDEMPOTENCY:
// The scheduler is stateless. After a restart it computes the current slot
// from the wall clock and either enqueues (if the job hasn't been created)
// or skips (if it has).
//
// WHY removeOnComplete.age:
// If a completed job is removed from Redis, BullMQ would accept a new job
// with the same jobId. By setting removeOnComplete.age = interval (seconds),
// the completed job stays in Redis long enough that a duplicate enqueue
// within the same slot is still rejected.

import { prisma } from '../config/database.js';
import { getCheckQueue } from '../config/queue.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../config/environment.js';

const logger = createLogger('scheduler');

function computeExecutionSlot(intervalSeconds, nowMs = Date.now()) {
  const intervalMs = intervalSeconds * 1000;
  return Math.floor(nowMs / intervalMs) * intervalMs;
}

/**
 * Run one scheduling cycle:
 * 1. Fetch all enabled monitors from the database.
 * 2. Compute their execution slot.
 * 3. For each monitor × region, attempt to enqueue a job on the region queue.
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
  const regions = config.quorumRegions;

  for (const monitor of monitors) {
    const executionSlot = computeExecutionSlot(monitor.interval, now);

    const payload = {
      monitorId: monitor.id,
      url: monitor.url,
      method: monitor.method,
      expectedStatus: monitor.expectedStatus,
      timeout: monitor.timeout,
      executionSlot,
    };

    for (const region of regions) {
      // Stable jobId: one job per (monitor, slot, region).
      // BullMQ deduplicates based on jobId — the same job won't be enqueued
      // twice within the same slot, even if the scheduler restarts.
      const jobId = `check:${monitor.id}:${executionSlot}:${region}`;
      const queue = getCheckQueue(region);

      try {
        const job = await queue.add('check', { ...payload, targetRegion: region }, {
          jobId,
          removeOnComplete: {
            // Keep the completed job in Redis for at least one interval so
            // the scheduler won't re-enqueue within the same slot.
            age: monitor.interval,
          },
        });

        if (job) {
          enqueued++;
        }
      } catch (err) {
        if (err.message && err.message.includes('exists')) {
          skipped++;
        } else {
          logger.error(
            { monitorId: monitor.id, region, jobId, err: err.message },
            'Failed to enqueue check job'
          );
        }
      }
    }
  }

  return { total: monitors.length, regions: regions.length, enqueued, skipped };
}

export { scheduleMonitors, computeExecutionSlot };
