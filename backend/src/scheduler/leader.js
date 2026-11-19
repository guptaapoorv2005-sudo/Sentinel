// Leader Election — Redis-based lease for scheduler coordination.
//
// DESIGN GOAL:
//   At most one scheduler instance (the "leader") actively creates BullMQ jobs.
//   All others stay in STANDBY, saving DB queries and Redis writes.
//
// CORRECTNESS NOTE:
//   The lease is NOT a strict mutual exclusion lock. GC pauses, network
//   partitions, or clock drift can briefly leave two instances believing they
//   are the leader. Correctness is maintained by the deterministic jobId scheme
//   (check:{monitorId}:{slot}:{region}), which causes BullMQ to silently reject
//   duplicate enqueues. The lease is a performance optimization, not a safety
//   guarantee.
//
// REDIS KEYS:
//   scheduler:leader          → instanceId   (PX ttlMs — the lease itself)
//   scheduler:leader:epoch    → integer       (INCR on every new acquisition)
//   scheduler:leader:info     → JSON          (human-readable state; same TTL)
//
// STATE MACHINE:
//   STANDBY → LEADER  on successful acquire
//   LEADER  → LEADER  on successful renew
//   LEADER  → STANDBY on renew failure or local deadline exceeded
//   LEADER  → *       on graceful shutdown via release()
//
// LOCAL SAFETY DEADLINE:
//   After every acquire/renew we set:
//     leaseValidUntil = performance.now() + ttlMs - safetyMarginMs
//   isLeader() returns true only while within this deadline.
//   This means if Redis becomes unreachable the instance steps down *before*
//   the Redis TTL expires, ensuring the new leader can start safely.

import Redis from 'ioredis';
import { performance } from 'perf_hooks';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('leader');

// Lua script: renew the lease only if we still own it.
// Returns 1 on success, 0 if the key is gone or owned by someone else.
const RENEW_SCRIPT = `
  local current = redis.call('GET', KEYS[1])
  if current == ARGV[1] then
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return 1
  else
    return 0
  end
`;

// Lua script: release the lease only if we still own it.
// Returns 1 if deleted, 0 if the key is gone or owned by someone else.
const RELEASE_SCRIPT = `
  local current = redis.call('GET', KEYS[1])
  if current == ARGV[1] then
    redis.call('DEL', KEYS[1])
    return 1
  else
    return 0
  end
`;

/**
 * Create a leader elector for the scheduler.
 *
 * @param {object} opts
 * @param {string}  opts.instanceId       - Unique ID for this scheduler instance.
 * @param {string}  opts.keyPrefix        - Redis key prefix (default: 'scheduler:leader').
 * @param {number}  opts.ttlMs            - Lease TTL in ms (default: 15000).
 * @param {number}  opts.renewIntervalMs  - How often to renew / retry acquiring (default: 5000).
 * @param {number}  opts.safetyMarginMs   - Local deadline fires this long before Redis TTL (default: 2000).
 * @param {string}  opts.redisUrl         - ioredis connection URL.
 * @param {object}  [opts.redisClient]    - Inject a pre-built ioredis client (for tests).
 */
