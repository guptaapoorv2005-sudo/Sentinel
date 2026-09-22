// Result Processor — persists check results and updates monitor current state.
//
// This is the heart of Phase 6. It consumes from the result queue and:
//   1. Persists the CheckResult row (idempotent upsert, always).
//   2. Determines whether the result is "new" or "late" via lastEvaluatedSlot.
//   3. If new: updates currentStatus, lastCheckedAt, lastStatusChange, lastEvaluatedSlot.
//   4. Always: recomputes consecutiveFailures as a derived projection from CheckResult history.
//
// ── WHY consecutiveFailures IS A DERIVED PROJECTION ──────────────────────────
//   Results can arrive out of order because:
//    - Workers run concurrently in different regions.
//    - Network and queue latency vary.
//    - BullMQ retries can delay a job.
//   Naive approach (blind increment/reset):
//     DOWN(slot1) → cf=1, DOWN(slot3) → cf=2, UP(slot2, late) → cf unchanged=2
//
//   But the correct answer is 1, because in slot order the sequence is:
//     slot1:DOWN → slot2:UP → slot3:DOWN
//   There is only 1 consecutive DOWN before the latest evaluated slot (slot3).
//
//   Solution: after every result (new or late), recompute consecutiveFailures
//   by counting trailing DOWNs from the most recent evaluated slot backwards
//   through CheckResult history. This is correct regardless of arrival order.
//
// ── EXECUTION-ORDER CORRECTNESS (lastEvaluatedSlot) ──────────────────────────
//
//   currentStatus, lastCheckedAt, lastStatusChange, lastEvaluatedSlot are only
//   updated when the incoming result's executionSlot > lastEvaluatedSlot.
//
//   A late result (slot ≤ lastEvaluatedSlot):
//     - Its CheckResult row IS persisted (for history completeness).
//     - consecutiveFailures IS recomputed (because the gap filling may change the streak).
//     - currentStatus / lastEvaluatedSlot / lastStatusChange are NOT changed.
//
// ── CONSECUTIVE FAILURES COMPUTATION ─────────────────────────────────────────
//
//   Uses a SQL window query ordered by execution_slot DESC.
//   Maintains a running count of UP results seen; once the running count
//   exceeds 0 the result is past the trailing DOWN streak.
//
//   Example: [slot1:DOWN, slot2:UP, slot3:DOWN] up to slot3:
//     slot3:DOWN → ups_seen=0 → counted
//     slot2:UP   → ups_seen=1 → not counted (streak broken)
//     slot1:DOWN → ups_seen=1 → not counted
//     Result: 1 ✅
//
// ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
//
//   CheckResult upsert: keyed on (monitorId, executionSlot).
//   Monitor currentStatus update: conditional on slot > lastEvaluatedSlot.
//   consecutiveFailures: recomputed from immutable history — identical inputs
//   always produce identical output.
//
//   Processing the same result twice is safe.

import { prisma } from '../config/database.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('result-processor');

/**
 * Compute the number of consecutive DOWN results immediately preceding and
 * including the latest evaluated execution slot, in execution-slot order.
 *
 * Uses a SQL window function to walk results from newest to oldest and count
 * the trailing DOWN streak before the first UP (or end of history).
 *
 * @param {object} tx   - Prisma transaction client
 * @param {string} monitorId
 * @param {BigInt} upToSlot - Only consider results with executionSlot ≤ this value
 * @returns {Promise<number>}
 */
