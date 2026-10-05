// Result Processor — persists regional check results and drives monitor state
// through the quorum aggregator.
//
// ── OVERVIEW (Phase 8) ────────────────────────────────────────────────────────
//
// Each call to processResult() handles ONE regional observation (one worker,
// one region, one execution slot). The pipeline has two stages:
//
//   Stage A — Regional persistence
//     Upsert CheckResult keyed on (monitorId, executionSlot, region).
//     This is always idempotent.
//
//   Stage B — Slot quorum aggregation
//     After persisting, attempt to evaluate the quorum for this slot.
//     Quorum evaluation produces a global slot status: UP | DOWN | UNKNOWN.
//     The result is written to SlotResult (idempotent — unique on (monitor, slot)).
//
// ── QUORUM EVALUATION STRATEGY ───────────────────────────────────────────────
//
// EAGER path (runs on every result arrival):
//   Count UP/DOWN observations for this (monitorId, executionSlot).
//   DOWN ≥ quorumMinRegions → global DOWN
//   UP  ≥ quorumMinRegions → global UP
//   All N regions have reported but neither threshold met → UNKNOWN (rare edge)
//   Otherwise: undecided, skip.
//
// SWEEP path (runs after every result arrival for this monitor):
//   Find any older slots where:
//     - No SlotResult exists yet (unevaluated)
//     - At least one CheckResult exists
//     - The slot timestamp + correlationWindow < now (window has expired)
//   Evaluate those slots with whatever data arrived. Missing regions count
//   as UNKNOWN — they don't contribute to either quorum direction.
//
// ── MONITOR STATE UPDATES ─────────────────────────────────────────────────────
//
// Monitor.currentStatus and Monitor.consecutiveFailures are updated ONLY
// after a slot is finalized (SlotResult written).
//
// consecutiveFailures is derived from SlotResult history — NOT from individual
// CheckResults. UNKNOWN slots are transparent: they do not increment or reset
// the failure streak.
//
// The frontier concept (lastEvaluatedSlot) still applies: only the newest
// evaluated slot advances currentStatus. A finalized older slot still updates
// consecutiveFailures (because gap-filling a slot may change the streak) but
// does not change currentStatus, lastCheckedAt, or lastStatusChange.
//
// ── UNKNOWN SLOT SEMANTICS ────────────────────────────────────────────────────
//
// UNKNOWN means insufficient data — neither quorum for UP nor DOWN was
// reached within the correlation window. The monitor's currentStatus is
// not updated for UNKNOWN slots (we hold the last known state). The slot
// is still recorded in SlotResult to prevent repeated re-evaluation.
//
// ── INCIDENT STATE MACHINE (Phase 8) ─────────────────────────────────────────
//
// Incidents are created directly as CONFIRMED — quorum has already been
// applied before a slot is classified as DOWN, so no DETECTED → CONFIRMED
// promotion is needed.
//
//   ON DOWN (consecutiveFailures ≥ threshold, no open incident):
//     → Create incident with status CONFIRMED.
//     → Single IncidentEvent: null → CONFIRMED.
//
//   ON UP (consecutiveFailures === 0, open incident exists):
//     → Resolve incident (same as Phase 7).
//
// ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
//
//   CheckResult upsert: keyed on (monitorId, executionSlot, region).
//   SlotResult upsert:  keyed on (monitorId, executionSlot).
//   Monitor update:     conditional on slot > lastEvaluatedSlot (for currentStatus).
//   consecutiveFailures: recomputed from immutable SlotResult history.
//   Incident creation:  guarded by partial unique index uq_monitor_open_incident.
//
//   Processing the same result twice is safe.

import { prisma } from '../config/database.js';
import { config } from '../config/environment.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('result-processor');

const DETECTION_THRESHOLD     = config.incidentDetectionThreshold;
const QUORUM_MIN_REGIONS      = config.quorumMinRegions;
const TOTAL_REGIONS           = config.quorumRegions.length;
const CORRELATION_WINDOW_MS   = config.quorumCorrelationWindowMs;

