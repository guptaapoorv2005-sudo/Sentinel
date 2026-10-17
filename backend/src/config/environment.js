import crypto from 'crypto';

const requiredVars = [
  'PORT',
  'DATABASE_URL',
  'NODE_ENV',
  'JWT_SECRET',
  'REFRESH_TOKEN_SECRET',
];

const optionalVars = {
  CORS_ORIGIN: 'http://localhost:5173',
  REDIS_URL: 'redis://localhost:6379',
};

function loadEnvironment() {
  const missing = requiredVars.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    // We use console.error here because the logger depends on config,
    // so it may not be initialized yet.
    console.error(
      `FATAL: Missing required environment variables: ${missing.join(', ')}`
    );
    process.exit(1);
  }

  return {
    port: parseInt(process.env.PORT, 10),
    databaseUrl: process.env.DATABASE_URL,
    nodeEnv: process.env.NODE_ENV,
    corsOrigin: process.env.CORS_ORIGIN || optionalVars.CORS_ORIGIN,
    redisUrl: process.env.REDIS_URL || optionalVars.REDIS_URL,
    logFormat: process.env.LOG_FORMAT || (process.env.NODE_ENV === 'development' ? 'pretty' : 'json'),

    // JWT authentication config
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: '1d', // Access token expiry (1 day)
    refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET,
    refreshTokenExpiresIn: '7d', // Refresh token expiry (7 days)
    accessTokenCookieName: 'sentinel_access_token',
    refreshTokenCookieName: 'sentinel_refresh_token',
    googleClientId: process.env.GOOGLE_CLIENT_ID, // Optional for now

    // Scheduler config
    schedulerPollIntervalMs: parseInt(process.env.SCHEDULER_POLL_INTERVAL_MS, 10) || 15000,
    checkQueueName: process.env.CHECK_QUEUE_NAME || 'sentinel.checks',
    resultQueueName: process.env.RESULT_QUEUE_NAME || 'sentinel.results',

    // Worker identity config
    // WORKER_ID: Unique identity for this worker instance. Defaults to a UUID
    // so every process is distinguishable without explicit configuration.
    // In production, set via env var to a stable name (e.g., "worker-mumbai-1").
    workerId: process.env.WORKER_ID || `worker-${crypto.randomUUID().slice(0, 8)}`,
    // WORKER_REGION: Logical location for multi-region quorum (Phase 8+).
    // Workers may physically run on the same machine — the region is data-driven.
    workerRegion: process.env.WORKER_REGION || 'default',
    // WORKER_CONCURRENCY: How many jobs this worker processes in parallel.
    workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY, 10) || 5,

    // Worker heartbeat config (Phase 5)
    // HEARTBEAT_INTERVAL_MS: How often the worker writes its heartbeat key to Redis.
    heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS, 10) || 10000,
    // HEARTBEAT_TTL_S: Redis key TTL in seconds. If the heartbeat is not refreshed
    // within this time, the worker is considered dead. Should be > heartbeatIntervalMs
    // to tolerate GC pauses, network blips, etc.
    heartbeatTtlS: parseInt(process.env.HEARTBEAT_TTL_S, 10) || 30,
    // STALLED_INTERVAL_MS: How often BullMQ checks for stalled jobs (jobs whose
    // worker disappeared mid-processing). Default 30s.
    stalledIntervalMs: parseInt(process.env.STALLED_INTERVAL_MS, 10) || 30000,
    // MAX_STALLED_COUNT: How many times a job can be stalled before it's moved
    // to failed. Default 2 (allows one retry after stall detection).
    maxStalledCount: parseInt(process.env.MAX_STALLED_COUNT, 10) || 2,

    // Incident detection thresholds (Phase 7)
    // INCIDENT_DETECTION_THRESHOLD: Consecutive global-DOWN slots required to open an incident.
    // Default 3. Phase 8+ creates incidents directly as CONFIRMED (quorum already applied).
    // Recovery: consecutiveFailures drops to 0 after a global UP slot.
    incidentDetectionThreshold: parseInt(process.env.INCIDENT_DETECTION_THRESHOLD, 10) || 3,

    // Quorum configuration (Phase 8)
    // QUORUM_REGIONS: comma-separated list of logical region names that workers run in.
    // Default 'default' = single-region mode, backward-compatible with Phase 7.
    quorumRegions: (process.env.QUORUM_REGIONS || 'default').split(',').map((s) => s.trim()),
    // QUORUM_MIN_REGIONS: number of agreeing regions required to classify a slot as UP or DOWN.
    // Default 1 = single-region mode (any one region is decisive).
    quorumMinRegions: parseInt(process.env.QUORUM_MIN_REGIONS, 10) || 1,
    // QUORUM_CORRELATION_WINDOW_MS: how long to wait for late regional results before
    // evaluating a slot with whatever data has arrived. Default 60 seconds.
    quorumCorrelationWindowMs: parseInt(process.env.QUORUM_CORRELATION_WINDOW_MS, 10) || 60000,

    // Alert dispatcher configuration (Phase 9)
    // ALERT_DISPATCHER_POLL_MS: how often the dispatcher polls outbox_events for pending work.
    alertDispatcherPollMs: parseInt(process.env.ALERT_DISPATCHER_POLL_MS, 10) || 5000,
    // ALERT_MAX_RETRIES: max delivery attempts per Alert before it is marked FAILED.
    alertMaxRetries: parseInt(process.env.ALERT_MAX_RETRIES, 10) || 5,

    // Resend email configuration (Phase 9 — email channel)
    // RESEND_API_KEY: API key from resend.com. Leave empty to disable email alerts.
    resendApiKey: process.env.RESEND_API_KEY || '',
    // RESEND_FROM: sender address shown in delivered emails.
    resendFrom: process.env.RESEND_FROM || 'Sentinel <alerts@sentinel.dev>',

    // Webhook configuration (Phase 9)
    // WEBHOOK_TIMEOUT_MS: abort a webhook POST after this many milliseconds.
    webhookTimeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS, 10) || 10000,

    // Scheduler leader election (Phase 10)
    // SCHEDULER_LEASE_TTL_MS: Redis key TTL for the leader lease. Upper bound on
    // failover time after a crash. Default 15s.
    schedulerLeaseTtlMs: parseInt(process.env.SCHEDULER_LEASE_TTL_MS, 10) || 15000,
    // SCHEDULER_LEASE_RENEW_MS: How often the leader renews the lease, and how
    // often a standby retries acquisition. Default 5s (renews 3× per TTL).
    schedulerLeaseRenewMs: parseInt(process.env.SCHEDULER_LEASE_RENEW_MS, 10) || 5000,
    // SCHEDULER_LEASE_SAFETY_MS: The local deadline fires this many ms before
    // the Redis TTL, ensuring the leader stops before the new one can start.
    schedulerLeaseSafetyMs: parseInt(process.env.SCHEDULER_LEASE_SAFETY_MS, 10) || 2000,
  };
}

const config = loadEnvironment();

export { config };
