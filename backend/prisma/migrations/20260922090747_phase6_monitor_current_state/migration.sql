-- CreateEnum
CREATE TYPE "MonitorStatus" AS ENUM ('UP', 'DOWN', 'UNKNOWN');

-- AlterTable
ALTER TABLE "monitors" ADD COLUMN     "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "current_status" "MonitorStatus" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "last_checked_at" TIMESTAMP(3),
ADD COLUMN     "last_evaluated_slot" BIGINT,
ADD COLUMN     "last_status_change" TIMESTAMP(3);

-- RenameIndex
ALTER INDEX "uq_check_result_slot" RENAME TO "check_results_monitor_id_execution_slot_key";
