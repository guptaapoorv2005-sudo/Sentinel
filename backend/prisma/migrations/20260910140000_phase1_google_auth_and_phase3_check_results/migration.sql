-- Migration: phase1_google_auth_and_phase3_check_results
--
-- This migration adds:
--   1. Google OAuth fields to users (Phase 1 additions missed in initial migration)
--   2. CheckStatus enum + check_results table (Phase 3)

-- ── Phase 1 additions ─────────────────────────────────────────────────────────

-- CreateEnum: AuthProvider
CREATE TYPE "AuthProvider" AS ENUM ('LOCAL', 'GOOGLE');

-- AlterTable: users — add Google auth and refresh token fields
ALTER TABLE "users"
  ALTER COLUMN "password_hash" DROP NOT NULL,
  ADD COLUMN "google_id"       TEXT,
  ADD COLUMN "auth_provider"   "AuthProvider" NOT NULL DEFAULT 'LOCAL',
  ADD COLUMN "refresh_token"   TEXT;

-- CreateIndex: google_id unique
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- ── Phase 3: Check Results ────────────────────────────────────────────────────

-- CreateEnum: CheckStatus
CREATE TYPE "CheckStatus" AS ENUM ('UP', 'DOWN');

-- CreateTable: check_results
CREATE TABLE "check_results" (
    "id"               UUID          NOT NULL,
    "monitor_id"       UUID          NOT NULL,
    "execution_slot"   BIGINT        NOT NULL,
    "job_id"           TEXT          NOT NULL,
    "worker_id"        TEXT          NOT NULL,
    "region"           TEXT          NOT NULL DEFAULT 'default',
    "status"           "CheckStatus" NOT NULL,
    "status_code"      INTEGER,
    "response_time_ms" INTEGER,
    "failure_type"     TEXT,
    "checked_at"       TIMESTAMP(3)  NOT NULL,
    "created_at"       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: idempotency key — one result per monitor per execution slot
CREATE UNIQUE INDEX "uq_check_result_slot" ON "check_results"("monitor_id", "execution_slot");

-- CreateIndex: efficient lookup of recent results for a monitor
CREATE INDEX "check_results_monitor_id_checked_at_idx" ON "check_results"("monitor_id", "checked_at");

-- AddForeignKey: check_results → monitors
ALTER TABLE "check_results"
  ADD CONSTRAINT "check_results_monitor_id_fkey"
  FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
