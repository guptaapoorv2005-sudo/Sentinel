// Alert Dispatcher — polls outbox_events and fans out alerts to channels.
//
// ── OVERVIEW ──────────────────────────────────────────────────────────────────
//
// The dispatcher is a polling loop that runs every ALERT_DISPATCHER_POLL_MS ms.
// On each tick it:
//
//   1. Claims a batch of due outbox events using SELECT ... FOR UPDATE SKIP LOCKED.
//      This is PostgreSQL's advisory row-lock mechanism — multiple dispatcher
//      instances can run safely without double-processing an event.
//
//   2. For each event, fetches all enabled AlertChannels for the event's monitor.
//
//   3. Fan-out: for each channel, creates an Alert row (idempotent on
//      outboxEventId + channelId) and calls the channel-specific delivery handler.
//
//   4. Marks each Alert DELIVERED or increments its attempt counter / schedules retry.
//
//   5. After all channels are processed, evaluates the OutboxEvent's final status:
//      - DELIVERED: all alerts were delivered
//      - PROCESSING: at least one alert is still retrying
//      - FAILED: all alerts have exhausted max retries
//
// ── RETRY BACKOFF ─────────────────────────────────────────────────────────────
//
//   nextRetryAt = now + 2^attempt * 10s (capped at 1 hour)
//
//   attempt 1 → 20s
//   attempt 2 → 40s
//   attempt 3 → 80s
//   attempt 4 → 160s
//   attempt 5 → 320s (then marked FAILED if maxAttempts = 5)
//
// ── IDEMPOTENCY ───────────────────────────────────────────────────────────────
//
//   - Alert rows are upserted on (outboxEventId, channelId): safe to re-process.
//   - DELIVERED alerts are skipped on re-run: external delivery may happen more
//     than once if the process crashes after delivery but before marking DELIVERED,
//     but this is tolerable (at-least-once semantics).
//   - For channels without RESEND_API_KEY, email alerts skip silently.
//
// ── VACUOUS DELIVERY ──────────────────────────────────────────────────────────
//
//   If a monitor has no enabled channels, the outbox event is marked DELIVERED
//   immediately — there is nothing to fan out to.

import { prisma } from '../config/database.js';
import { config } from '../config/environment.js';
import { createLogger } from '../utils/logger.js';
import { sendEmail } from './channels/email.js';
import { sendWebhook } from './channels/webhook.js';

const logger = createLogger('alert-dispatcher');

const POLL_INTERVAL_MS = config.alertDispatcherPollMs;
const MAX_RETRIES = config.alertMaxRetries;
const BATCH_SIZE = 10; // events to claim per poll tick

// ── Backoff helper ─────────────────────────────────────────────────────────────

function computeNextRetryAt(attempt) {
  const delayMs = Math.min(Math.pow(2, attempt) * 10_000, 3_600_000); // cap at 1h
  return new Date(Date.now() + delayMs);
}

// ── Channel dispatch ───────────────────────────────────────────────────────────

const channelHandlers = {
  EMAIL: sendEmail,
  WEBHOOK: sendWebhook,
};

async function deliverToChannel(outboxEventId, channel, eventType, payload) {
  // Upsert Alert row — idempotent (do nothing if already exists).
  let alert;
  try {
    alert = await prisma.alert.upsert({
      where: { uq_alert_channel: { outboxEventId, channelId: channel.id } },
      update: {},  // Already exists — leave it untouched
      create: { outboxEventId, channelId: channel.id },
    });
  } catch (err) {
    if (err.code === 'P2002') {
      alert = await prisma.alert.findUnique({
        where: { uq_alert_channel: { outboxEventId, channelId: channel.id } },
      });
    } else {
      throw err;
    }
  }

  // Already delivered — skip external call.
  if (alert.status === 'DELIVERED') {
    logger.debug(
      { outboxEventId, channelId: channel.id, channelType: channel.type },
      'Alert already delivered — skipping'
    );
    return 'delivered';
  }

  // Failed permanently — skip.
  if (alert.status === 'FAILED') {
    return 'failed';
  }

  // Check if this alert has reached max retries (could have been retried by a
  // previous dispatcher run that crashed before updating the alert status).
  if (alert.attempts >= MAX_RETRIES) {
    await prisma.alert.update({
      where: { id: alert.id },
      data: { status: 'FAILED', lastError: 'Max retries exhausted' },
    });
    return 'failed';
  }

  const handler = channelHandlers[channel.type];
  if (!handler) {
    logger.error({ channelType: channel.type }, 'Unknown channel type — skipping');
    await prisma.alert.update({
      where: { id: alert.id },
      data: { status: 'FAILED', lastError: `Unknown channel type: ${channel.type}` },
    });
    return 'failed';
  }

  try {
    await handler(channel.config, eventType, payload);

    // Delivery succeeded.
    await prisma.alert.update({
      where: { id: alert.id },
      data: {
        status: 'DELIVERED',
        deliveredAt: new Date(),
        attempts: alert.attempts + 1,
        lastError: null,
      },
    });

    logger.info(
      { outboxEventId, channelId: channel.id, channelType: channel.type },
      'Alert delivered'
    );
    return 'delivered';
  } catch (err) {
    const newAttempts = alert.attempts + 1;
    const exhausted = newAttempts >= MAX_RETRIES;

    await prisma.alert.update({
      where: { id: alert.id },
      data: {
        status: exhausted ? 'FAILED' : 'PENDING',
        attempts: newAttempts,
        lastError: err.message,
      },
    });

    logger.warn(
      {
        outboxEventId, channelId: channel.id, channelType: channel.type,
        attempt: newAttempts, maxRetries: MAX_RETRIES, err: err.message
      },
      exhausted ? 'Alert permanently failed' : 'Alert delivery failed — will retry'
    );
    return exhausted ? 'failed' : 'retrying';
  }
}

