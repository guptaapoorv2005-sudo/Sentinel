// BullMQ Worker — consumes check jobs and persists results.
//
// JOB HANDLING CONTRACT:
//   - A job represents one scheduled health-check execution.
//   - The handler calls executeCheck(), which NEVER throws.
//   - All check-level failures (timeout, DNS, wrong status) are classified
//     and persisted as DOWN results. The job then succeeds from BullMQ's
//     perspective (acknowledged, not retried).
//   - Only unexpected worker errors (DB failure, uncaught exception) propagate
//     as thrown errors. BullMQ retries those according to the queue's retry
//     policy (3 attempts, exponential backoff).
//
// WHY THIS DISTINCTION MATTERS:
//   A timeout is a valid health observation — "the service did not respond
//   in time." It is not a problem with the worker itself. If BullMQ retried
//   on every timeout, a slow target would exhaust retry attempts immediately,
//   hiding the real failure reason and wasting queue resources.
//
// IDEMPOTENCY:
//   Results are persisted with upsert keyed on (monitorId, executionSlot).
//   If a job is processed twice (at-least-once delivery), the second write
//   updates the existing row rather than creating a duplicate.
//
// WORKER IDENTITY:
//   Each worker instance has:
//     - workerId:    Unique identifier (env WORKER_ID, defaults to random UUID prefix)
//     - region:      Logical location (env WORKER_REGION, defaults to "default")
//     - concurrency: Parallel job capacity (env WORKER_CONCURRENCY, defaults to 5)
//
//   Multiple workers can run simultaneously. BullMQ distributes jobs across
//   them automatically — no static assignment needed. Each persisted
//   CheckResult records which worker+region produced it, enabling
//   multi-region quorum analysis in later phases.

import { Worker } from 'bullmq';
import { prisma } from '../config/database.js';
import { redisConnection } from '../config/queue.js';
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

    // --- Step 2: Persist the result ---
    // Upsert keyed on (monitorId, executionSlot) for idempotency.
    // If this job was already processed (e.g., BullMQ retry after a transient
    // DB blip), the upsert updates rather than duplicates.
    //
    // NOTE: BigInt serialization — executionSlot arrives as a number in the
    // job payload (JSON), but Prisma expects BigInt for the schema field.
    await prisma.checkResult.upsert({
      where: {
        uq_check_result_slot: {
          monitorId,
          executionSlot: BigInt(executionSlot),
        },
      },
      update: {
        jobId: job.id,
        workerId,
        region,
        status: checkResult.status,
        statusCode: checkResult.statusCode,
        responseTimeMs: checkResult.responseTimeMs,
        failureType: checkResult.failureType,
        checkedAt: new Date(),
      },
      create: {
        monitorId,
        executionSlot: BigInt(executionSlot),
        jobId: job.id,
        workerId,
        region,
        status: checkResult.status,
        statusCode: checkResult.statusCode,
        responseTimeMs: checkResult.responseTimeMs,
        failureType: checkResult.failureType,
        checkedAt: new Date(),
      },
    });

    logger.debug({ jobId: job.id, monitorId, workerId }, 'Check result persisted');

    // Return value is stored as the job's return data in BullMQ.
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
      // stalledInterval: How often BullMQ checks for stalled jobs (ms).
      //   A job is "stalled" when its worker disappears without acknowledging it.
      // maxStalledCount: How many times a job can be detected as stalled before
      //   it's moved to "failed". Set to 2 to allow one recovery attempt.
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