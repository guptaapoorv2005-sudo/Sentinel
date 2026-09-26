-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('DETECTED', 'CONFIRMED', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "monitor_id" UUID NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'DETECTED',
    "failure_count_at_detection" INTEGER NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_events" (
    "id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "from_status" "IncidentStatus",
    "to_status" "IncidentStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incidents_monitor_id_status_idx" ON "incidents"("monitor_id", "status");

-- CreateIndex
CREATE INDEX "incidents_monitor_id_detected_at_idx" ON "incidents"("monitor_id", "detected_at");

-- CreateIndex
CREATE INDEX "incident_events_incident_id_idx" ON "incident_events"("incident_id");

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex (partial unique)
-- Enforces: at most one non-RESOLVED incident per monitor at any time.
-- This is the primary idempotency guard for incident creation under concurrent processing.
-- Prisma does not support partial indexes declaratively, so this is added manually.
CREATE UNIQUE INDEX "uq_monitor_open_incident"
  ON "incidents" ("monitor_id")
  WHERE status != 'RESOLVED';
