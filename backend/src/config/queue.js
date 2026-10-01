// BullMQ queue configuration for Sentinel.
//
// Phase 8 change: the single checkQueue is replaced by a per-region queue
// factory (getCheckQueue). Each region has its own named BullMQ queue:
//   sentinel.checks.mumbai
//   sentinel.checks.singapore
//   sentinel.checks.frankfurt
//
// Workers consume exclusively from their own region's queue, giving clean
// isolation — a slow region cannot block another region's jobs.
//
// The result queue remains a single shared queue: all regions publish to
// sentinel.results and a single result processor consumes from it.
//
// WHY `maxRetriesPerRequest: null`:
// BullMQ requires this setting on the ioredis connection. Without it,
// ioredis will throw after a fixed number of retries, which conflicts
// with BullMQ's own retry/reconnection logic.

import { Queue } from 'bullmq';
import { config } from './environment.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('queue');

// Parse Redis URL into host/port for BullMQ's ioredis connection.
function parseRedisUrl(url) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || 'localhost',
    port: parseInt(parsed.port, 10) || 6379,
    ...(parsed.password && { password: parsed.password }),
    ...(parsed.username && parsed.username !== 'default' && { username: parsed.username }),
  };
}

const redisConnection = {
  ...parseRedisUrl(config.redisUrl),
  maxRetriesPerRequest: null,
};

// ── Per-region check queues ───────────────────────────────────────────────────
//
// One queue per logical region. Workers consume exclusively from their
// region's queue. The scheduler enqueues into each region's queue separately.
//
// The map is populated lazily — a Queue instance is only created the first
// time a region is referenced. This keeps startup cheap when not all regions
// are active.
const checkQueueCache = new Map();

/**
 * Return (creating if necessary) the BullMQ Queue for a given region.
 * Queue name: `${checkQueueName}.${region}` (e.g. sentinel.checks.mumbai)
 */
function getCheckQueue(region) {
  if (!checkQueueCache.has(region)) {
    const queueName = `${config.checkQueueName}.${region}`;
    const queue = new Queue(queueName, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        // Keep completed jobs in Redis for at least one interval so the
        // scheduler won't re-enqueue within the same slot. Age is set
        // per-job in the scheduler. This is a safety-net default.
        removeOnComplete: { age: 3600 },   // 1 hour
        removeOnFail:    { age: 86400 },   // 24 hours — kept for debugging
      },
    });

    queue.on('error', (err) => {
      logger.error({ err: err.message, region, queueName }, 'BullMQ check queue error');
    });

    checkQueueCache.set(region, queue);
    logger.debug({ region, queueName }, 'Check queue created');
  }
  return checkQueueCache.get(region);
}

// Pre-warm a queue for every configured region so startup errors surface
// immediately rather than at first use.
for (const region of config.quorumRegions) {
  getCheckQueue(region);
}

// ── Result queue ──────────────────────────────────────────────────────────────
//
// Single shared queue. All regional workers publish normalized results here.
// The result processor consumes from it and owns all persistence and
// state-machine decisions.
//
// RETRY POLICY:
//   Result jobs should retry on processor failure (DB down, transient error).
//   The processor is idempotent (upsert on monitorId+executionSlot+region),
//   so retrying is always safe.
const resultQueue = new Queue(config.resultQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: { age: 3600 },
    removeOnFail:    { age: 86400 },
  },
});

resultQueue.on('error', (err) => {
  logger.error({ err: err.message }, 'BullMQ result queue error');
});

export { getCheckQueue, checkQueueCache, resultQueue, redisConnection };
