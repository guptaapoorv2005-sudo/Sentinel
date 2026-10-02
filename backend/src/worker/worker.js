// BullMQ Worker — executes health checks and publishes results.
//
// Phase 8 change: the worker now consumes from its region's dedicated queue
//   `sentinel.checks.<region>` instead of the global sentinel.checks queue.
//
// Each worker process is assigned a region via WORKER_REGION. The scheduler
// enqueues one job per region per slot, so each worker independently observes
// the same target from its logical location.
//
// JOB HANDLING CONTRACT:
//   - A job represents one scheduled health-check execution for one region.
//   - The handler calls executeCheck(), which NEVER throws.
//   - All check-level failures (timeout, DNS, wrong status) are classified
//     and published as DOWN results. The job succeeds from BullMQ's
//     perspective (acknowledged, not retried).
//   - Only unexpected worker errors (queue failure, uncaught exception)
//     propagate as thrown errors. BullMQ retries those (3 attempts,
//     exponential backoff).
//
// WHY THIS DISTINCTION MATTERS:
//   A timeout is a valid health observation — "the service did not respond
//   in time." It is not a problem with the worker itself. If BullMQ retried
//   on every timeout, a slow target would exhaust retry attempts immediately,
//   hiding the real failure reason and wasting queue resources.
//
// IDEMPOTENCY:
//   The result job is enqueued with a deterministic ID:
//     result_<monitorId>_<executionSlot>_<region>
//   If this job was stalled and recovered, the result is only enqueued once.
//   The result processor additionally upserts on (monitorId, executionSlot, region).
//
// WORKER IDENTITY:
//   Each worker instance has:
//     - workerId:    Unique identifier (env WORKER_ID, defaults to random UUID prefix)
//     - region:      Logical location (env WORKER_REGION, defaults to "default")
//     - concurrency: Parallel job capacity (env WORKER_CONCURRENCY, defaults to 5)

import { Worker } from 'bullmq';
import { redisConnection, resultQueue } from '../config/queue.js';
import { executeCheck } from './checker.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../config/environment.js';

const logger = createLogger('worker');

/**
 * Create the job handler closure.
 * Captures workerId and region so they're available to every job
 * without being passed through BullMQ's job data.
 */
function createJobHandler(workerId, region) {
  return async function processJob(job) {
    const { monitorId, url, method, expectedStatus, timeout, executionSlot } = job.data;

    logger.debug(
      { jobId: job.id, monitorId, url, workerId, region },
      'Processing check job'
    );

    // --- Step 1: Execute the HTTP check ---
    // executeCheck() never throws — it always returns a normalized result.
    const checkResult = await executeCheck({ url, method, timeout, expectedStatus });

    logger.info(
      {
        jobId: job.id,
        monitorId,
        url,
        workerId,
        region,
        status: checkResult.status,
        statusCode: checkResult.statusCode,
        responseTimeMs: checkResult.responseTimeMs,
        failureType: checkResult.failureType,
      },
      'Check complete'
    );

    // --- Step 2: Publish result to the result queue ---
    // The result processor owns all persistence and state decisions.
    // Job ID is deterministic to deduplicate at the queue level: region is
    // included so that multiple regions don't collide on the same jobId.
    const resultJobId = `result_${monitorId}_${executionSlot}_${region}`;
    await resultQueue.add(
      'result',
      {
        jobId: job.id,
        monitorId,
        executionSlot, // number (JSON-safe); processor converts to BigInt
        workerId,
        region,
        status: checkResult.status,
        statusCode: checkResult.statusCode,
        responseTimeMs: checkResult.responseTimeMs,
        failureType: checkResult.failureType,
        checkedAt: new Date().toISOString(),
      },
      { jobId: resultJobId }
    );

    logger.debug({ jobId: job.id, monitorId, resultJobId, workerId, region }, 'Result enqueued');

    return {
      status: checkResult.status,
      statusCode: checkResult.statusCode,
      responseTimeMs: checkResult.responseTimeMs,
      failureType: checkResult.failureType,
      workerId,
      region,
    };
  };
}

function createWorker(overrides = {}) {
  const workerId  = overrides.workerId  ?? config.workerId;
  const region    = overrides.region    ?? config.workerRegion;
  const concurrency = overrides.concurrency ?? config.workerConcurrency;

  // Phase 8: consume from the region-specific check queue.
  const queueName = `${config.checkQueueName}.${region}`;

  logger.info(
    { workerId, region, queueName, concurrency },
    'Creating worker'
  );

  const worker = new Worker(
    queueName,
    createJobHandler(workerId, region),
    {
      connection: redisConnection,
      concurrency,
      stalledInterval: config.stalledIntervalMs,
      maxStalledCount: config.maxStalledCount,
    }
  );

  worker.on('completed', (job, result) => {
    logger.info(
      {
        jobId: job.id,
        monitorId: job.data.monitorId,
        status: result.status,
        workerId: result.workerId,
        region: result.region,
      },
      'Job completed'
    );
  });

  worker.on('failed', (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        monitorId: job?.data?.monitorId,
        err: err.message,
        attempts: job?.attemptsMade,
        workerId,
        region,
      },
      'Job failed (worker error)'
    );
  });

  worker.on('error', (err) => {
    logger.error({ err: err.message, workerId, region }, 'Worker connection error');
  });

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, workerId, region },
      'Job stalled — will be retried by another worker'
    );
  });

  return worker;
}

export { createWorker };