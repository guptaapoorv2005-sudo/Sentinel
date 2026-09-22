// BullMQ Worker — executes health checks and publishes results.
//
// PHASE 6 CHANGE: Workers are now fully stateless — no database connection.
//   After executeCheck(), the result is published to the result queue.
//   The result processor (src/result-processor/) owns all persistence and
//   monitor state decisions.
//
// JOB HANDLING CONTRACT:
//   - A job represents one scheduled health-check execution.
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
//     result_<monitorId>_<executionSlot>
//   BullMQ deduplicates jobs with the same ID, so if this worker processes
//   a stalled-and-recovered job, the result is only enqueued once.
//   The result processor additionally upserts on (monitorId, executionSlot).
//
// WORKER IDENTITY:
//   Each worker instance has:
//     - workerId:    Unique identifier (env WORKER_ID, defaults to random UUID prefix)
//     - region:      Logical location (env WORKER_REGION, defaults to "default")
//     - concurrency: Parallel job capacity (env WORKER_CONCURRENCY, defaults to 5)
//
//   Multiple workers can run simultaneously. BullMQ distributes jobs across
//   them automatically — no static assignment needed.

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
    // Job ID is deterministic to deduplicate at the queue level: if this
    // job was stalled and recovered, the same result ID won't be enqueued twice.
    const resultJobId = `result_${monitorId}_${executionSlot}`;
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

    logger.debug({ jobId: job.id, monitorId, resultJobId, workerId }, 'Result enqueued');

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
  const workerId = overrides.workerId ?? config.workerId;
  const region = overrides.region ?? config.workerRegion;
  const concurrency = overrides.concurrency ?? config.workerConcurrency;

  logger.info(
    { workerId, region, concurrency },
    'Creating worker'
  );

  const worker = new Worker(
    config.checkQueueName,
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
      },
      'Job failed (worker error)'
    );
  });

  worker.on('error', (err) => {
    logger.error({ err: err.message, workerId }, 'Worker connection error');
  });

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, workerId },
      'Job stalled — will be retried by another worker'
    );
  });

  return worker;
}

export { createWorker };