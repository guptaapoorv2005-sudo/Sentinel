// Redis connection using ioredis.
//
// WHY IOREDIS:
// - BullMQ (used in later phases for job queues) requires ioredis.
// - ioredis has built-in reconnection with exponential backoff.
// - ioredis supports Redis Cluster, Sentinel, and pub/sub — all
//   potentially useful for Sentinel's architecture.
//
// WHY SEPARATE CLIENT:
// BullMQ creates its own Redis connections internally. This client
// is for direct Redis operations: health checks, heartbeats (Phase 5),
// pub/sub (Phase 12A), and coordination locks.
//
// RECONNECTION BEHAVIOR:
// ioredis automatically reconnects when the connection drops.
// It uses exponential backoff by default (retryStrategy).
// We don't crash if Redis is temporarily unavailable — the API can
// still serve cached data from PostgreSQL. But the /ready endpoint
// will report Redis as unhealthy.
//
// USAGE:
//   import { redis, testRedisConnection } from '../config/redis.js';
//   await redis.set('key', 'value');

import Redis from 'ioredis';
import { config } from './environment.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('redis');

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,  // Required by BullMQ — never give up on a request
  enableReadyCheck: true,      // Wait for Redis to confirm it's ready
  retryStrategy(times) {
    // Exponential backoff: 50ms, 100ms, 200ms... capped at 2 seconds
    const delay = Math.min(times * 50, 2000);
    logger.warn({ attempt: times, nextRetryMs: delay }, 'Redis connection retry');
    return delay;
  },
});

redis.on('connect', () => {
  logger.info('Redis connected');
});

redis.on('error', (err) => {
  // ioredis emits 'error' on every failed connection attempt.
  // We log it but don't crash — ioredis will keep retrying.
  logger.error({ err: err.message }, 'Redis connection error');
});

redis.on('close', () => {
  logger.warn('Redis connection closed');
});

// Test the Redis connection by sending a PING command.
// Returns true if Redis responds with PONG, throws otherwise.
async function testRedisConnection() {
  const pong = await redis.ping();
  return pong === 'PONG';
}

export { redis, testRedisConnection };
