// BullMQ queue configuration for Sentinel.
//
// WHY A SHARED QUEUE CONFIG:
// Both the scheduler (producer) and workers (consumers, Phase 3) need
// access to the same BullMQ queue. Centralizing the queue name and
// connection here avoids duplication and ensures consistency.
//
// WHY `maxRetriesPerRequest: null`:
// BullMQ requires this setting on the ioredis connection. Without it,
// ioredis will throw after a fixed number of retries, which conflicts
// with BullMQ's own retry/reconnection logic.
//
// CONNECTION:
// BullMQ creates its own ioredis connection internally. We parse the
// REDIS_URL into host/port because BullMQ's connection option expects
// ioredis-compatible options (host, port), not a URL string.
//
// USAGE:
//   import { checkQueue } from '../config/queue.js';
//   await checkQueue.add('check', payload, { jobId: '...' });

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

const checkQueue = new Queue(config.checkQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    // Keep completed jobs in Redis long enough to prevent the scheduler
    // from re-enqueuing a job for the same execution slot. The age is
    // set per-job in the scheduler based on the monitor's interval.
    // This default is a safety net.
    removeOnComplete: { age: 3600 },  // 1 hour default
    removeOnFail: { age: 86400 },     // Keep failed jobs for 24h for debugging
  },
});

checkQueue.on('error', (err) => {
  logger.error({ err: err.message }, 'BullMQ check queue error');
});

// Result queue: carries normalized check results from workers to the result processor.
//
// WHY A SEPARATE QUEUE:
//   Workers are stateless — they execute checks and publish results.
//   The result processor owns persistence and state decisions.
//   Decoupling via queue lets each side scale and restart independently.
//
// RETRY POLICY:
//   Result jobs should retry on processor failure (DB down, transient error).
//   The processor is idempotent (upsert on monitorId+executionSlot), so
//   retrying is always safe.
const resultQueue = new Queue(config.resultQueueName, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
  },
});

resultQueue.on('error', (err) => {
  logger.error({ err: err.message }, 'BullMQ result queue error');
});

export { checkQueue, resultQueue, redisConnection };