function createLeaderElector({
  instanceId,
  keyPrefix = 'scheduler:leader',
  ttlMs = 15000,
  renewIntervalMs = 5000,
  safetyMarginMs = 2000,
  redisUrl,
  redisClient,
}) {
  // Redis key names
  const leaseKey  = keyPrefix;
  const epochKey  = `${keyPrefix}:epoch`;
  const infoKey   = `${keyPrefix}:info`;

  let state = 'STANDBY';  // 'STANDBY' | 'LEADER'
  let leaseValidUntil = 0;  // performance.now() deadline
  let epoch = 0;
  let acquiredAt = null;
  let timer = null;

  let redis = redisClient ?? new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  if (!redisClient) {
    redis.on('error', (err) => {
      /* logger.warn({ err: err.message }, 'Leader elector Redis error') */;
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function updateLocalDeadline() {
    leaseValidUntil = performance.now() + ttlMs - safetyMarginMs;
  }

  async function writeInfo() {
    const info = JSON.stringify({
      instanceId,
      epoch,
      acquiredAt,
      renewedAt: new Date().toISOString(),
    });
    await redis.set(infoKey, info, 'PX', ttlMs).catch(() => {});
  }

  // ── Acquire ──────────────────────────────────────────────────────────────────

  async function tryAcquire() {
    // SET NX PX — atomic: only sets if key does not exist.
    const result = await redis.set(leaseKey, instanceId, 'NX', 'PX', ttlMs);
    if (result !== 'OK') return false;

    // Won the lease — increment the epoch fencing token.
    epoch = await redis.incr(epochKey);
    acquiredAt = new Date().toISOString();
    state = 'LEADER';
    updateLocalDeadline();
    await writeInfo();

    /* logger.info({ instanceId, epoch, keyPrefix }, 'Became leader') */;
    return true;
  }

  // ── Renew ────────────────────────────────────────────────────────────────────

  async function tryRenew() {
    const result = await redis.eval(RENEW_SCRIPT, 1, leaseKey, instanceId, String(ttlMs));
    if (result === 1) {
      updateLocalDeadline();
      await writeInfo();
      /* logger.debug({ instanceId, epoch, leaseValidUntil }, 'Lease renewed') */;
      return true;
    }
    return false;
  }

  // ── Poll loop ─────────────────────────────────────────────────────────────────
  //
  // Runs on renewIntervalMs. When LEADER: tries to renew. When STANDBY: tries
  // to acquire. On renew failure or local deadline, transitions to STANDBY.

  async function poll() {
    if (state === 'LEADER') {
      // First check the local deadline — handles Redis-unreachable scenario.
      if (performance.now() >= leaseValidUntil) {
        /* logger.warn({ instanceId, epoch }, 'Local lease deadline passed — stepping down') */;
        state = 'STANDBY';
        /* logger.info({ instanceId }, 'Lost leadership (local deadline)') */;
        return;
      }

      try {
        const renewed = await tryRenew();
        if (!renewed) {
          state = 'STANDBY';
          /* logger.info({ instanceId, epoch }, 'Lost leadership (lease stolen or expired)') */;
        }
      } catch (err) {
        /* logger.warn({ err: err.message, instanceId }, 'Renew threw — checking local deadline') */;
        // Don't step down immediately on a transient error; the local deadline
        // will force a step-down if renewals keep failing.
      }
    } else {
      // STANDBY — try to take the lease.
      try {
        await tryAcquire();
      } catch (err) {
        /* logger.debug({ err: err.message, instanceId }, 'Acquire attempt failed') */;
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Start the elector. Immediately tries to acquire, then polls on interval.
   */
  async function start() {
    /* logger.info({ instanceId, keyPrefix, ttlMs, renewIntervalMs }, 'Leader elector starting') */;
    try {
      await tryAcquire();
    } catch (err) {
      /* logger.debug({ err: err.message }, 'Initial acquire attempt failed') */;
    }
    timer = setInterval(() => {
      poll().catch((err) => {
        logger.error({ err: err.message }, 'Leader poll error');
      });
    }, renewIntervalMs);
  }

  /**
   * Returns true only if this instance is the current leader AND the local
   * safety deadline has not passed. Always check this before doing leader work.
   */
  function isLeader() {
    return state === 'LEADER' && performance.now() < leaseValidUntil;
  }

  /**
   * Returns the current epoch (fencing token). Monotonically increasing per
   * cluster; a higher epoch means a newer leader generation.
   */
  function getEpoch() {
    return epoch;
  }

  /**
   * Gracefully release the lease and stop the poll loop.
   * On graceful shutdown, standby instances can acquire almost immediately
   * (within one poll interval) rather than waiting for TTL expiry.
   */
  async function release() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    if (state !== 'LEADER') {
      /* logger.info({ instanceId }, 'Elector stopped (was standby)') */;
      return;
    }

    try {
      const result = await redis.eval(RELEASE_SCRIPT, 1, leaseKey, instanceId);
      if (result === 1) {
        // Also clean up the info key so getLeaderInfo() returns null immediately.
        await redis.del(infoKey).catch(() => {});
        /* logger.info({ instanceId, epoch }, 'Released leadership (graceful shutdown)') */;
      } else {
        /* logger.warn({ instanceId, epoch }, 'Release returned 0 — lease was already taken by another instance') */;
      }
    } catch (err) {
      logger.error({ err: err.message, instanceId }, 'Failed to release lease');
    } finally {
      state = 'STANDBY';
    }
  }

  /**
   * Read the leader info key from Redis. Useful for the status API endpoint.
   * Returns null if there is no current leader.
   */
  async function getLeaderInfo() {
    const [infoRaw, pttl] = await Promise.all([
      redis.get(infoKey),
      redis.pttl(leaseKey),
    ]);

    if (!infoRaw) return null;

    try {
      const info = JSON.parse(infoRaw);
      return { ...info, ttlRemainingMs: pttl > 0 ? pttl : 0 };
    } catch {
      return null;
    }
  }

  /**
   * Disconnect the ioredis client managed by this elector.
   * Only call after release() and only if no external redisClient was injected.
   */
  async function disconnect() {
    if (!redisClient) {
      await redis.quit().catch(() => {});
    }
  }

  return { start, isLeader, getEpoch, release, getLeaderInfo, disconnect };
}

export { createLeaderElector };
