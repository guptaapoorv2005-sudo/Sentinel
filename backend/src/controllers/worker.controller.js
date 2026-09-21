// Worker health controller — reads heartbeat keys from Redis.
//
// GET /api/v1/workers
//   Returns all workers with active heartbeat keys, including their
//   region, status, startedAt, and TTL remaining.
//
// GET /api/v1/workers/:workerId
//   Returns a specific worker's heartbeat data, or 404 if the key
//   has expired (worker is dead).
//
// NOTE: These endpoints are unauthenticated — they're operational health
// endpoints, similar to /health and /ready. In production, you'd gate
// them behind an admin role.

import { redis } from '../config/redis.js';
import { HEARTBEAT_KEY_PREFIX } from '../worker/heartbeat.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const listWorkers = asyncHandler(async (req, res) => {
  // SCAN for all heartbeat keys. SCAN is O(1) per call and cursor-based,
  // so it won't block Redis even with many keys.
  const keys = [];
  let cursor = '0';
  do {
    const [nextCursor, found] = await redis.scan(cursor, 'MATCH', `${HEARTBEAT_KEY_PREFIX}*`, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...found);
  } while (cursor !== '0');

  if (keys.length === 0) {
    return res.status(200).json(new ApiResponse(200, { workers: [] }, 'No active workers'));
  }

  // Pipeline GET + TTL for each key.
  const pipeline = redis.pipeline(); // Pipeline is used to execute multiple commands in a single request
  for (const key of keys) {   // adding GET and TTL commands to the pipeline for each key
    pipeline.get(key);
    pipeline.ttl(key);
  }
  const results = await pipeline.exec(); // Execute the pipeline and get the results, for each key in a single request

  const workers = [];
  for (let i = 0; i < keys.length; i++) {
    const value = results[i * 2][1]; // GET result
    const ttl = results[i * 2 + 1][1]; // TTL result
    if (value) {
      const data = JSON.parse(value);
      workers.push({ ...data, ttlRemainingS: ttl });
    }
  }

  res.status(200).json(new ApiResponse(200, { workers, count: workers.length }, 'Active workers'));
});

const getWorker = asyncHandler(async (req, res) => {
  const { workerId } = req.params;
  const key = `${HEARTBEAT_KEY_PREFIX}${workerId}`;

  const [value, ttl] = await Promise.all([
    redis.get(key),
    redis.ttl(key),
  ]);

  if (!value) {
    throw new ApiError(404, `Worker '${workerId}' not found or heartbeat expired`);
  }

  const data = JSON.parse(value);
  res.status(200).json(new ApiResponse(200, { ...data, ttlRemainingS: ttl }, 'Worker heartbeat'));
});

export { listWorkers, getWorker };
