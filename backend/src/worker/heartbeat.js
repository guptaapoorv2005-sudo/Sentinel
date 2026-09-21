// Worker Heartbeat — Redis SET EX loop.
//
// Each worker periodically writes a Redis key:
//
//   worker:heartbeat:<workerId>
//
// with a JSON payload and a TTL. If the worker crashes, the key expires
// and downstream observers (API, dashboards) know the worker is dead.
//
// WHY REDIS INSTEAD OF A DB TABLE:
//   Heartbeats are high-frequency, low-latency writes. Redis SET EX is
//   O(1) and the TTL-based expiry means no cleanup logic is needed.
//   A Postgres row would require periodic DELETE sweeps and adds latency.
//
// KEY NAMING:
//   worker:heartbeat:<workerId>
//   e.g., worker:heartbeat:worker-mumbai-1
//
// VALUE:
//   JSON with metadata: { workerId, region, startedAt, lastBeatAt, status }
//
// LIFECYCLE:
//   1. start()  — called when the worker boots. Writes the first beat
//                  and starts the interval loop.
//   2. stop()   — called on graceful shutdown. Clears the interval and
//                  deletes the key (so the worker disappears immediately
//                  rather than waiting for TTL expiry).

import Redis from 'ioredis';
import { config } from '../config/environment.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('heartbeat');

const HEARTBEAT_KEY_PREFIX = 'worker:heartbeat:';

function createHeartbeat({ workerId, region, intervalMs, ttlS }) {
  const interval = intervalMs ?? config.heartbeatIntervalMs;
  const ttl = ttlS ?? config.heartbeatTtlS;
  const key = `${HEARTBEAT_KEY_PREFIX}${workerId}`;
  const startedAt = new Date().toISOString();

  let timer = null;
  let redis = null;

  function getRedis() {
    if (!redis) {
      redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
      redis.on('error', (err) => {
        logger.error({ err: err.message, workerId }, 'Heartbeat Redis error');
      });
    }
    return redis;
  }

  async function beat() {
    const payload = JSON.stringify({
      workerId,
      region,
      startedAt,
      lastBeatAt: new Date().toISOString(),
      status: 'healthy',
    });

    try {
      await getRedis().set(key, payload, 'EX', ttl);
      logger.debug({ workerId, key, ttlS: ttl }, 'Heartbeat written');
    } catch (err) {
      // Non-fatal — the beat will retry on the next interval.
      // If Redis is truly down, BullMQ will also fail and the worker
      // will stop processing jobs anyway.
      logger.warn({ err: err.message, workerId }, 'Failed to write heartbeat');
    }
  }

  function start() {
    logger.info(
      { workerId, region, intervalMs: interval, ttlS: ttl, key },
      'Heartbeat started'
    );
    // Write immediately, then on interval.
    beat();
    timer = setInterval(beat, interval);
  }

  async function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    try {
      // Delete the key so the worker disappears immediately on graceful shutdown
      // rather than waiting for TTL expiry.
      await getRedis().del(key);
      logger.info({ workerId, key }, 'Heartbeat key deleted (graceful shutdown)');
    } catch (err) {
      logger.warn({ err: err.message, workerId }, 'Failed to delete heartbeat key');
    }

    try {
      await redis?.quit();
      redis = null;
    } catch {}
  }

  return { start, stop, getKey: () => key };
}

export { createHeartbeat, HEARTBEAT_KEY_PREFIX };