// ── Process one outbox event ───────────────────────────────────────────────────

async function processOutboxEvent(event) {
  const { id: outboxEventId, type: eventType, payload } = event;
  const monitorId = payload.monitorId;

  logger.debug({ outboxEventId, eventType, monitorId }, 'Processing outbox event');

  // Fetch enabled channels for this monitor.
  const channels = await prisma.alertChannel.findMany({
    where: { monitorId, enabled: true },
  });

  if (channels.length === 0) {
    // Vacuous delivery — no channels configured.
    await prisma.outboxEvent.update({
      where: { id: outboxEventId },
      data: { status: 'DELIVERED', processedAt: new Date() },
    });
    logger.debug({ outboxEventId, monitorId }, 'No channels configured — event vacuously delivered');
    return;
  }

  // Fan-out: deliver to each channel independently.
  const outcomes = await Promise.allSettled(
    channels.map((channel) =>
      deliverToChannel(outboxEventId, channel, eventType, payload)
    )
  );

  const results = outcomes.map((o) => (o.status === 'fulfilled' ? o.value : 'failed'));
  const allDelivered = results.every((r) => r === 'delivered');
  const anyRetrying = results.some((r) => r === 'retrying');
  const allFailed = results.every((r) => r === 'failed');

  if (allDelivered) {
    await prisma.outboxEvent.update({
      where: { id: outboxEventId },
      data: { status: 'DELIVERED', processedAt: new Date(), attempts: event.attempts + 1 },
    });
    logger.info({ outboxEventId, eventType, monitorId }, 'Outbox event fully delivered');
  } else if (allFailed) {
    await prisma.outboxEvent.update({
      where: { id: outboxEventId },
      data: {
        status: 'FAILED',
        attempts: event.attempts + 1,
        lastError: 'All channels failed after max retries',
      },
    });
    logger.error({ outboxEventId, eventType, monitorId }, 'Outbox event permanently failed');
  } else if (anyRetrying) {
    // Some channels still have retries left — schedule the event for re-evaluation.
    const nextRetryAt = computeNextRetryAt(event.attempts + 1);
    await prisma.outboxEvent.update({
      where: { id: outboxEventId },
      data: {
        status: 'PROCESSING',
        attempts: event.attempts + 1,
        nextRetryAt,
      },
    });
    logger.debug({ outboxEventId, nextRetryAt }, 'Outbox event scheduled for retry');
  }
}

// ── Poll tick ─────────────────────────────────────────────────────────────────

async function pollOutbox() {
  // ATOMIC CLAIM WITH SKIP LOCKED:
  // Using UPDATE ... WHERE id IN (SELECT id ... FOR UPDATE SKIP LOCKED) RETURNING ...
  // This guarantees that in PostgreSQL, the row is locked and immediately claimed
  // in a single atomic statement, so concurrent workers skip already-claimed rows
  // without double-processing.
  const events = await prisma.$queryRaw`
    UPDATE outbox_events
    SET status = 'PROCESSING'
    WHERE id IN (
      SELECT id
      FROM outbox_events
      WHERE status IN ('PENDING', 'PROCESSING')
        AND (next_retry_at IS NULL OR next_retry_at <= now())
      ORDER BY created_at ASC
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, type, aggregate_type, aggregate_id, payload, status, attempts, max_attempts
  `;

  if (events.length === 0) return;

  logger.debug({ count: events.length }, 'Outbox poll: events claimed');

  // Process events sequentially to avoid overwhelming external providers.
  // If we need higher throughput, this can become concurrent with a semaphore.
  for (const row of events) {
    // Map snake_case SQL result back to the shape our code expects.
    const event = {
      id: row.id,
      type: row.type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    };

    try {
      await processOutboxEvent(event);
    } catch (err) {
      logger.error({ outboxEventId: event.id, err: err.message }, 'Unexpected error processing outbox event');
    }
  }
}

// ── Main dispatcher loop ───────────────────────────────────────────────────────

let running = false;
let pollTimer = null;

async function start() {
  if (running) return;
  running = true;
  logger.info({ pollIntervalMs: POLL_INTERVAL_MS, maxRetries: MAX_RETRIES }, 'Alert dispatcher started');

  async function tick() {
    if (!running) return;
    try {
      await pollOutbox();
    } catch (err) {
      logger.error({ err: err.message }, 'Outbox poll error');
    } finally {
      if (running) {
        pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
  }

  // Kick off immediately, then repeat on the configured interval.
  tick();
}

async function stop() {
  running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  logger.info('Alert dispatcher stopped');
}

export { start, stop, pollOutbox };
