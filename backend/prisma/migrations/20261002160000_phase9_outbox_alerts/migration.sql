-- Phase 9: Transactional Outbox + Alert Channels
--
-- Changes:
--   1. Create outbox_events table — written atomically with incident state changes.
--   2. Create alert_channels table — per-monitor channel configuration (email, webhook).
--   3. Create alerts table — per-channel delivery records, idempotency key (event, channel).

-- ── 1. outbox_events ─────────────────────────────────────────────────────────

CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED');

CREATE TABLE "outbox_events" (
  "id"             UUID          NOT NULL DEFAULT gen_random_uuid(),
  "type"           TEXT          NOT NULL,             -- e.g. 'INCIDENT_CONFIRMED'
  "aggregate_type" TEXT          NOT NULL,             -- e.g. 'Incident'
  "aggregate_id"   UUID          NOT NULL,
  "payload"        JSONB         NOT NULL,
  "status"         "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts"       INTEGER       NOT NULL DEFAULT 0,
  "max_attempts"   INTEGER       NOT NULL DEFAULT 5,
  "last_error"     TEXT,
  "next_retry_at"  TIMESTAMPTZ,
  "processed_at"   TIMESTAMPTZ,
  "created_at"     TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- Dispatcher poll query: PENDING/PROCESSING events due for pickup.
CREATE INDEX "outbox_events_status_next_retry_at_idx"
  ON "outbox_events" ("status", "next_retry_at");

-- ── 2. alert_channels ────────────────────────────────────────────────────────

CREATE TYPE "AlertChannelType" AS ENUM ('EMAIL', 'WEBHOOK');

CREATE TABLE "alert_channels" (
  "id"         UUID               NOT NULL DEFAULT gen_random_uuid(),
  "monitor_id" UUID               NOT NULL,
  "type"       "AlertChannelType" NOT NULL,
  "config"     JSONB              NOT NULL,  -- { to } for EMAIL; { url, secret? } for WEBHOOK
  "enabled"    BOOLEAN            NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ        NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ        NOT NULL DEFAULT now(),

  CONSTRAINT "alert_channels_pkey" PRIMARY KEY ("id"),
  -- One channel per type per monitor.
  CONSTRAINT "uq_monitor_channel_type" UNIQUE ("monitor_id", "type"),
  CONSTRAINT "alert_channels_monitor_id_fkey"
    FOREIGN KEY ("monitor_id")
    REFERENCES "monitors" ("id")
    ON DELETE CASCADE
);

-- ── 3. alerts ────────────────────────────────────────────────────────────────

CREATE TYPE "AlertStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

CREATE TABLE "alerts" (
  "id"              UUID          NOT NULL DEFAULT gen_random_uuid(),
  "outbox_event_id" UUID          NOT NULL,
  "channel_id"      UUID          NOT NULL,
  "status"          "AlertStatus" NOT NULL DEFAULT 'PENDING',
  "attempts"        INTEGER       NOT NULL DEFAULT 0,
  "last_error"      TEXT,
  "delivered_at"    TIMESTAMPTZ,
  "created_at"      TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT "alerts_pkey" PRIMARY KEY ("id"),
  -- Idempotency: one delivery record per (event, channel).
  CONSTRAINT "uq_alert_channel" UNIQUE ("outbox_event_id", "channel_id"),
  CONSTRAINT "alerts_outbox_event_id_fkey"
    FOREIGN KEY ("outbox_event_id")
    REFERENCES "outbox_events" ("id")
    ON DELETE CASCADE,
  CONSTRAINT "alerts_channel_id_fkey"
    FOREIGN KEY ("channel_id")
    REFERENCES "alert_channels" ("id")
    ON DELETE CASCADE
);

CREATE INDEX "alerts_status_idx" ON "alerts" ("status");