// ── consecutiveFailures: derived from SlotResult history ─────────────────────
//
// Counts trailing DOWN SlotResults immediately preceding (and including)
// the given upToSlot, in execution-slot order, skipping UNKNOWN rows.
//
// Uses a SQL window function:
//   Walk slot_results from newest → oldest.
//   Track a running sum of UP rows seen so far.
//   Count DOWN rows where no UP has been seen yet (ups_seen = 0).
//
// Example: [slot1:DOWN, slot2:UP, slot3:UNKNOWN, slot4:DOWN] up to slot4:
//   slot4:DOWN    → ups_seen=0 → counted
//   slot3:UNKNOWN → excluded (UNKNOWN transparent)
//   slot2:UP      → ups_seen=1 → not counted (streak broken)
//   slot1:DOWN    → ups_seen=1 → not counted
//   Result: 1 ✅
//
async function computeConsecutiveFailures(tx, monitorId, upToSlot) {
  const rows = await tx.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM (
      SELECT
        global_status,
        SUM(CASE WHEN global_status = 'UP' THEN 1 ELSE 0 END)
          OVER (ORDER BY execution_slot DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
          AS ups_seen
      FROM slot_results
      WHERE monitor_id = ${monitorId}::uuid
        AND execution_slot <= ${upToSlot}
        AND global_status != 'UNKNOWN'
    ) sub
    WHERE ups_seen = 0 AND global_status = 'DOWN'
  `;
  return Number(rows[0].count);
}

// ── Quorum evaluation for a single slot ──────────────────────────────────────
//
// Returns: { globalStatus, regionsUp, regionsDown, regionsMissing, decided }
//   decided = true  → write a SlotResult
//   decided = false → still waiting for more results
//
async function evaluateSlotQuorum(tx, monitorId, slot, now) {
  const checkResults = await tx.checkResult.findMany({
    where: { monitorId, executionSlot: slot },
    select: { region: true, status: true },
  });

  const regionsUp   = checkResults.filter(r => r.status === 'UP').length;
  const regionsDown = checkResults.filter(r => r.status === 'DOWN').length;
  const reported    = checkResults.length;

  // Eager: DOWN quorum met
  if (regionsDown >= QUORUM_MIN_REGIONS) {
    return { globalStatus: 'DOWN', regionsUp, regionsDown,
             regionsMissing: TOTAL_REGIONS - reported, decided: true };
  }

  // Eager: UP quorum met
  if (regionsUp >= QUORUM_MIN_REGIONS) {
    return { globalStatus: 'UP', regionsUp, regionsDown,
             regionsMissing: TOTAL_REGIONS - reported, decided: true };
  }

  // All regions reported but neither threshold met → UNKNOWN (rare: e.g. 1 UP, 1 DOWN, 1 missing)
  if (reported >= TOTAL_REGIONS) {
    return { globalStatus: 'UNKNOWN', regionsUp, regionsDown,
             regionsMissing: 0, decided: true };
  }

  // Check if the correlation window has expired
  const slotMs = Number(slot);
  const windowExpired = slotMs + CORRELATION_WINDOW_MS < now;

  if (windowExpired) {
    // Finalize with what we have — remaining regions are missing
    const regionsMissing = TOTAL_REGIONS - reported;
    // Re-check thresholds with the data we have
    let globalStatus;
    if (regionsDown >= QUORUM_MIN_REGIONS) {
      globalStatus = 'DOWN';
    } else if (regionsUp >= QUORUM_MIN_REGIONS) {
      globalStatus = 'UP';
    } else {
      globalStatus = 'UNKNOWN';
    }
    return { globalStatus, regionsUp, regionsDown, regionsMissing, decided: true };
  }

  // Still within window and not enough data yet — wait
  return { globalStatus: null, regionsUp, regionsDown,
           regionsMissing: TOTAL_REGIONS - reported, decided: false };
}

// ── Incident evaluation ───────────────────────────────────────────────────────
//
// Called inside a transaction after monitor state is updated.
// Phase 8: incidents are created directly as CONFIRMED (no DETECTED transition).
// Phase 9: OutboxEvent is written atomically inside the same transaction.
//
async function evaluateIncident(tx, monitorId, globalStatus, consecutiveFailures, evaluatedAt, monitorName, monitorUrl) {
  const openIncident = await tx.incident.findFirst({
    where: { monitorId, status: { not: 'RESOLVED' } },
    orderBy: { detectedAt: 'desc' },
  });

  // ── DOWN path ──────────────────────────────────────────────────────────────
  if (globalStatus === 'DOWN') {
    if (openIncident) {
      return { action: 'noop', incidentId: openIncident.id };
    }

    if (consecutiveFailures >= DETECTION_THRESHOLD) {
      let incident;
      try {
        // Create incident directly as CONFIRMED — quorum already applied.
        incident = await tx.incident.create({
          data: {
            monitorId,
            status: 'CONFIRMED',
            failureCountAtDetection: consecutiveFailures,
            detectedAt: evaluatedAt,
            confirmedAt: evaluatedAt,
          },
        });
      } catch (err) {
        // Unique constraint: another concurrent transaction already created it.
        if (err.code === 'P2002' || (err.message && err.message.includes('uq_monitor_open_incident'))) {
          logger.warn({ monitorId, consecutiveFailures }, 'Concurrent incident creation — already exists');
          return { action: 'noop' };
        }
        throw err;
      }

      await tx.incidentEvent.create({
        data: {
          incidentId: incident.id,
          fromStatus: null,
          toStatus: 'CONFIRMED',
          reason: `quorum_threshold_reached (${consecutiveFailures} consecutive global DOWN slots)`,
          actor: 'system',
        },
      });

      // Phase 9: write OutboxEvent atomically — same commit as the incident.
      await tx.outboxEvent.create({
        data: {
          type: 'INCIDENT_CONFIRMED',
          aggregateType: 'Incident',
          aggregateId: incident.id,
          payload: {
            incidentId: incident.id,
            monitorId,
            monitorName: monitorName || monitorId,
            monitorUrl: monitorUrl || '',
            consecutiveFailures,
            detectedAt: evaluatedAt.toISOString(),
          },
        },
      });

      logger.info(
        { monitorId, incidentId: incident.id, consecutiveFailures },
        'Incident CONFIRMED (quorum threshold reached)'
      );

      return { action: 'created', incidentId: incident.id };
    }

    return { action: 'noop' };
  }

  // ── UP path ────────────────────────────────────────────────────────────────
  if (globalStatus === 'UP' && consecutiveFailures === 0 && openIncident) {
    const prevStatus = openIncident.status;

    await tx.incident.update({
      where: { id: openIncident.id },
      data: { status: 'RESOLVED', resolvedAt: evaluatedAt },
    });

    await tx.incidentEvent.create({
      data: {
        incidentId: openIncident.id,
        fromStatus: prevStatus,
        toStatus: 'RESOLVED',
        reason: 'recovery (global UP slot, consecutiveFailures = 0)',
        actor: 'system',
      },
    });

    // Phase 9: write OutboxEvent atomically — same commit as the resolution.
    const resolvedAt = evaluatedAt;
    const durationMs = openIncident.detectedAt
      ? resolvedAt.getTime() - new Date(openIncident.detectedAt).getTime()
      : null;

    await tx.outboxEvent.create({
      data: {
        type: 'INCIDENT_RESOLVED',
        aggregateType: 'Incident',
        aggregateId: openIncident.id,
        payload: {
          incidentId: openIncident.id,
          monitorId,
          monitorName: monitorName || monitorId,
          monitorUrl: monitorUrl || '',
          resolvedAt: resolvedAt.toISOString(),
          durationMs,
        },
      },
    });

    logger.info(
      { monitorId, incidentId: openIncident.id, prevStatus },
      'Incident RESOLVED after recovery'
    );

    return { action: 'resolved', incidentId: openIncident.id };
  }

  return { action: 'noop' };
}

// ── Finalize a slot ───────────────────────────────────────────────────────────
//
// Called when quorum evaluation produces a definitive result.
// Writes SlotResult and updates monitor state inside a transaction.
//
// Returns the incident outcome.
//
async function finalizeSlot(monitorId, slot, globalStatus, counts, now) {
  const evaluatedAt = new Date(now);

  return await prisma.$transaction(async (tx) => {
    // 1. Write SlotResult — idempotent (unique on monitorId + executionSlot).
    //    If another processor concurrently finalized this slot, skip.
    try {
      await tx.slotResult.create({
        data: {
          monitorId,
          executionSlot: slot,
          globalStatus,
          regionsUp: counts.regionsUp,
          regionsDown: counts.regionsDown,
          regionsMissing: counts.regionsMissing,
          evaluatedAt,
        },
      });
    } catch (err) {
      // P2002 = unique constraint violation — slot already finalized.
      if (err.code === 'P2002') {
        logger.debug({ monitorId, executionSlot: String(slot) }, 'Slot already finalized — skipping');
        return { action: 'already_finalized' };
      }
      throw err;
    }

    // 2. Read current monitor state.
    const monitor = await tx.monitor.findUnique({
      where: { id: monitorId },
      select: { currentStatus: true, lastEvaluatedSlot: true, lastStatusChange: true, name: true, url: true },
    });

    if (!monitor) {
      logger.warn({ monitorId }, 'Monitor not found — skipping state update');
      return { action: 'noop' };
    }

    // 3. Is this slot newer than the last evaluated slot?
    const isNew = monitor.lastEvaluatedSlot === null || slot > monitor.lastEvaluatedSlot;

    // The slot up to which we evaluate consecutive failures:
    // new → this slot; late → the existing frontier.
    const effectiveSlot = isNew ? slot : monitor.lastEvaluatedSlot;

    // 4. Recompute consecutiveFailures from SlotResult history.
    //    UNKNOWN slots are excluded — they're transparent to the streak.
    const consecutiveFailures = await computeConsecutiveFailures(tx, monitorId, effectiveSlot);

    // 5. Build and apply monitor update.
    const updateData = { consecutiveFailures };

    if (isNew && globalStatus !== 'UNKNOWN') {
      // UNKNOWN slots do not advance currentStatus or the frontier.
      updateData.currentStatus = globalStatus;
      updateData.lastCheckedAt = evaluatedAt;
      updateData.lastEvaluatedSlot = slot;

      const prevStatus = monitor.currentStatus;
      if (prevStatus === 'UNKNOWN' || globalStatus !== prevStatus) {
        updateData.lastStatusChange = evaluatedAt;
      }
    } else if (isNew && globalStatus === 'UNKNOWN') {
      // Advance the frontier so we don't re-evaluate this slot, but do not
      // change currentStatus — we hold the last known state.
      updateData.lastEvaluatedSlot = slot;
      updateData.lastCheckedAt = evaluatedAt;
    }
    // Late slots: only consecutiveFailures is written.

    await tx.monitor.update({ where: { id: monitorId }, data: updateData });

    // 6. Evaluate incident (only for new non-UNKNOWN slots).
    let incidentOutcome = { action: 'noop' };
    if (isNew && globalStatus !== 'UNKNOWN') {
      incidentOutcome = await evaluateIncident(
        tx, monitorId, globalStatus, consecutiveFailures, evaluatedAt,
        monitor.name, monitor.url
      );
    }

    logger.info(
      {
        monitorId,
        executionSlot: String(slot),
        globalStatus,
        regionsUp: counts.regionsUp,
        regionsDown: counts.regionsDown,
        regionsMissing: counts.regionsMissing,
        consecutiveFailures,
        isNew,
        incidentAction: incidentOutcome.action,
      },
      'Slot finalized'
    );

    return {
      monitorId,
      executionSlot: String(slot),
      globalStatus,
      consecutiveFailures,
      incident: incidentOutcome,
    };
  });
}

// ── Sweep: finalize expired-but-unevaluated older slots ──────────────────────
//
// After each result arrival, check whether any older slots for this monitor
// have expired their correlation window without being finalized.
//
async function sweepExpiredSlots(monitorId, now) {
  const windowCutoff = BigInt(now - CORRELATION_WINDOW_MS);

  // Find slots with at least one CheckResult but no SlotResult yet,
  // where the slot timestamp + correlationWindow < now.
  const unevaluated = await prisma.$queryRaw`
    SELECT DISTINCT cr.execution_slot
    FROM check_results cr
    WHERE cr.monitor_id = ${monitorId}::uuid
      AND cr.execution_slot < ${windowCutoff}
      AND NOT EXISTS (
        SELECT 1 FROM slot_results sr
        WHERE sr.monitor_id = cr.monitor_id
          AND sr.execution_slot = cr.execution_slot
      )
    ORDER BY cr.execution_slot ASC
  `;

  for (const row of unevaluated) {
    const slot = row.execution_slot;
    const quorum = await prisma.$transaction(async (tx) => {
      return evaluateSlotQuorum(tx, monitorId, slot, now);
    });

    if (quorum.decided) {
      await finalizeSlot(monitorId, slot, quorum.globalStatus, quorum, now);
    }
  }
}

// ── processResult: main entry point ──────────────────────────────────────────

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

  const slot         = BigInt(executionSlot);
  const checkedAtDate = new Date(checkedAt);
  const now          = Date.now();

  logger.debug(
    { jobId: job.id, monitorId, executionSlot, workerId, region, status },
    'Processing result'
  );

  // ── Stage A: Persist the regional CheckResult ─────────────────────────────
  await prisma.checkResult.upsert({
    where: {
      uq_check_result_slot_region: { monitorId, executionSlot: slot, region },
    },
    update: {
      jobId,
      workerId,
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

  // ── Stage B: Attempt eager quorum evaluation for this slot ────────────────
  const quorum = await prisma.$transaction(async (tx) =>
    evaluateSlotQuorum(tx, monitorId, slot, now)
  );

  if (quorum.decided) {
    await finalizeSlot(monitorId, slot, quorum.globalStatus, quorum, now);
  } else {
    logger.debug(
      {
        monitorId,
        executionSlot,
        region,
        regionsUp: quorum.regionsUp,
        regionsDown: quorum.regionsDown,
        regionsMissing: quorum.regionsMissing,
      },
      'Slot undecided — waiting for more regional results'
    );
  }

  // ── Stage C: Sweep expired unevaluated slots for this monitor ─────────────
  await sweepExpiredSlots(monitorId, now);
}

export { processResult };
