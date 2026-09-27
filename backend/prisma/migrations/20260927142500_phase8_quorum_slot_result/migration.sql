-- Phase 8: Quorum-Based Detection
--
-- Changes:
--   1. Drop old unique constraint uq_check_result_slot (monitorId, executionSlot)
--      and replace with uq_check_result_slot_region (monitorId, executionSlot, region)
--      so each region contributes an independent observation per slot.
--   2. Add index on (monitor_id, execution_slot) for the quorum aggregator query.
--   3. Create slot_results table — the quorum-aggregated global status per slot.

-- ── 1. Replace CheckResult unique key ────────────────────────────────────────

-- Drop existing index that enforces the old (monitorId, executionSlot) uniqueness.
-- Prisma names it after the constraint name we declared.
DROP INDEX IF EXISTS "check_results_monitor_id_execution_slot_key";

-- Create new unique index including region.
CREATE UNIQUE INDEX "check_results_monitor_id_execution_slot_region_key"
  ON "check_results" ("monitor_id", "execution_slot", "region");

-- ── 2. Add index for quorum aggregator ───────────────────────────────────────

CREATE INDEX IF NOT EXISTS "check_results_monitor_id_execution_slot_idx"
  ON "check_results" ("monitor_id", "execution_slot");

-- ── 3. Create slot_results table ─────────────────────────────────────────────

CREATE TABLE "slot_results" (
  "id"              UUID        NOT NULL DEFAULT gen_random_uuid(),
  "monitor_id"      UUID        NOT NULL,
  "execution_slot"  BIGINT      NOT NULL,
  -- global_status maps to MonitorStatus enum: 'UP' | 'DOWN' | 'UNKNOWN'
  "global_status"   TEXT        NOT NULL,
  "regions_up"      INTEGER     NOT NULL,
  "regions_down"    INTEGER     NOT NULL,
  "regions_missing" INTEGER     NOT NULL,
  "evaluated_at"    TIMESTAMPTZ NOT NULL,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "slot_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "slot_results_global_status_check"
    CHECK ("global_status" IN ('UP', 'DOWN', 'UNKNOWN')),
  CONSTRAINT "uq_slot_result"
    UNIQUE ("monitor_id", "execution_slot"),
  CONSTRAINT "slot_results_monitor_id_fkey"
    FOREIGN KEY ("monitor_id")
    REFERENCES "monitors" ("id")
    ON DELETE CASCADE
);

CREATE INDEX "slot_results_monitor_id_execution_slot_idx"
  ON "slot_results" ("monitor_id", "execution_slot");