async function computeConsecutiveFailures(tx, monitorId, upToSlot) {
  const rows = await tx.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM (
      SELECT
        status,
        SUM(CASE WHEN status = 'UP' THEN 1 ELSE 0 END)
          OVER (ORDER BY execution_slot DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
          AS ups_seen
      FROM check_results
      WHERE monitor_id = ${monitorId}::uuid
        AND execution_slot <= ${upToSlot}
    ) sub
    WHERE ups_seen = 0 AND status = 'DOWN'
  `;
  return Number(rows[0].count);
}

async function processResult(job) {
  const {
    jobId,
    monitorId,
    executionSlot,
    workerId,
    region,
    status,
    statusCode,
    responseTimeMs,
    failureType,
    checkedAt,
  } = job.data;

  const slot = BigInt(executionSlot);
  const checkedAtDate = new Date(checkedAt);

  logger.debug(
    { jobId: job.id, monitorId, executionSlot, workerId, region, status },
    'Processing result'
  );

  const outcome = await prisma.$transaction(async (tx) => {
    // ── Step 1: Persist CheckResult (always, idempotent) ─────────────────
    await tx.checkResult.upsert({
      where: {
        uq_check_result_slot: { monitorId, executionSlot: slot },
      },
      update: {
        jobId,
        workerId,
        region,
        status,
        statusCode,
        responseTimeMs,
        failureType,
        checkedAt: checkedAtDate,
      },
      create: {
        monitorId,
        executionSlot: slot,
        jobId,
        workerId,
        region,
        status,
        statusCode,
        responseTimeMs,
        failureType,
        checkedAt: checkedAtDate,
      },
    });

    // ── Step 2: Read current monitor state ───────────────────────────────
    const monitor = await tx.monitor.findUnique({
      where: { id: monitorId },
      select: {
        currentStatus: true,
        lastEvaluatedSlot: true,
        lastStatusChange: true,
      },
    });

    if (!monitor) {
      // Monitor was deleted between job enqueue and processing. Skip.
      logger.warn({ monitorId, executionSlot }, 'Monitor not found — skipping state update');
      return { monitorId, executionSlot, status, stateUpdated: false, consecutiveFailures: 0 };
    }

    // ── Step 3: Determine new vs late ────────────────────────────────────
    // "new"  → this slot advances the frontier (slot > lastEvaluatedSlot).
    // "late" → a gap-filling result; don't move the frontier forward.
    const isNew = monitor.lastEvaluatedSlot === null || slot > monitor.lastEvaluatedSlot;

    // The slot up to which we evaluate consecutive failures.
    // - For new results: the incoming slot.
    // - For late results: the existing frontier (not moved).
    const effectiveSlot = isNew ? slot : monitor.lastEvaluatedSlot;

    // ── Step 4: Recompute consecutiveFailures from history ───────────────
    // Done AFTER upserting the CheckResult so the new row is visible in the
    // query. Because we're inside the same transaction, the upserted row is
    // visible here (serializable snapshot).
    const consecutiveFailures = await computeConsecutiveFailures(tx, monitorId, effectiveSlot);

    // ── Step 5: Build and apply monitor update ───────────────────────────
    const updateData = { consecutiveFailures };

    if (isNew) {
      updateData.currentStatus = status;
      updateData.lastCheckedAt = checkedAtDate;
      updateData.lastEvaluatedSlot = slot;

      // lastStatusChange: only record when status actually transitions.
      // UNKNOWN → anything is also treated as a transition (first check).
      const prevStatus = monitor.currentStatus;
      if (prevStatus === 'UNKNOWN' || status !== prevStatus) {
        updateData.lastStatusChange = checkedAtDate;
      }
      // If status === prevStatus (e.g. DOWN→DOWN), lastStatusChange is
      // unchanged — we deliberately omit it from updateData.
    }
    // Late results: only consecutiveFailures is written. currentStatus,
    // lastEvaluatedSlot, lastStatusChange, lastCheckedAt stay as-is.

    await tx.monitor.update({
      where: { id: monitorId },
      data: updateData,
    });

    return { monitorId, executionSlot, status, stateUpdated: isNew, consecutiveFailures };
  });

  if (outcome.stateUpdated) {
    logger.info(
      {
        monitorId,
        executionSlot,
        workerId,
        region,
        status,
        consecutiveFailures: outcome.consecutiveFailures,
      },
      'Monitor state updated'
    );
  } else {
    logger.debug(
      {
        monitorId,
        executionSlot,
        workerId,
        consecutiveFailures: outcome.consecutiveFailures,
      },
      'Late result — CheckResult persisted, consecutiveFailures recomputed, frontier unchanged'
    );
  }

  return outcome;
}

export { processResult };
